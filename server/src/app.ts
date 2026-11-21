import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import { createAskRouter } from './ask';
import type { AppConfig } from './config';
import type { Cortex } from './cortex';
import { HttpError, db, errorHandler, notFoundHandler, zodDetails } from './errors';
import { EventQueue, QueueFullError } from './eventQueue';
import type { Logger } from './logger';
import { computePercentiles } from './percentile';
import type { Repo } from './repo/types';
import { CreatePlayerBody, EndSessionBody, EventBatch, IdSchema, StartSessionBody } from './schemas';
import { BenchmarkCache, SessionService } from './sessionService';
import {
  FrontendEndBody,
  FrontendEvent,
  cleanDisplayName,
  isFrontendEndBody,
  isFrontendEvent,
  mapFrontendEvent,
  toFrontendCoach,
  toLeaderboardRow,
} from './frontend';
import { SPORT, type MotionEvent } from './types';
import { errorMessage, mean, raceTimeout } from './util';

/** Insertion-ordered set that forgets its oldest entries beyond `cap`. */
class RecentIds {
  private ids = new Set<string>();
  constructor(private readonly cap: number) {}
  has(id: string): boolean {
    return this.ids.has(id);
  }
  add(id: string): void {
    this.ids.add(id);
    if (this.ids.size > this.cap) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }
}

/** navigator.sendBeacon posts JSON as text/plain; accept both. */
function readBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, 'validation_error', 'Body is not valid JSON');
  }
}

export interface AppDeps {
  repo: Repo;
  cortex: Cortex;
  config: AppConfig;
  log: Logger;
}

export interface AppHandle {
  app: Express;
  queue: EventQueue;
  /** Stop accepting background work and try to flush buffered events. */
  shutdown(flushTimeoutMs?: number): Promise<void>;
}

