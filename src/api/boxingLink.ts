// Bridges the boxing game's own telemetry (src/sports/boxing/telemetry.ts) to the backend
// without changing the game. The game dispatches complete MOTION_EVENTS rows on
// window 'motion-event' with locally made session/player ids; this link:
//   1. creates the player and a server session per round (POST /api/players, /api/session/start),
//   2. rewrites session_id/player_id to the server ids and queues the rows (2 s batches, retry, offline),
//   3. at round end flushes, calls /api/session/end and returns coach card + leaderboard,
//      falling back to a realistic mock when the API is down.

import { createPlayer, finishSession, flushQueue, queueEvents, startSession, USE_MOCK } from './client';
import { pointsFor, serverSport } from './serverAdapter';
import type { Player, PunchType, RoundResult as ApiRoundResult, RoundStats, SessionEndResponse, MotionEvent } from './types';
import type { RoundResult as GameRoundResult } from '../sports/boxing/types.ts';

const SPORT = 'BOXING' as const;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface RoundState {
  clientSessionId: string;
  serverSessionId: Promise<string | null>;
  startedAt: string;
  events: MotionEvent[];
  ticks: number;
  guardTicks: number;
  combo: number;
  bestCombo: number;
}

export interface RoundSummary {
  result: ApiRoundResult;
  score: number;
  stats: RoundStats;
  playerId: string;
  /** Resolves with the coach card + leaderboard. Never rejects. */
  data: Promise<SessionEndResponse>;
}

export interface BoxingLink {
  /** Set or change the player. Safe to call before every round. */
  setPlayer(displayName: string): Promise<Player>;
  readonly player: Player | null;
  /** Close the current round. Call from the round-end hook. */
  endRound(result: GameRoundResult): RoundSummary;
  dispose(): void;
}

/** Score shown to the player: the same per-event points the server sums for the leaderboard. */
export function scoreRound(events: readonly MotionEvent[]): number {
  return Math.max(0, events.reduce((sum, e) => sum + pointsFor(e), 0));
}

function toApiResult(r: GameRoundResult): ApiRoundResult {
  if (r.outcome === 'ko-win') return 'KO_WIN';
  if (r.outcome === 'ko-loss') return 'KO_LOSS';
  if (r.playerHp === r.droneHp) return 'DRAW';
  return r.playerHp > r.droneHp ? 'WIN' : 'LOSS';
}

