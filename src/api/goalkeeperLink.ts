// Bridges the goalkeeper game's own telemetry (src/sports/goalkeeper/telemetry.ts) to the backend
// without changing the game, the same way boxingLink.ts does for boxing. The keeper dispatches
// complete MOTION_EVENTS rows on window 'motion-event' with sport 'GOALKEEPER' and a new
// session_id per shootout; this link:
//   1. creates the player and a server session per shootout (POST /api/players, /api/session/start sport 'goalkeeper'),
//   2. rewrites session_id/player_id to the server ids and queues SAVE/GOAL rows (2 s batches, retry, offline),
//   3. on the shootout summary (TICK with metrics.summary) flushes and calls /api/session/end,
//      falling back to a realistic mock when the API is down or VITE_API_URL is unset.
// TICKs stay local: the server stores only SAVE/GOAL.

import { createPlayer, finishSession, flushQueue, getLastPlayer, queueEvents, startSession, USE_MOCK } from './client';
import { pointsFor, serverSport } from './serverAdapter';
import type { MotionEvent, Player, RoundResult, RoundStats, SessionEndResponse } from './types';

const SPORT = 'GOALKEEPER' as const;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface ShootoutState {
  clientSessionId: string;
  serverSessionId: Promise<string | null>;
  startedAt: string;
  events: MotionEvent[];
  /** Unrounded arcade score so far: the engine rounds once per shootout, not per kick. */
  raw: number;
}

export interface ShootoutSummary {
  result: RoundResult;
  score: number;
  saves: number;
  goals: number;
  playerId: string;
  /** Resolves with the coach card + goalkeeper leaderboard. Never rejects. */
  data: Promise<SessionEndResponse>;
}

export interface GoalkeeperLink {
  readonly player: Player | null;
  /** Called after each shootout with the summary (data resolves later). */
  onShootoutEnd(cb: (s: ShootoutSummary) => void): void;
  dispose(): void;
}

/** Shootout score as the server sums it (same per-kick points as the engine's arcade score). */
export function scoreShootout(events: readonly MotionEvent[]): number {
  return Math.max(0, events.reduce((sum, e) => sum + pointsFor(e), 0));
}

function statsFor(evs: readonly MotionEvent[], bestSpeed: number): RoundStats {
  const saves = evs.filter((e) => e.event_type === 'SAVE');
  const speeds = evs.map((e) => e.peak_velocity).filter((v): v is number => v != null);
  const reactions = evs.map((e) => e.reaction_ms).filter((v): v is number => v != null);
  const left = saves.filter((e) => e.metrics.part === 'left').length;
  const right = saves.filter((e) => e.metrics.part === 'right').length;
  return {
    // RoundStats is boxing-shaped; for the keeper "punches" are kicks faced and "landed" are saves.
    punches: evs.length,
    landed: saves.length,
    byType: {},
    avgSpeed: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0,
    maxSpeed: bestSpeed || (speeds.length ? Math.max(...speeds) : 0),
    blocks: saves.length,
    dodges: 0,
    avgReactionMs: reactions.length ? Math.round(reactions.reduce((a, b) => a + b, 0) / reactions.length) : null,
    leftRightRatio: right ? Math.round((left / right) * 100) / 100 : null,
    bestCombo: 0,
  };
}

