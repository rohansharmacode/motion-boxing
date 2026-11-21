// Shared types between the game, the UI and the backend.
// Field names match the Snowflake MOTION_EVENTS / SESSIONS tables (snake_case) so the
// backend can insert rows without remapping. See src/api/CONTRACT.md.

export type Sport = 'BOXING' | 'GOALKEEPER' | 'ARCHERY';

export type MotionEventType =
  | 'PUNCH'
  | 'BLOCK'
  | 'DODGE'
  | 'SAVE'
  | 'GOAL'
  | 'ARROW_RELEASE'
  | 'TICK';

export type PunchType = 'JAB' | 'CROSS' | 'HOOK' | 'UPPERCUT';

/**
 * What a sport engine dispatches. The client fills in ids, sport and timestamps.
 *
 *   window.dispatchEvent(new CustomEvent('motion-event', { detail }))
 *   // or: import { emitMotionEvent } from './api/client'
 */
export interface MotionEventDetail {
  event_type: MotionEventType;
  /** Shoulder-widths per second. */
  peak_velocity?: number;
  /** ms from opponent telegraph to player response. */
  reaction_ms?: number;
  /** 0..100 */
  accuracy_score?: number;
  /** L/R balance 0..1 */
  symmetry_ratio?: number;
  /** Sport-specific detail, e.g. { punchType: 'HOOK', hand: 'L', elbowAngle: 112, landed: true }. */
  metrics?: Record<string, unknown>;
  /** Override round time; otherwise the client computes it from the round start. */
  round_ms?: number;
}

/** One MOTION_EVENTS row, as sent in POST /api/events. */
export interface MotionEvent extends Required<Pick<MotionEventDetail, 'event_type'>> {
  event_id: string;
  session_id: string;
  player_id: string;
  sport: Sport;
  /** ISO-8601 UTC. */
  event_ts: string;
  round_ms: number;
  peak_velocity: number | null;
  reaction_ms: number | null;
  accuracy_score: number | null;
  symmetry_ratio: number | null;
  metrics: Record<string, unknown>;
}

export interface EventsBatchRequest {
  events: MotionEvent[];
}

export type RoundResult = 'WIN' | 'LOSS' | 'KO_WIN' | 'KO_LOSS' | 'DRAW';

/** Local stats the client computes from the events it saw. Sent to the backend as a hint. */
export interface RoundStats {
  punches: number;
  landed: number;
  byType: Partial<Record<PunchType, number>>;
  avgSpeed: number;
  maxSpeed: number;
  blocks: number;
  dodges: number;
  avgReactionMs: number | null;
  leftRightRatio: number | null;
  bestCombo: number;
  /** Share of the round with both gloves up, 0..100 (from the motion lib's guardUptime). */
  guardPct?: number | null;
  /** DODGE events that were slips (anything not tagged metrics.kind === 'duck'). */
  slips?: number;
  /** DODGE events tagged metrics.kind === 'duck'. */
  ducks?: number;
  /** Last fatigueTrend from the motion lib: 0.2 = late punches 20% slower than early ones. */
  fatigueTrend?: number | null;
}

export interface SessionEndRequest {
  session_id: string;
  player_id: string;
  display_name: string;
  sport: Sport;
  started_at: string;
  ended_at: string;
  final_score: number;
  result: RoundResult;
  avg_inference_fps: number | null;
  stats: RoundStats;
}

export interface CoachCard {
  /** One-line summary of the round. */
  headline: string;
  /** Exactly 3 tips. */
  tips: string[];
  drill: { name: string; description: string };
  badge: { name: string; description: string };
}

export interface LeaderboardEntry {
  rank: number;
  player_id: string;
  display_name: string;
  sport: Sport;
  score: number;
  max_speed?: number | null;
}

export interface SessionEndResponse {
  coach: CoachCard;
  leaderboard: LeaderboardEntry[];
  form_score?: number | null;
  /** Set by the client, not the backend: where the data came from. */
  source?: 'live' | 'mock';
}

// ---- v2 additions: players, session start, leaderboard ----

export interface Player {
  player_id: string;
  display_name: string;
  created_at?: string;
}

/** POST /api/players {display_name} -> Player */
export interface CreatePlayerRequest {
  display_name: string;
}

/** POST /api/session/start -> StartSessionResponse */
export interface StartSessionRequest {
  player_id: string;
  display_name: string;
  sport: Sport;
}
export interface StartSessionResponse {
  session_id: string;
  started_at: string;
}

/** GET /api/leaderboard?sport=BOXING&limit=10 -> LeaderboardResponse */
export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  /** Set by the client: where the data came from. */
  source?: 'live' | 'mock';
}

export type ApiSource = 'live' | 'mock';

/** getApiStatus(): what the client is doing right now. */
export interface ApiStatus {
  /** live = API configured and last call worked; offline = API configured but failing / no network; mock = no API. */
  mode: 'live' | 'mock' | 'offline';
  /** Events waiting to be sent (memory + localStorage outbox). */
  queued: number;
}

// ---- live Snowflake counter + highlights feed ----

/** Snapshot of event uploads since page load. */
export interface UploadStats {
  /** 'live': talking to the API; 'offline': API failing, rows wait in the outbox; 'mock': no API configured. */
  mode: ApiStatus['mode'];
  /** Rows the server accepted (2xx) since page load. */
  sent: number;
  /** Rows captured by the game since page load (sent + waiting, or all of them in mock mode). */
  captured: number;
  /** Rows waiting in the outbox. */
  queued: number;
  /** Size of the last accepted batch, 0 if none yet. */
  lastBatch: number;
  /** Date.now() of the last accepted batch, 0 if none yet. */
  lastSentAt: number;
}

/** One row of GET /api/highlights (Snowflake Streams + Tasks: T_HIGHLIGHTS). */
export interface Highlight {
  highlight_id: string;
  created_at: string;
  kind: string;
  player_id: string;
  name: string;
  session_id: string;
  value: number | null;
  unit: string;
  message: string;
}

export interface HighlightsResponse {
  /** False when the server has no highlights table yet. */
  available: boolean;
  highlights: Highlight[];
  source?: ApiSource;
}