export function createBoxingLink(opts: { displayName?: string } = {}): BoxingLink {
  let player: Player | null = null;
  let round: RoundState | null = null;
  const loadPlayer = (displayName: string): Promise<Player> =>
    createPlayer(displayName.trim() || 'Player').then((p) => (player = p));
  let playerReady = loadPlayer(opts.displayName ?? 'Player');

  function setPlayer(displayName: string): Promise<Player> {
    playerReady = loadPlayer(displayName);
    return playerReady;
  }

  function openRound(clientSessionId: string): RoundState {
    const serverSessionId = playerReady.then(async (p) => {
      if (USE_MOCK || !serverSport(SPORT)) return null;
      const s = await startSession(p, SPORT);
      return s.offline ? null : s.sessionId;
    });
    return { clientSessionId, serverSessionId, startedAt: new Date().toISOString(), events: [], ticks: 0, guardTicks: 0, combo: 0, bestCombo: 0 };
  }

  const onEvent = (e: Event) => {
    const d: unknown = e instanceof CustomEvent ? e.detail : null;
    if (!isRecord(d) || d.sport !== SPORT || typeof d.session_id !== 'string' || typeof d.event_type !== 'string') return;
    if (!round || round.clientSessionId !== d.session_id) round = openRound(d.session_id);
    const r = round;
    const metrics = isRecord(d.metrics) ? d.metrics : {};

    if (d.event_type === 'TICK') {
      if (metrics.summary !== true && typeof metrics.guard === 'boolean') {
        r.ticks++;
        if (metrics.guard) r.guardTicks++;
      }
      return; // ticks stay local: the server has no TICK type
    }

    const ev: MotionEvent = {
      event_id: String(d.event_id ?? crypto.randomUUID()),
      session_id: r.clientSessionId,
      player_id: String(d.player_id ?? ''),
      sport: SPORT,
      event_ts: String(d.event_ts ?? new Date().toISOString()),
      round_ms: Number(d.round_ms ?? 0),
      event_type: d.event_type as MotionEvent['event_type'],
      peak_velocity: typeof d.peak_velocity === 'number' ? d.peak_velocity : null,
      reaction_ms: typeof d.reaction_ms === 'number' ? d.reaction_ms : null,
      accuracy_score: typeof d.accuracy_score === 'number' ? d.accuracy_score : null,
      symmetry_ratio: typeof d.symmetry_ratio === 'number' ? d.symmetry_ratio : null,
      metrics,
    };
    r.events.push(ev);
    if (ev.event_type === 'PUNCH') {
      if (metrics.landed === false) r.combo = 0;
      else r.bestCombo = Math.max(r.bestCombo, ++r.combo);
    }

    // Rewrite to server ids once known, then queue.
    void Promise.all([r.serverSessionId, playerReady]).then(([sid, p]) => {
      queueEvents([{ ...ev, session_id: sid ?? ev.session_id, player_id: p.player_id }]);
    });
  };
  window.addEventListener('motion-event', onEvent);

  function statsFor(r: RoundState | null, g: GameRoundResult): RoundStats {
    const evs = r?.events ?? [];
    const punches = evs.filter((e) => e.event_type === 'PUNCH');
    const speeds = punches.map((e) => e.peak_velocity).filter((v): v is number => v != null);
    const reactions = evs.map((e) => e.reaction_ms).filter((v): v is number => v != null);
    const left = punches.filter((e) => e.metrics.hand === 'left').length;
    const right = punches.filter((e) => e.metrics.hand === 'right').length;
    const byType: Partial<Record<PunchType, number>> = {};
    for (const k of ['jab', 'cross', 'hook', 'uppercut'] as const) {
      if (g.counts[k]) byType[k.toUpperCase() as PunchType] = g.counts[k];
    }
    return {
      punches: g.counts.total,
      landed: g.counts.landed,
      byType,
      avgSpeed: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0,
      maxSpeed: g.bestSpeed,
      blocks: g.blocks,
      dodges: g.dodges,
      avgReactionMs: reactions.length ? Math.round(reactions.reduce((a, b) => a + b, 0) / reactions.length) : null,
      leftRightRatio: right ? Math.round((left / right) * 100) / 100 : null,
      bestCombo: r?.bestCombo ?? 0,
      guardPct: r && r.ticks ? Math.round((r.guardTicks / r.ticks) * 100) : null,
      slips: g.dodges,
    };
  }

  return {
    setPlayer,
    get player() {
      return player;
    },
    endRound(g) {
      const r = round;
      round = null; // the next event (new session_id after startRound) opens a fresh round
      const stats = statsFor(r, g);
      const score = scoreRound(r?.events ?? []);
      const result = toApiResult(g);
      const data = (async () => {
        const p = await playerReady;
        const sid = r ? await r.serverSessionId : null;
        await flushQueue();
        return finishSession(
          {
            session_id: sid ?? r?.clientSessionId ?? crypto.randomUUID(),
            player_id: p.player_id,
            display_name: p.display_name,
            sport: SPORT,
            started_at: r?.startedAt ?? new Date().toISOString(),
            ended_at: new Date().toISOString(),
            final_score: score,
            result,
            avg_inference_fps: null,
            stats,
          },
          sid,
        );
      })();
      return { result, score, stats, playerId: player?.player_id ?? '', data };
    },
    dispose() {
      window.removeEventListener('motion-event', onEvent);
      void flushQueue();
    },
  };
}