export function createGoalkeeperLink(opts: { displayName?: string } = {}): GoalkeeperLink {
  let player: Player | null = null;
  let round: ShootoutState | null = null;
  let disposed = false;
  /** Shootouts already sent to /api/session/end: late TICKs (pagehide flush) must not reopen them. */
  const ended = new Set<string>();
  const listeners: ((s: ShootoutSummary) => void)[] = [];
  const name = opts.displayName ?? getLastPlayer()?.display_name ?? 'Player';
  const playerReady: Promise<Player> = createPlayer(name.trim() || 'Player').then((p) => (player = p));

  function openRound(clientSessionId: string): ShootoutState {
    const serverSessionId = playerReady.then(async (p) => {
      if (USE_MOCK || !serverSport(SPORT)) return null;
      const s = await startSession(p, SPORT);
      return s.offline ? null : s.sessionId;
    });
    return { clientSessionId, serverSessionId, startedAt: new Date().toISOString(), events: [], raw: 0 };
  }

  function endRound(r: ShootoutState, summary: Record<string, unknown>): void {
    const counts = isRecord(summary.counts) ? summary.counts : {};
    const saves = num(counts.saves) ?? r.events.filter((e) => e.event_type === 'SAVE').length;
    const goals = num(counts.goals) ?? r.events.filter((e) => e.event_type === 'GOAL').length;
    const score = scoreShootout(r.events);
    const result: RoundResult = saves === goals ? 'DRAW' : saves > goals ? 'WIN' : 'LOSS';
    const stats = statsFor(r.events, num(summary.bestSpeed) ?? 0);
    const data = (async () => {
      const p = await playerReady;
      const sid = await r.serverSessionId;
      await flushQueue();
      return finishSession(
        {
          session_id: sid ?? r.clientSessionId,
          player_id: p.player_id,
          display_name: p.display_name,
          sport: SPORT,
          started_at: r.startedAt,
          ended_at: new Date().toISOString(),
          final_score: score,
          result,
          avg_inference_fps: null,
          stats,
        },
        sid,
      );
    })();
    const s: ShootoutSummary = { result, score, saves, goals, playerId: player?.player_id ?? '', data };
    for (const cb of listeners) cb(s);
  }

  const onEvent = (e: Event) => {
    const d: unknown = e instanceof CustomEvent ? e.detail : null;
    if (!isRecord(d) || d.sport !== SPORT || typeof d.session_id !== 'string' || typeof d.event_type !== 'string') return;
    if (ended.has(d.session_id)) return;
    if (!round || round.clientSessionId !== d.session_id) round = openRound(d.session_id);
    const r = round;
    const metrics = isRecord(d.metrics) ? d.metrics : {};

    if (d.event_type === 'TICK') {
      if (metrics.summary === true) {
        round = null; // the next shootout has a new session_id
        ended.add(r.clientSessionId);
        endRound(r, metrics);
      }
      return; // ticks stay local: the server has no TICK type
    }
    if (d.event_type !== 'SAVE' && d.event_type !== 'GOAL') return;

    // engine.ts endShootout sums the unrounded accuracy/2 and rounds the total once. Send each
    // save the change in the rounded running total, so SUM(points) on the server and the
    // leaderboard equal the score on the game's end screen exactly.
    let points: number | null = num(metrics.points);
    if (points === null && d.event_type === 'SAVE') {
      const reaction = num(d.reaction_ms);
      const acc = Math.max(0, Math.min(100, num(d.accuracy_score) ?? 0));
      const rawPts = 1000 + (reaction !== null && reaction < 450 ? 250 : 0) + (metrics.punch === true ? 150 : 0) + acc / 2;
      points = Math.round(r.raw + rawPts) - Math.round(r.raw);
      r.raw += rawPts;
    }

    const ev: MotionEvent = {
      event_id: String(d.event_id ?? crypto.randomUUID()),
      session_id: r.clientSessionId,
      player_id: String(d.player_id ?? ''),
      sport: SPORT,
      event_ts: String(d.event_ts ?? new Date().toISOString()),
      round_ms: Number(d.round_ms ?? 0),
      event_type: d.event_type,
      peak_velocity: num(d.peak_velocity),
      reaction_ms: num(d.reaction_ms),
      accuracy_score: num(d.accuracy_score),
      symmetry_ratio: num(d.symmetry_ratio),
      // A copy: other 'motion-event' listeners (shell records) see the game's own metrics.
      metrics: points === null ? metrics : { ...metrics, points },
    };
    r.events.push(ev);

    // Rewrite to server ids once known, then queue.
    void Promise.all([r.serverSessionId, playerReady]).then(([sid, p]) => {
      queueEvents([{ ...ev, session_id: sid ?? ev.session_id, player_id: p.player_id }]);
    });
  };
  window.addEventListener('motion-event', onEvent);

  return {
    get player() {
      return player;
    },
    onShootoutEnd(cb) {
      listeners.push(cb);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('motion-event', onEvent);
      listeners.length = 0;
      void flushQueue();
    },
  };
}