export function createApp({ repo, cortex, config, log }: AppDeps): AppHandle {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({ type: 'text/plain', limit: '1mb' }));

  const queue = new EventQueue(repo, config.events, log);
  const benchmarks = new BenchmarkCache(repo, log);
  const sessions = new SessionService({
    repo,
    cortex,
    queue,
    benchmarks,
    log,
    coachTimeoutMs: config.coachTimeoutMs,
    flushWaitMs: config.sessionEndFlushWaitMs,
    coachFastMs: config.coachFastMs,
  });

  // --- Front-end flow (client-generated ids, see src/frontend.ts) ----------------------------
  const seenEventIds = new RecentIds(200_000); // client retries resend the same event_id
  const ensuredSessions = new RecentIds(50_000);
  const ensuring = new Map<string, Promise<void>>();

  /** Creates the PLAYERS/SESSIONS rows for client-generated ids, in the background. */
  function ensureRowsInBackground(events: MotionEvent[]): void {
    const firstBySession = new Map<string, MotionEvent>();
    for (const e of events) {
      const cur = firstBySession.get(e.session_id);
      if (!cur || e.event_ts < cur.event_ts) firstBySession.set(e.session_id, e);
    }
    for (const [sid, e] of firstBySession) {
      if (ensuredSessions.has(sid) || ensuring.has(sid)) continue;
      const p = (async () => {
        await repo.ensurePlayer(e.player_id, null);
        await repo.ensureSession(sid, e.player_id, SPORT, e.event_ts);
        ensuredSessions.add(sid);
      })()
        .catch((err) => log.warn('could not create player/session rows (retried at session end)', { sid, error: errorMessage(err) }))
        .finally(() => ensuring.delete(sid));
      ensuring.set(sid, p);
    }
  }

  async function playerFormScore(playerId: string): Promise<number | null> {
    const [metrics, bms] = await Promise.all([repo.playerMetrics(playerId), benchmarks.get('boxing')]);
    const values = Object.values(computePercentiles(metrics, bms)).filter((v): v is number => typeof v === 'number');
    const m = mean(values);
    return m === null ? null : Math.round(m);
  }

  // Snowflake ping is cached briefly so health checks don't hammer the warehouse.
  let lastPing: { at: number; ok: boolean } | null = null;
  async function snowflakeStatus(): Promise<'up' | 'down' | 'mock'> {
    if (repo.mode === 'mock') return 'mock';
    if (!lastPing || Date.now() - lastPing.at > 5000) {
      lastPing = { at: Date.now(), ok: await repo.ping() };
    }
    return lastPing.ok ? 'up' : 'down';
  }

  app.get('/api/health', async (_req, res) => {
    const snowflake = await snowflakeStatus();
    res.json({ ok: true, mode: repo.mode, snowflake, queueDepth: queue.depth });
  });

  app.post('/api/players', async (req, res) => {
    const { name } = CreatePlayerBody.parse(req.body);
    const player_id = await db(repo.createPlayer(name));
    res.status(201).json({ player_id });
  });

  app.post('/api/session/start', async (req, res) => {
    const { player_id, sport } = StartSessionBody.parse(req.body);
    const player = await db(repo.getPlayer(player_id));
    if (!player) throw new HttpError(404, 'player_not_found', `Unknown player_id ${player_id}`);
    const session_id = await db(repo.createSession(player_id, sport));
    res.status(201).json({ session_id });
  });

  app.post('/api/events', async (req, res) => {
    let body = readBody(req.body);
    if (body && typeof body === 'object' && !Array.isArray(body) && Array.isArray((body as { events?: unknown }).events)) {
      body = (body as { events: unknown[] }).events;
    }
    if (!Array.isArray(body)) {
      throw new HttpError(400, 'validation_error', 'Body must be a JSON array of events or {"events": [...]}');
    }
    if (body.length > config.events.maxBatch) {
      throw new HttpError(413, 'batch_too_large', `At most ${config.events.maxBatch} events per request (got ${body.length})`);
    }
    if (body.some(isFrontendEvent)) {
      // Front-end shape. Bad events are dropped one by one (never 4xx the whole batch: the
      // client would retry it forever); duplicates of already-accepted event_ids are skipped.
      const rows: MotionEvent[] = [];
      let rejected = 0;
      let ignored = 0;
      let duplicates = 0;
      let firstError: unknown;
      for (const raw of body) {
        const p = FrontendEvent.safeParse(raw);
        if (!p.success) {
          rejected++;
          firstError ??= zodDetails(p.error);
          continue;
        }
        if (seenEventIds.has(p.data.event_id)) {
          duplicates++;
          continue;
        }
        const row = mapFrontendEvent(p.data, config.shoulderWidthM);
        if (row) rows.push(row);
        else ignored++;
      }
      if (rejected > 0) log.warn('dropped invalid front-end events', { rejected, firstError });
      if (rows.length === 0) {
        res.status(202).json({ accepted: 0, queued: false, ignored, rejected, duplicates });
        return;
      }
      let written: Promise<unknown>;
      try {
        written = queue.enqueue(rows);
      } catch (err) {
        if (err instanceof QueueFullError) {
          throw new HttpError(503, 'queue_full', 'Event buffer is full (database unavailable); retry later');
        }
        throw err;
      }
      for (const r of rows) seenEventIds.add(r.event_id);
      ensureRowsInBackground(rows);
      const outcome = await raceTimeout(written, config.events.ackWaitMs, 'pending' as const);
      res.status(202).json({ accepted: rows.length, queued: outcome !== 'written', ignored, rejected, duplicates });
      return;
    }
    const parsed = EventBatch.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, 'validation_error', 'One or more events are invalid', zodDetails(parsed.error));
    }
    if (parsed.data.length === 0) {
      res.status(202).json({ accepted: 0, queued: false });
      return;
    }
    let duplicates = 0;
    const events: MotionEvent[] = [];
    for (const e of parsed.data) {
      // payload.client_event_id (src/api/serverAdapter.ts) becomes the event_id, so a batch the
      // client retries (or re-sends by beacon) is not stored twice.
      const clientId = IdSchema.safeParse(e.payload?.client_event_id);
      if (clientId.success && seenEventIds.has(clientId.data)) {
        duplicates++;
        continue;
      }
      // payload.speed_unit 'SW/s' = shoulder-widths per second; benchmarks are in m/s.
      const sw = e.payload?.speed_unit === 'SW/s';
      events.push({
        event_id: clientId.success ? clientId.data : randomUUID(),
        session_id: e.session_id,
        player_id: e.player_id,
        sport: e.sport,
        event_ts: new Date(e.event_ts).toISOString(),
        event_type: e.event_type,
        hand: e.hand,
        speed_mps: sw ? Math.round(Math.min(100, e.speed_mps * config.shoulderWidthM) * 1000) / 1000 : e.speed_mps,
        accuracy: e.accuracy ?? null,
        reaction_ms: e.reaction_ms ?? null,
        guard_up: e.guard_up ?? null,
        points: e.points ?? 0,
        payload: sw ? { ...e.payload, speed_sw_s: e.speed_mps } : (e.payload ?? null),
      });
    }
    if (events.length === 0) {
      res.status(202).json({ accepted: 0, queued: false, duplicates });
      return;
    }

    let written: Promise<unknown>;
    try {
      written = queue.enqueue(events);
    } catch (err) {
      if (err instanceof QueueFullError) {
        throw new HttpError(503, 'queue_full', 'Event buffer is full (database unavailable); retry later');
      }
      throw err;
    }
    for (const e of events) seenEventIds.add(e.event_id);
    // queued:false = already committed when we answered; queued:true = buffered, written in the background.
    const outcome = await raceTimeout(written, config.events.ackWaitMs, 'pending' as const);
    res.status(202).json({ accepted: events.length, queued: outcome !== 'written', ...(duplicates ? { duplicates } : {}) });
  });

  app.post('/api/session/end', async (req, res) => {
    const body = readBody(req.body);
    if (!isFrontendEndBody(body)) {
      const { session_id } = EndSessionBody.parse(body);
      res.json(await sessions.end(session_id));
      return;
    }
    // Front-end shape: upsert PLAYERS + SESSIONS, run the coach, return coach + leaderboard + form score.
    const b = FrontendEndBody.parse(body);
    await ensuring.get(b.session_id);
    await db(repo.ensurePlayer(b.player_id, cleanDisplayName(b.display_name)));
    if (!ensuredSessions.has(b.session_id)) {
      await db(repo.ensureSession(b.session_id, b.player_id, SPORT, b.started_at ?? null));
      ensuredSessions.add(b.session_id);
    }
    const result = await sessions.end(b.session_id, {
      final_score: b.final_score ?? null,
      result: b.result ?? null,
      avg_inference_fps: b.avg_inference_fps ?? null,
      ended_at: b.ended_at ?? null,
      stats: b.stats ?? null,
    });
    const [leaderboard, form_score] = await Promise.all([
      repo.leaderboard(10).then((rows) => rows.map(toLeaderboardRow)).catch((err) => {
        log.warn('session end: leaderboard unavailable', { error: errorMessage(err) });
        return [];
      }),
      playerFormScore(b.player_id).catch((err) => {
        log.warn('session end: form score unavailable', { error: errorMessage(err) });
        return null;
      }),
    ]);
    res.json({ ...result, coach: toFrontendCoach(result.coach, result.stats), leaderboard, form_score });
  });

  /** Poll after a session end answered warming_up:true. */
  app.get('/api/session/:id/coach', async (req, res) => {
    const id = IdSchema.safeParse(req.params.id);
    if (!id.success) throw new HttpError(400, 'validation_error', 'Invalid session id', zodDetails(id.error));
    const status = await sessions.coachStatus(id.data);
    res.json(status.ready ? { ...status, coach_card: toFrontendCoach(status.coach, status.stats) } : status);
  });

  app.get('/api/leaderboard', async (_req, res) => {
    res.json((await db(repo.leaderboard(10))).map(toLeaderboardRow));
  });

  app.get('/api/player/:id/stats', async (req, res) => {
    const id = IdSchema.safeParse(req.params.id);
    if (!id.success) throw new HttpError(400, 'validation_error', 'Invalid player id', zodDetails(id.error));
    const player = await db(repo.getPlayer(id.data));
    if (!player) throw new HttpError(404, 'player_not_found', `Unknown player_id ${id.data}`);
    const [history, metrics, bms] = await Promise.all([
      db(repo.playerSessions(id.data, 50)),
      db(repo.playerMetrics(id.data)),
      benchmarks.get('boxing'),
    ]);
    res.json({
      player: { player_id: player.player_id, name: player.name },
      sessions: history,
      percentiles: computePercentiles(metrics, bms),
    });
  });

  app.use(createAskRouter({ repo, cortex, config, log }));

  app.use(notFoundHandler);
  app.use(errorHandler(log));

  return {
    app,
    queue,
    async shutdown(flushTimeoutMs = 5000) {
      const flushed = await queue.flush(flushTimeoutMs);
      if (!flushed) log.warn('shutdown: some events were still buffered and are lost', { depth: queue.depth });
      queue.stop();
    },
  };
}
