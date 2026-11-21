import { fallbackCard, generateCoachCard, normalizeCard, type CoachResult } from './coach';
import type { Cortex } from './cortex';
import { HttpError, db } from './errors';
import type { EventQueue } from './eventQueue';
import type { Logger } from './logger';
import { sessionMetrics } from './metrics';
import { computePercentiles } from './percentile';
import type { Repo } from './repo/types';
import type { Benchmark, CoachCard, CoachMeta, Percentiles, SessionEndResult, SessionRecord, StoredCoach } from './types';
import { errorMessage, raceTimeout } from './util';

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

/** Extras stored next to the card (absent on cards written before they existed). */
function storedMeta(c: StoredCoach): CoachMeta | undefined {
  if (!c.grounding || typeof c.grounding !== 'object' || !Array.isArray(c.grounding.drills)) return undefined;
  return {
    focus: typeof c.focus === 'string' ? c.focus : null,
    grounding: c.grounding,
    structured: c.structured === true,
    ...(c.headline ? { headline: c.headline } : {}),
  };
}

function fromStored(s: SessionRecord): SessionEndResult | null {
  if (!s.coach || !s.stats) return null;
  // ai_coach_json may have been written by something else; never return a malformed card.
  const card = normalizeCard(s.coach);
  if (!card) return { session_id: s.session_id, stats: s.stats, coach: fallbackCard(s.stats), fallback: true };
  const meta = storedMeta(s.coach);
  return { session_id: s.session_id, stats: s.stats, coach: card, fallback: Boolean(s.coach.fallback), ...(meta ? { coach_meta: meta } : {}) };
}

export interface SessionServiceDeps {
  repo: Repo;
  cortex: Cortex;
  queue: EventQueue;
  benchmarks: BenchmarkCache;
  log: Logger;
  coachTimeoutMs: number;
  flushWaitMs: number;
  /** See AppConfig.coachFastMs. Only used when 0 < coachFastMs < coachTimeoutMs. */
  coachFastMs?: number;
  /** AI_COMPLETE structured output (CORTEX_STRUCTURED). Default true. */
  coachStructured?: boolean;
  /** Cortex Search grounding (COACH_GROUNDING). Default true. */
  coachGrounding?: boolean;
  coachSearchTimeoutMs?: number;
}

export type CoachStatus =
  | ({ ready: true } & SessionEndResult)
  | { ready: false; session_id: string; warming_up: boolean };

/**
 * POST /api/session/end. Idempotent: once a session has a stored coach card, every later call
 * returns the stored result. Concurrent calls for the same session share one computation, and
 * the UPDATE only writes when ai_coach_json IS NULL, so two server instances can't both win.
 */
export class SessionService {
  private inflight = new Map<string, Promise<SessionEndResult>>();
  /** Sessions whose Cortex card is still being generated after we answered with a provisional card. */
  private warming = new Map<string, SessionEndResult>();

  constructor(private readonly d: SessionServiceDeps) {}

  /** `client`: optional front-end round summary, stored inside SESSIONS.ai_coach_json. */
  end(sessionId: string, client?: Record<string, unknown>): Promise<SessionEndResult> {
    const provisional = this.warming.get(sessionId);
    if (provisional) return Promise.resolve(provisional);
    const running = this.inflight.get(sessionId);
    if (running) return running;
    const p = this.doEnd(sessionId, client).finally(() => this.inflight.delete(sessionId));
    this.inflight.set(sessionId, p);
    return p;
  }

  /** GET /api/session/:id/coach: the stored card once ready, else whether it is still warming up. */
  async coachStatus(sessionId: string): Promise<CoachStatus> {
    if (this.warming.has(sessionId)) return { ready: false, session_id: sessionId, warming_up: true };
    const session = await db(this.d.repo.getSession(sessionId));
    if (!session) throw new HttpError(404, 'session_not_found', `Unknown session_id ${sessionId}`);
    const stored = fromStored(session);
    return stored ? { ready: true, ...stored } : { ready: false, session_id: sessionId, warming_up: false };
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

    const full = generateCoachCard(
      {
        cortex: this.d.cortex,
        timeoutMs: this.d.coachTimeoutMs,
        log,
        structured: this.d.coachStructured !== false,
        search: this.d.coachGrounding === false ? undefined : (q, o) => repo.searchDrills(q, o),
        searchTimeoutMs: this.d.coachSearchTimeoutMs,
      },
      agg,
      percentiles,
    );
    const fastMs = this.d.coachFastMs ?? 0;
    if (fastMs > 0 && fastMs < this.d.coachTimeoutMs) {
      const early = await raceTimeout(full, fastMs, 'slow' as const);
      if (early === 'slow') {
        // Cortex is warming up: answer now with a provisional card, finish and store the real one in the background.
        const provisional: SessionEndResult = {
          session_id: sessionId,
          stats: agg.stats,
          coach: publicCard(fallbackCard(agg.stats)),
          fallback: true,
          warming_up: true,
        };
        this.warming.set(sessionId, provisional);
        log.info('session end: Cortex slower than COACH_FAST_MS, answered with provisional card', { sessionId, fastMs });
        void full
          .then((r) => this.finish(sessionId, agg, r, client))
          .catch((err) => log.error('session end: background coach failed', { sessionId, error: errorMessage(err) }))
          .finally(() => this.warming.delete(sessionId));
        return provisional;
      }
      return this.finish(sessionId, agg, early, client);
    }
    return this.finish(sessionId, agg, await full, client);
  }

  private async finish(
    sessionId: string,
    agg: Awaited<ReturnType<Repo['aggregateSession']>>,
    { card, fallback, reason, meta }: CoachResult,
    client?: Record<string, unknown>,
  ): Promise<SessionEndResult> {
    const { repo, log } = this.d;
    const coach: StoredCoach = {
      ...card,
      fallback,
      model: fallback ? 'fallback' : this.d.cortex.model,
      generated_at: new Date().toISOString(),
      ...(meta
        ? { focus: meta.focus, grounding: meta.grounding, structured: meta.structured, ...(meta.headline ? { headline: meta.headline } : {}) }
        : {}),
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
    return { session_id: sessionId, stats: agg.stats, coach: publicCard(card), fallback, ...(meta ? { coach_meta: meta } : {}) };
  }
}
