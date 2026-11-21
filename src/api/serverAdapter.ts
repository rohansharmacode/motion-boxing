// Adapter between the client's MOTION_EVENTS-style shapes and Person B's Express server
// (server/src/schemas.ts + server/src/types.ts). The server is the source of truth: if
// its schema changes, change this file only.
//
// Server shape summary:
//   POST /api/players        { name }                         -> { player_id }
//   POST /api/session/start  { player_id, sport: 'boxing' | 'goalkeeper' | 'archery' } -> { session_id }
//   POST /api/events         [ ServerEvent, ... ] (bare array) -> 202 { accepted, queued }
//   POST /api/session/end    { session_id }                   -> { session_id, stats, coach: { tips[3], drill, badge, summary }, fallback }
//   GET  /api/leaderboard?sport=boxing|goalkeeper|archery      -> [ { rank, player_id, name, score, fastest_punch, best_reaction_ms } ]
//
// Goalkeeper SAVE/GOAL -> event_type 'save' | 'goal' (sport 'goalkeeper'); archery ARROW_RELEASE ->
// 'arrow' (sport 'archery'). metrics go into payload as for boxing (zone, ring, dx, dy read by SQL).

import type { CoachCard, LeaderboardEntry, MotionEvent, Sport } from './types';

/** Sports the server accepts, keyed by client sport. Others are kept local-only. */
const SERVER_SPORT: Partial<Record<Sport, string>> = { BOXING: 'boxing', GOALKEEPER: 'goalkeeper', ARCHERY: 'archery' };

export function serverSport(sport: Sport): string | null {
  return SERVER_SPORT[sport] ?? null;
}

type ServerEventType = 'jab' | 'cross' | 'hook' | 'uppercut' | 'block' | 'save' | 'goal' | 'arrow';
const PUNCH_TYPES: readonly ServerEventType[] = ['jab', 'cross', 'hook', 'uppercut'];

