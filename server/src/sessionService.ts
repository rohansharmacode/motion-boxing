import { fallbackCard, generateCoachCard, normalizeCard } from './coach';
import type { Cortex } from './cortex';
import { HttpError, db } from './errors';
import type { EventQueue } from './eventQueue';
import type { Logger } from './logger';
import { sessionMetrics } from './metrics';
import { computePercentiles } from './percentile';
import type { Repo } from './repo/types';
import type { Benchmark, CoachCard, Percentiles, SessionEndResult, SessionRecord, StoredCoach } from './types';
import { errorMessage } from './util';

/** PRO_BENCHMARKS rarely change; cache them and keep serving the last good copy on errors. */
export class BenchmarkCache {
  private cache = new Map<string, { at: number; rows: Benchmark[] }>();

  constructor(
    private readonly repo: Pick<Repo, 'benchmarks'>,
    private readonly log: Logger,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  async get(sport: string): Promise<Benchmark[]> {
    const hit = this.cache.get(sport);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.rows;
    try {
      const rows = await this.repo.benchmarks(sport);
      if (rows.length > 0) this.cache.set(sport, { at: Date.now(), rows });
      return rows;
    } catch (err) {
      this.log.warn('could not load PRO_BENCHMARKS', { error: errorMessage(err) });
      return hit?.rows ?? [];
    }
  }
}

function publicCard(c: CoachCard): CoachCard {
  return { tips: [c.tips[0], c.tips[1], c.tips[2]], drill: c.drill, badge: c.badge, summary: c.summary };
}

function fromStored(s: SessionRecord): SessionEndResult | null {
  if (!s.coach || !s.stats) return null;
  // ai_coach_json may have been written by something else; never return a malformed card.
  const card = normalizeCard(s.coach);
  if (!card) return { session_id: s.session_id, stats: s.stats, coach: fallbackCard(s.stats), fallback: true };
  return { session_id: s.session_id, stats: s.stats, coach: card, fallback: Boolean(s.coach.fallback) };
}

export interface SessionServiceDeps {
  repo: Repo;
  cortex: Cortex;
  queue: EventQueue;
  benchmarks: BenchmarkCache;
  log: Logger;
  coachTimeoutMs: number;
  flushWaitMs: number;
}

/**
 * POST /api/session/end. Idempotent: once a session has a stored coach card, every later call
 * returns the stored result. Concurrent calls for the same session share one computation, and
 * the UPDATE only writes when ai_coach_json IS NULL, so two server instances can't both win.
 */
export class SessionService {
  private inflight = new Map<string, Promise<SessionEndResult>>();

  constructor(private readonly d: SessionServiceDeps) {}

  /** `client`: optional front-end round summary, stored inside SESSIONS.ai_coach_json. */
  end(sessionId: string, client?: Record<string, unknown>): Promise<SessionEndResult> {
    const running = this.inflight.get(sessionId);
    if (running) return running;
    const p = this.doEnd(sessionId, client).finally(() => this.inflight.delete(sessionId));
    this.inflight.set(sessionId, p);
    return p;
  }

  private async doEnd(sessionId: string, client?: Record<string, unknown>): Promise<SessionEndResult> {
    const { repo, queue, log } = this.d;
    const session = await db(repo.getSession(sessionId));
    if (!session) throw new HttpError(404, 'session_not_found', `Unknown session_id ${sessionId}`);
    const stored = fromStored(session);
    if (stored) return stored;

    // Events for this session may still be in the write-behind queue.
    const flushed = await queue.waitForSession(sessionId, this.d.flushWaitMs);
    if (!flushed) log.warn('session end: some events for this session are still queued', { sessionId });

    const agg = await db(repo.aggregateSession(sessionId));

    let percentiles: Partial<Percentiles> = {};
    try {
      percentiles = computePercentiles(sessionMetrics(agg), await this.d.benchmarks.get(session.sport || 'boxing'));
    } catch (err) {
      log.warn('session end: percentiles unavailable', { error: errorMessage(err) });
    }

    const { card, fallback, reason } = await generateCoachCard(
      { cortex: this.d.cortex, timeoutMs: this.d.coachTimeoutMs, log },
      agg,
      percentiles,
    );
    const coach: StoredCoach = {
      ...card,
      fallback,
      model: fallback ? 'fallback' : this.d.cortex.model,
      generated_at: new Date().toISOString(),
      ...(client ? { client } : {}),
    };

    try {
      const won = await repo.finalizeSession(sessionId, agg.stats, coach);
      if (!won) {
        // Someone else finalized first: return what is stored so every caller sees the same card.
        const again = await repo.getSession(sessionId);
        const result = again && fromStored(again);
        if (result) return result;
      }
    } catch (err) {
      log.error('session end: could not store results in SESSIONS', { sessionId, error: errorMessage(err) });
    }
    if (fallback) log.info('session end used fallback coach card', { sessionId, reason });
    return { session_id: sessionId, stats: agg.stats, coach: publicCard(card), fallback };
  }
}
