// Kinetic Ring API client.
//
//   const player  = await createPlayer('Naman');            // POST /api/players
//   const session = await startSession(player, 'BOXING');   // POST /api/session/start
//   session.start();                                         // when the round begins
//   ...sport engine: emitMotionEvent(...) or emitMotionEvent(fromMotionLib(ev))
//   const res = await endSession(session, { finalScore, result }); // flush + POST /api/session/end
//   const lb  = await getLeaderboard('BOXING', 10);          // GET /api/leaderboard
//
// Events are batched every 2 s into POST /api/events. Unsent events live in a module-level
// outbox that is mirrored to localStorage, retried with exponential backoff, re-sent on
// 'online' and at app load, and sent with sendBeacon on 'pagehide'. The server de-dupes on
// event_id, so re-sending is always safe.
//
// No Promise from this module rejects: any network error, non-2xx or timeout falls back to
// mock data (source: 'mock'). Mock mode = VITE_API_URL empty or VITE_USE_MOCK === 'true'.

import { mockLeaderboard, mockPlayer, mockSessionEnd, recordMockScore } from './mock';
import { parseCoach, parseLeaderboard, serverSport, toServerEvent } from './serverAdapter';
import type { MotionEvent as LibMotionEvent } from '../lib/motion';
import type {
  ApiStatus,
  LeaderboardResponse,
  MotionEvent,
  MotionEventDetail,
  Player,
  PunchType,
  RoundResult,
  RoundStats,
  SessionEndRequest,
  SessionEndResponse,
  Sport,
  StartSessionResponse,
} from './types';

export const MOTION_EVENT = 'motion-event';

const API_URL = String(import.meta.env.VITE_API_URL ?? '').trim().replace(/\/+$/, '');
export const USE_MOCK: boolean = !API_URL || import.meta.env.VITE_USE_MOCK === 'true';

const FLUSH_MS = 2000;
const BACKOFF_START_MS = 2000;
const BACKOFF_MAX_MS = 30000;
const OUTBOX_CAP = 5000;
const BATCH_MAX = 500;
const BEACON_MAX_BYTES = 60000; // browsers cap a beacon around 64 KB
const TIMEOUT_MS = 8000;
const END_TIMEOUT_MS = 20000;
const OUTBOX_KEY = 'kr.outbox.v1';
const PLAYER_KEY = 'kr.player.'; // legacy: id string per lower-cased display name
const PLAYER_REC_KEY = 'kr.playerRec.'; // { player, live }

const hasWindow = typeof window !== 'undefined';
const log = (...args: unknown[]) => {
  if (import.meta.env.DEV) console.debug('[api]', ...args);
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const uuid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* full or disabled */
  }
}
function storageRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* disabled */
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const normName = (name: string) => name.trim() || 'Player';
const nameKey = (name: string) => normName(name).toLowerCase();