export interface ServerEvent {
  session_id: string;
  player_id: string;
  sport: string;
  event_ts: string;
  event_type: ServerEventType;
  /** Always set for boxing; null for a goalkeeper torso save / goal or an archery event without a hand. */
  hand: 'L' | 'R' | null;
  /** The server calls it speed_mps; we send shoulder-widths/s (see payload.speed_unit). */
  speed_mps: number;
  accuracy: number | null;
  reaction_ms: number | null;
  guard_up: boolean | null;
  points: number;
  payload: Record<string, unknown>;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Map one client event to the server's event, or null if the server has no column for it
 * (DODGE/TICK/non-boxing). Dropped events still count in the client's own stats().
 */
export function toServerEvent(ev: MotionEvent): ServerEvent | null {
  const sport = serverSport(ev.sport);
  if (!sport) return null;
  const m = ev.metrics;
  if (ev.event_type === 'SAVE' || ev.event_type === 'GOAL' || ev.event_type === 'ARROW_RELEASE') return toMultiSportEvent(ev, sport);

  let type: ServerEventType;
  if (ev.event_type === 'PUNCH') {
    const t = String(m.punchType ?? '').toLowerCase() as ServerEventType;
    if (!PUNCH_TYPES.includes(t)) return null;
    type = t;
  } else if (ev.event_type === 'BLOCK') {
    type = 'block';
  } else {
    return null; // server has no slip/duck/tick type yet
  }

  const hand: 'L' | 'R' = m.hand === 'L' || m.hand === 'left' ? 'L' : 'R';
  const speed = clamp(Number(ev.peak_velocity ?? 0) || 0, 0, 100);
  const points = pointsFor(ev);

  return {
    session_id: ev.session_id,
    player_id: ev.player_id,
    sport,
    event_ts: ev.event_ts,
    event_type: type,
    hand,
    speed_mps: Math.round(speed * 100) / 100,
    accuracy: ev.accuracy_score == null ? null : clamp(ev.accuracy_score / 100, 0, 1),
    reaction_ms: ev.reaction_ms == null ? null : clamp(ev.reaction_ms, 0, 60_000),
    guard_up: type === 'block' ? true : typeof m.guardUp === 'boolean' ? m.guardUp : null,
    points,
    payload: { ...m, client_event_id: ev.event_id, round_ms: ev.round_ms, symmetry_ratio: ev.symmetry_ratio, speed_unit: 'SW/s' },
  };
}

const sideHand = (v: unknown): 'L' | 'R' | null =>
  v === 'L' || v === 'left' ? 'L' : v === 'R' || v === 'right' ? 'R' : null;

/** Goalkeeper SAVE/GOAL and archery ARROW_RELEASE (server: sql/PLUS_CONTRACT.md "Multi-sport"). */
function toMultiSportEvent(ev: MotionEvent, sport: string): ServerEvent | null {
  const m = ev.metrics;
  const keeper = ev.event_type === 'SAVE' || ev.event_type === 'GOAL';
  if ((keeper && sport !== 'goalkeeper') || (!keeper && sport !== 'archery')) return null;
  const speed = clamp(Number(ev.peak_velocity ?? 0) || 0, 0, 100);
  return {
    session_id: ev.session_id,
    player_id: ev.player_id,
    sport,
    event_ts: ev.event_ts,
    event_type: ev.event_type === 'SAVE' ? 'save' : ev.event_type === 'GOAL' ? 'goal' : 'arrow',
    // Keeper: the glove that saved it (metrics.part); archery: the bow hand when the game reports it.
    hand: keeper ? sideHand(m.part) : sideHand(m.bowHand ?? m.hand),
    speed_mps: Math.round(speed * 100) / 100,
    accuracy: ev.accuracy_score == null ? null : clamp(ev.accuracy_score / 100, 0, 1),
    reaction_ms: ev.reaction_ms == null ? null : clamp(ev.reaction_ms, 0, 60_000),
    guard_up: null,
    points: pointsFor(ev),
    payload: { ...m, client_event_id: ev.event_id, round_ms: ev.round_ms, symmetry_ratio: ev.symmetry_ratio, speed_unit: 'SW/s' },
  };
}

/** Archery ring 0..10 from the first of these metrics within range, else accuracy_score / 10. */
function archeryRing(ev: MotionEvent): number | null {
  for (const k of ['ring', 'ringScore', 'rings', 'arrowScore', 'score']) {
    const v = ev.metrics[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10) return v;
  }
  return ev.accuracy_score == null ? null : Math.round(clamp(ev.accuracy_score, 0, 100) / 10);
}

/**
 * Points for one event. The server's score is the sum of these, so the game uses the same
 * function for the score it shows: header and leaderboard always agree.
 * Goalkeeper: the engine's arcade score per kick (save 1000, +250 reaction < 450 ms, +150 punch
 * clearance, + accuracy/2; goal 0). Archery: the ring score 0..10.
 */
export function pointsFor(ev: MotionEvent): number {
  const m = ev.metrics;
  if (typeof m.points === 'number') return Math.round(clamp(m.points, -10_000, 10_000));
  if (ev.event_type === 'SAVE') {
    let p = 1000;
    if (ev.reaction_ms != null && ev.reaction_ms < 450) p += 250;
    if (m.punch === true) p += 150;
    return p + Math.round(clamp(Number(ev.accuracy_score ?? 0) || 0, 0, 100) / 2);
  }
  if (ev.event_type === 'GOAL') return 0;
  if (ev.event_type === 'ARROW_RELEASE') return Math.round(archeryRing(ev) ?? 0);
  if (ev.event_type === 'BLOCK') return 25;
  if (ev.event_type !== 'PUNCH' || m.landed === false) return 0;
  const speed = clamp(Number(ev.peak_velocity ?? 0) || 0, 0, 100);
  return Math.round(50 + speed * 10 + (m.counter === true ? 50 : 0));
}

/** Server coach card -> client coach card. Also accepts the client's own shape. */
export function parseCoach(v: unknown): CoachCard | null {
  if (!isRecord(v) || !Array.isArray(v.tips)) return null;
  const named = (x: unknown, fallbackName: string) =>
    isRecord(x)
      ? { name: String(x.name ?? fallbackName), description: String(x.description ?? '') }
      : splitNamed(String(x ?? ''), fallbackName);
  return {
    headline: String(v.headline ?? v.summary ?? ''),
    tips: v.tips.map(String).slice(0, 3),
    drill: named(v.drill, 'Drill'),
    badge: named(v.badge, 'Badge'),
  };
}

/** "Guard-Return Jabs: 3 rounds of 30 s..." -> { name, description }. */
function splitNamed(s: string, fallbackName: string) {
  const m = /^(.{2,40}?)\s*[:–—-]\s+(.+)$/s.exec(s.trim());
  if (m) return { name: m[1], description: m[2] };
  return s.length <= 40 ? { name: s || fallbackName, description: '' } : { name: fallbackName, description: s };
}

/** Server default SHOULDER_WIDTH_M: it stores speeds in m/s, the UI shows shoulder-widths/s. */
const SHOULDER_WIDTH_M = 0.4;

/** Server leaderboard rows (or the client's own shape) -> LeaderboardEntry[]. */
export function parseLeaderboard(v: unknown, sport: Sport): LeaderboardEntry[] | null {
  const rows = isRecord(v) ? v.entries : v;
  if (!Array.isArray(rows)) return null;
  return rows.filter(isRecord).map((e, i) => {
    const speed = e.max_speed ?? e.fastest_punch;
    return {
      rank: typeof e.rank === 'number' ? e.rank : i + 1,
      player_id: String(e.player_id ?? ''),
      display_name: String(e.display_name ?? e.name ?? 'Player'),
      sport: typeof e.sport === 'string' && e.sport.toUpperCase() in SERVER_SPORT ? (e.sport.toUpperCase() as Sport) : sport,
      score: Number(e.score ?? 0) || 0,
      max_speed: speed == null ? null : Math.round((Number(speed) / SHOULDER_WIDTH_M) * 10) / 10,
    };
  });
}
