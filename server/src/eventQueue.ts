import type { EventQueueConfig } from './config';
import type { Logger } from './logger';
import type { Repo } from './repo/types';
import type { MotionEvent } from './types';
import { errorMessage, raceTimeout } from './util';

export type BatchOutcome = 'written' | 'dropped';

export class QueueFullError extends Error {
  constructor(depth: number, max: number) {
    super(`event queue is full (${depth}/${max} events buffered)`);
    this.name = 'QueueFullError';
  }
}

interface Batch {
  events: MotionEvent[];
  sessionIds: Set<string>;
  done: Promise<BatchOutcome>;
  resolve: (o: BatchOutcome) => void;
}

export interface QueueStats {
  depth: number;
  written: number;
  dropped: number;
  consecutiveFailures: number;
  lastError: string | null;
}

/**
 * In-memory write-behind buffer for MOTION_EVENTS.
 *
 * Batches are appended to `pending`; a single background drainer combines whole batches into
 * chunks of up to `chunkSize` events and writes each chunk with one multi-row INSERT. On failure
 * it retries the same chunk with exponential backoff + jitter (retries use the dedupe INSERT, in
 * case a timed-out attempt actually committed). A chunk is only dropped after
 * `maxAttemptsBeforeDrop` failures AND a successful ping (Snowflake is up, so the data itself is
 * bad); while Snowflake is down the queue keeps everything, up to `maxQueue` events.
 */
export class EventQueue {
  private pending: Batch[] = [];
  private inflight: Batch[] = [];
  private draining = false;
  private stopped = false;
  private wakeSleep: (() => void) | null = null;
  private written = 0;
  private dropped = 0;
  private consecutiveFailures = 0;
  private lastError: string | null = null;

  constructor(
    private readonly repo: Pick<Repo, 'insertEvents' | 'ping'>,
    private readonly cfg: Pick<EventQueueConfig, 'chunkSize' | 'maxQueue' | 'retryBaseMs' | 'retryMaxMs' | 'maxAttemptsBeforeDrop'>,
    private readonly log: Logger,
  ) {}

  /** Events buffered or being written right now. */
  get depth(): number {
    let n = 0;
    for (const b of this.pending) n += b.events.length;
    for (const b of this.inflight) n += b.events.length;
    return n;
  }

  stats(): QueueStats {
    return {
      depth: this.depth,
      written: this.written,
      dropped: this.dropped,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
    };
  }

  /** Buffer a batch and make sure the drainer is running. Throws QueueFullError when over capacity. */
  enqueue(events: MotionEvent[]): Promise<BatchOutcome> {
    if (events.length === 0) return Promise.resolve('written');
    const depth = this.depth;
    if (depth + events.length > this.cfg.maxQueue) throw new QueueFullError(depth, this.cfg.maxQueue);
    let resolve!: (o: BatchOutcome) => void;
    const done = new Promise<BatchOutcome>((r) => (resolve = r));
    this.pending.push({ events, sessionIds: new Set(events.map((e) => e.session_id)), done, resolve });
    this.kick();
    return done;
  }

  /** Wait (bounded) until no buffered batch contains this session. True if fully flushed. */
  async waitForSession(sessionId: string, timeoutMs: number): Promise<boolean> {
    const waits = [...this.inflight, ...this.pending].filter((b) => b.sessionIds.has(sessionId)).map((b) => b.done);
    if (waits.length === 0) return true;
    return raceTimeout(Promise.all(waits).then(() => true), timeoutMs, false);
  }

  /** Wait (bounded) until everything currently buffered has been written or dropped. */
  async flush(timeoutMs: number): Promise<boolean> {
    const waits = [...this.inflight, ...this.pending].map((b) => b.done);
    if (waits.length === 0) return true;
    return raceTimeout(Promise.all(waits).then(() => true), timeoutMs, false);
  }

  /** Stop the drainer (pending events stay in memory). */
  stop(): void {
    this.stopped = true;
    this.wakeSleep?.();
  }

  private kick(): void {
    if (this.draining || this.stopped) return;
    this.draining = true;
    void this.drainLoop()
      .catch((err) => this.log.error('event drainer crashed', { error: errorMessage(err) }))
      .finally(() => {
        this.draining = false;
        if (this.pending.length > 0 && !this.stopped) this.kick();
      });
  }

  private takeChunk(): Batch[] {
    const chunk: Batch[] = [];
    let n = 0;
    while (this.pending.length > 0) {
      const next = this.pending[0]!;
      if (chunk.length > 0 && n + next.events.length > this.cfg.chunkSize) break;
      chunk.push(this.pending.shift()!);
      n += next.events.length;
    }
    return chunk;
  }

  private async drainLoop(): Promise<void> {
    while (this.pending.length > 0 && !this.stopped) {
      const chunk = this.takeChunk();
      this.inflight = chunk;
      const events = chunk.flatMap((b) => b.events);
      let attempt = 0;
      let outcome: BatchOutcome | null = null;
      while (outcome === null) {
        try {
          await this.repo.insertEvents(events, { dedupe: attempt > 0 });
          outcome = 'written';
          this.written += events.length;
          this.consecutiveFailures = 0;
          this.lastError = null;
        } catch (err) {
          attempt++;
          this.consecutiveFailures++;
          this.lastError = errorMessage(err);
          if (this.stopped) return this.requeue(chunk);
          if (attempt >= this.cfg.maxAttemptsBeforeDrop && (await this.repo.ping())) {
            this.log.error('dropping event chunk: Snowflake is reachable but the insert keeps failing', {
              events: events.length,
              attempts: attempt,
              error: this.lastError,
            });
            outcome = 'dropped';
            this.dropped += events.length;
            break;
          }
          const delay = this.backoff(attempt);
          this.log.warn('event insert failed; will retry', {
            events: events.length,
            attempt,
            retryInMs: delay,
            queueDepth: this.depth,
            error: this.lastError,
          });
          await this.sleep(delay);
          if (this.stopped) return this.requeue(chunk);
        }
      }
      this.inflight = [];
      for (const b of chunk) b.resolve(outcome);
    }
  }

  /** Put an unwritten chunk back at the head of the queue (used when stopping mid-retry). */
  private requeue(chunk: Batch[]): void {
    this.pending.unshift(...chunk);
    this.inflight = [];
  }

  private backoff(attempt: number): number {
    const exp = Math.min(this.cfg.retryMaxMs, this.cfg.retryBaseMs * 2 ** Math.min(attempt - 1, 20));
    // Full jitter in [exp/2, exp]
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wakeSleep = () => {
        this.wakeSleep = null;
        done();
      };
    });
  }
}