/** Stable player id per display name on this browser (legacy helper, used by createSession). */
export function playerIdFor(name: string): string {
  const key = PLAYER_KEY + nameKey(name);
  let id = storageGet(key);
  if (!id) {
    id = uuid();
    storageSet(key, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** True after a live call failed, false after one succeeded. Drives getApiStatus(). */
let apiFailing = false;

class HttpError extends Error {
  readonly path: string;
  readonly status: number;
  constructor(path: string, status: number) {
    super(`${path} -> HTTP ${status}`);
    this.path = path;
    this.status = status;
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new HttpError(path, res.status);
    apiFailing = false;
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch (err) {
    apiFailing = true;
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Outbox: batching, retry with backoff, localStorage persistence, beacon
// ---------------------------------------------------------------------------

function loadOutbox(): MotionEvent[] {
  if (USE_MOCK) return [];
  try {
    const parsed: unknown = JSON.parse(storageGet(OUTBOX_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as unknown[]).filter((e): e is MotionEvent => isRecord(e) && typeof e.event_id === 'string') : [];
  } catch {
    return [];
  }
}

let outbox: MotionEvent[] = hasWindow ? loadOutbox() : [];
let inflight: Promise<boolean> | null = null;
let backoffMs = 0;
let nextAttemptAt = 0;
let dirty = false;

function capOutbox() {
  if (outbox.length > OUTBOX_CAP) outbox.splice(0, outbox.length - OUTBOX_CAP); // drop oldest
}

function persistOutbox() {
  dirty = false;
  if (USE_MOCK) return;
  if (!outbox.length) storageRemove(OUTBOX_KEY);
  else storageSet(OUTBOX_KEY, JSON.stringify(outbox));
}

function enqueue(ev: MotionEvent) {
  if (USE_MOCK) return; // nothing to send; the session keeps its own copy for stats()
  outbox.push(ev);
  capOutbox();
  dirty = true;
}

/** Send one batch. */
async function sendOnce(): Promise<'done' | 'more' | 'failed'> {
  if (!outbox.length) return 'done';
  const batch = outbox.splice(0, BATCH_MAX);
  const payload = batch.map(toServerEvent).filter((e) => e !== null);
  try {
    if (payload.length) await request('POST', '/api/events', payload);
    backoffMs = 0;
    nextAttemptAt = 0;
    persistOutbox();
    return outbox.length ? 'more' : 'done';
  } catch (err) {
    // A 4xx (other than timeout/rate limit) will never succeed: drop the batch instead of
    // retrying it forever and blocking everything behind it.
    if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
      console.error(`[api] server rejected ${batch.length} events (HTTP ${err.status}); dropping them`, err);
      persistOutbox();
      return outbox.length ? 'more' : 'done';
    }
    outbox = batch.concat(outbox); // back to the front of the queue
    capOutbox();
    backoffMs = backoffMs ? Math.min(backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
    nextAttemptAt = Date.now() + backoffMs;
    persistOutbox();
    console.warn(`[api] events batch failed (${batch.length}), retrying in ${backoffMs / 1000}s`, err);
    return 'failed';
  }
}

/**
 * Drain the outbox. Without `force`, respects the backoff window. Never rejects.
 * Resolves true if everything was sent.
 */
function drain(force = false): Promise<boolean> {
  if (USE_MOCK) return Promise.resolve(true);
  // A forced drain waits for the in-flight batch, then sends whatever arrived meanwhile.
  if (inflight) return force ? inflight.then(() => drain(true)) : inflight;
  if (!outbox.length) {
    if (dirty) persistOutbox();
    return Promise.resolve(true);
  }
  if (!force && Date.now() < nextAttemptAt) {
    if (dirty) persistOutbox();
    return Promise.resolve(false);
  }
  inflight = (async () => {
    try {
      // Keep going while batches succeed (big offline backlogs go out in chunks).
      for (;;) {
        const r = await sendOnce();
        if (r !== 'more') return r === 'done';
      }
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function beaconOutbox() {
  if (USE_MOCK || !outbox.length || typeof navigator === 'undefined' || !navigator.sendBeacon) {
    persistOutbox();
    return;
  }
  const url = `${API_URL}/api/events`;
  let i = 0;
  while (i < outbox.length) {
    // Grow the chunk until it would exceed the beacon size limit.
    let n = Math.min(BATCH_MAX, outbox.length - i);
    let body = JSON.stringify(outbox.slice(i, i + n).map(toServerEvent).filter((e) => e !== null));
    while (body.length > BEACON_MAX_BYTES && n > 1) {
      n = Math.max(1, Math.floor(n / 2));
      body = JSON.stringify(outbox.slice(i, i + n).map(toServerEvent).filter((e) => e !== null));
    }
    if (!navigator.sendBeacon(url, body)) break;
    i += n;
  }
  outbox.splice(0, i);
  persistOutbox(); // whatever the browser refused stays for next load
}

if (hasWindow && !USE_MOCK) {
  window.setInterval(() => void drain(), FLUSH_MS);
  window.addEventListener('online', () => {
    nextAttemptAt = 0;
    void drain(true);
  });
  window.addEventListener('pagehide', beaconOutbox);
  // Re-send anything left over from a previous visit.
  if (outbox.length) {
    log(`draining ${outbox.length} events from the offline outbox`);
    setTimeout(() => void drain(true), 0);
  }
}

export function getApiStatus(): ApiStatus {
  if (USE_MOCK) return { mode: 'mock', queued: 0 };
  const offline = apiFailing || (typeof navigator !== 'undefined' && navigator.onLine === false);
  return { mode: offline ? 'offline' : 'live', queued: outbox.length };
}

// ---------------------------------------------------------------------------
// Motion events
// ---------------------------------------------------------------------------

/** Convenience for sport engines: same as dispatching the CustomEvent yourself. */
export function emitMotionEvent(detail: MotionEventDetail): void {
  if (!hasWindow) return;
  window.dispatchEvent(new CustomEvent<MotionEventDetail>(MOTION_EVENT, { detail }));
}

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** Map a src/lib/motion event to the API's MotionEventDetail. */
export function fromMotionLib(ev: LibMotionEvent): MotionEventDetail {
  const metrics: Record<string, unknown> = {
    kind: ev.kind,
    confidence: round(ev.confidence, 3),
    frameMs: Math.round(ev.timeMs),
  };
  if (finite(ev.guardUptime)) metrics.guardUptime = round(ev.guardUptime, 3);
  if (finite(ev.fatigueTrend)) metrics.fatigueTrend = round(ev.fatigueTrend, 3);
  if (ev.hand) metrics.hand = ev.hand === 'left' ? 'L' : 'R';

  let event_type: MotionEventDetail['event_type'];
  switch (ev.kind) {
    case 'jab':
    case 'cross':
    case 'hook':
    case 'uppercut':
      event_type = 'PUNCH';
      metrics.punchType = ev.kind.toUpperCase() as PunchType;
      break;
    case 'guard':
      event_type = 'BLOCK';
      break;
    case 'slip':
      event_type = 'DODGE';
      if (ev.hand) metrics.direction = metrics.hand;
      break;
    case 'duck':
      event_type = 'DODGE';
      metrics.direction = 'DOWN';
      break;
    default:
      event_type = 'TICK';
  }

  const detail: MotionEventDetail = {
    event_type,
    accuracy_score: Math.round(Math.max(0, Math.min(1, ev.confidence)) * 100),
    metrics,
  };
  if (event_type === 'PUNCH' && finite(ev.peakVelocity)) detail.peak_velocity = round(ev.peakVelocity, 2);
  if (finite(ev.reactionMs)) detail.reaction_ms = Math.round(ev.reactionMs);
  if (finite(ev.symmetry)) detail.symmetry_ratio = round(ev.symmetry, 3);
  return detail;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionOptions {
  displayName: string;
  sport: Sport;
  /** From createPlayer(); defaults to the stable local id for displayName. */
  playerId?: string;
  /** From POST /api/session/start; defaults to a client uuid. */
  sessionId?: string;
}

export interface EndOptions {
  finalScore: number;
  result: RoundResult;
  avgInferenceFps?: number | null;
}

export class TelemetrySession {
  readonly sessionId: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly sport: Sport;
  /** True when this session is (or fell back to) mock data. */
  offline = USE_MOCK;

  private all: MotionEvent[] = [];
  private startedAt = 0;
  private startedAtIso = new Date().toISOString();
  private listening = false;
  private combo = 0;
  private bestCombo = 0;
  private endPromise: Promise<SessionEndResponse> | null = null;

  constructor(opts: SessionOptions) {
    this.displayName = normName(opts.displayName);
    this.sport = opts.sport;
    this.playerId = opts.playerId ?? playerIdFor(this.displayName);
    this.sessionId = opts.sessionId ?? uuid();
  }

  /** Call when the round actually starts (after calibration + countdown). Idempotent. */
  start(): void {
    if (this.listening || this.endPromise || !hasWindow) return;
    this.listening = true;
    this.startedAt = performance.now();
    this.startedAtIso = new Date().toISOString();
    window.addEventListener(MOTION_EVENT, this.onEvent);
  }

  get roundMs(): number {
    return this.startedAt ? Math.round(performance.now() - this.startedAt) : 0;
  }

  get ended(): boolean {
    return this.endPromise !== null;
  }

  private onEvent = (e: Event) => {
    if (this.endPromise) return;
    const d = (e as CustomEvent<MotionEventDetail>).detail;
    if (!d?.event_type) return;
    const ev: MotionEvent = {
      event_id: uuid(),
      session_id: this.sessionId,
      player_id: this.playerId,
      sport: this.sport,
      event_ts: new Date().toISOString(),
      round_ms: Math.round(d.round_ms ?? this.roundMs),
      event_type: d.event_type,
      peak_velocity: d.peak_velocity ?? null,
      reaction_ms: d.reaction_ms ?? null,
      accuracy_score: d.accuracy_score ?? null,
      symmetry_ratio: d.symmetry_ratio ?? null,
      metrics: d.metrics ?? {},
    };
    this.all.push(ev);
    enqueue(ev);

    if (ev.event_type === 'PUNCH') {
      if (ev.metrics.landed === false) this.combo = 0;
      else this.bestCombo = Math.max(this.bestCombo, ++this.combo);
    }
  };

  /** Engines can reset the combo when the player gets hit. */
  breakCombo(): void {
    this.combo = 0;
  }

  /** Send queued events now (ignores the backoff window). Never rejects. */
  async flush(): Promise<void> {
    const ok = await drain(true);
    if (!ok) this.offline = true;
  }

  stats(): RoundStats {
    const punches = this.all.filter((e) => e.event_type === 'PUNCH');
    const dodges = this.all.filter((e) => e.event_type === 'DODGE');
    const speeds = punches.map((e) => e.peak_velocity).filter(finite);
    const reactions = this.all.map((e) => e.reaction_ms).filter(finite);
    const byType: Partial<Record<PunchType, number>> = {};
    let left = 0;
    let right = 0;
    for (const p of punches) {
      const t = p.metrics.punchType as PunchType | undefined;
      if (t) byType[t] = (byType[t] ?? 0) + 1;
      if (p.metrics.hand === 'L') left++;
      if (p.metrics.hand === 'R') right++;
    }
    // Motion-lib metrics are running values: the latest one describes the whole round.
    let guardUptime: number | null = null;
    let fatigueTrend: number | null = null;
    for (let i = this.all.length - 1; i >= 0 && (guardUptime === null || fatigueTrend === null); i--) {
      const m = this.all[i].metrics;
      if (guardUptime === null && typeof m.guardUptime === 'number') guardUptime = m.guardUptime;
      if (fatigueTrend === null && typeof m.fatigueTrend === 'number') fatigueTrend = m.fatigueTrend;
    }
    const ducks = dodges.filter((e) => e.metrics.kind === 'duck').length;
    return {
      punches: punches.length,
      landed: punches.filter((p) => p.metrics.landed !== false).length,
      byType,
      avgSpeed: speeds.length ? round(speeds.reduce((a, b) => a + b, 0) / speeds.length, 2) : 0,
      maxSpeed: speeds.length ? Math.max(...speeds) : 0,
      blocks: this.all.filter((e) => e.event_type === 'BLOCK').length,
      dodges: dodges.length,
      avgReactionMs: reactions.length ? Math.round(reactions.reduce((a, b) => a + b, 0) / reactions.length) : null,
      leftRightRatio: right ? round(left / right, 2) : null,
      bestCombo: this.bestCombo,
      guardPct: guardUptime === null ? null : Math.round(guardUptime * 100),
      slips: dodges.length - ducks,
      ducks,
      fatigueTrend: fatigueTrend === null ? null : round(fatigueTrend, 3),
    };
  }

  /**
   * Stop listening, flush the last events, then ask the backend for the coach card + leaderboard.
   * Never rejects; calling it twice returns the same promise.
   */
  end(opts: EndOptions): Promise<SessionEndResponse> {
    if (this.endPromise) return this.endPromise;
    if (hasWindow) window.removeEventListener(MOTION_EVENT, this.onEvent);
    this.listening = false;

    const req: SessionEndRequest = {
      session_id: this.sessionId,
      player_id: this.playerId,
      display_name: this.displayName,
      sport: this.sport,
      started_at: this.startedAtIso,
      ended_at: new Date().toISOString(),
      final_score: Math.round(Number.isFinite(opts.finalScore) ? opts.finalScore : 0),
      result: opts.result,
      avg_inference_fps: opts.avgInferenceFps ?? null,
      stats: this.stats(),
    };

    this.endPromise = this.finish(req);
    return this.endPromise;
  }

  private async finish(req: SessionEndRequest): Promise<SessionEndResponse> {
    if (USE_MOCK) {
      log(`mock mode: ${this.all.length} events not sent`, this.all);
      return mockSessionEnd(req);
    }
    try {
      await this.flush(); // events first, so Snowflake can aggregate them
      if (!serverSport(req.sport)) throw new Error(`session/end: server does not support ${req.sport} yet`);
      const data = await request<unknown>('POST', '/api/session/end', { session_id: req.session_id }, END_TIMEOUT_MS);
      const coach = parseCoach(isRecord(data) ? data.coach : null);
      if (!coach) throw new Error('session/end: unexpected response shape');
      // Mirror the score locally so a later mock fallback still shows this player.
      recordMockScore({
        player_id: req.player_id,
        display_name: req.display_name,
        sport: req.sport,
        score: req.final_score,
        max_speed: req.stats.maxSpeed ? round(req.stats.maxSpeed, 1) : null,
      });
      const board = await getLeaderboard(req.sport, 10);
      return { coach, leaderboard: board.entries, form_score: null, source: 'live' };
    } catch (err) {
      console.warn('[api] session/end failed, using mock coach', err);
      this.offline = true;
      return mockSessionEnd(req);
    }
  }
}

// ---------------------------------------------------------------------------
// Players, session start, leaderboard
// ---------------------------------------------------------------------------

interface PlayerRecord {
  player: Player;
  /** True when the id came from the live API. */
  live: boolean;
}

function readPlayerRec(name: string): PlayerRecord | null {
  try {
    const parsed: unknown = JSON.parse(storageGet(PLAYER_REC_KEY + nameKey(name)) ?? 'null');
    if (isRecord(parsed) && isRecord(parsed.player) && typeof parsed.player.player_id === 'string') {
      return parsed as unknown as PlayerRecord;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function savePlayerRec(rec: PlayerRecord) {
  const key = nameKey(rec.player.display_name);
  storageSet(PLAYER_REC_KEY + key, JSON.stringify(rec));
  storageSet(PLAYER_KEY + key, rec.player.player_id); // keep the legacy key in sync
}

/** POST /api/players. Same display name on this browser -> same player id. Never rejects. */
export async function createPlayer(displayName: string): Promise<Player> {
  const name = normName(displayName);
  const cached = readPlayerRec(name);
  if (cached && (cached.live || USE_MOCK)) return { ...cached.player, display_name: name };

  if (!USE_MOCK) {
    try {
      const data = await request<unknown>('POST', '/api/players', { name });
      if (isRecord(data) && typeof data.player_id === 'string' && data.player_id) {
        const player: Player = {
          player_id: data.player_id,
          display_name: name,
          created_at: typeof data.created_at === 'string' ? data.created_at : new Date().toISOString(),
        };
        savePlayerRec({ player, live: true });
        return player;
      }
      throw new Error('players: unexpected response shape');
    } catch (err) {
      console.warn('[api] createPlayer failed, using a local id', err);
    }
  }

  // Mock / fallback: reuse the stable local id (also used by legacy createSession).
  const player = cached?.player ?? mockPlayer(name, playerIdFor(name));
  savePlayerRec({ player, live: false });
  return { ...player, display_name: name };
}

/**
 * POST /api/session/start. Returns a session that is NOT yet listening;
 * call session.start() when the round begins. Never rejects.
 */
export async function startSession(player: Player, sport: Sport): Promise<TelemetrySession> {
  const base: SessionOptions = { displayName: player.display_name, sport, playerId: player.player_id };
  const apiSport = serverSport(sport);
  if (USE_MOCK || !apiSport) return new TelemetrySession(base);
  try {
    const data = await request<StartSessionResponse>('POST', '/api/session/start', { player_id: player.player_id, sport: apiSport });
    const sessionId = isRecord(data) && typeof data.session_id === 'string' && data.session_id ? data.session_id : undefined;
    return new TelemetrySession({ ...base, sessionId });
  } catch (err) {
    console.warn('[api] session/start failed, using a client session id', err);
    const s = new TelemetrySession(base);
    s.offline = true;
    return s;
  }
}

/** Flush the session's events, then POST /api/session/end. Never rejects. */
export function endSession(session: TelemetrySession, opts: EndOptions): Promise<SessionEndResponse> {
  return session.end(opts);
}

/** GET /api/leaderboard?sport=&limit=. Never rejects. */
export async function getLeaderboard(sport: Sport, limit = 10): Promise<LeaderboardResponse> {
  const n = Math.max(1, Math.min(100, Math.floor(limit) || 10));
  const apiSport = serverSport(sport);
  if (USE_MOCK || !apiSport) return mockLeaderboard(sport, n);
  try {
    const data = await request<unknown>('GET', `/api/leaderboard?sport=${apiSport}&limit=${n}`);
    const entries = parseLeaderboard(data, sport);
    if (!entries) throw new Error('leaderboard: unexpected response shape');
    return { entries: entries.slice(0, n), source: 'live' };
  } catch (err) {
    console.warn('[api] leaderboard failed, using mock', err);
    return mockLeaderboard(sport, n);
  }
}

/** Legacy shortcut (sync): new TelemetrySession(opts) with a local player id + client session id. */
export function createSession(opts: { displayName: string; sport: Sport }): TelemetrySession {
  return new TelemetrySession(opts);
}
