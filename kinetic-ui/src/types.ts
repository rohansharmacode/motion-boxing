// API shapes shared with the real engine / Express + Snowflake API. Keep names exact.
export type Result = 'WIN' | 'LOSS' | 'KO_WIN' | 'KO_LOSS' | 'DRAW';
export type PunchType = 'JAB' | 'CROSS' | 'HOOK' | 'UPPERCUT';

/** hp 0-100, guardPct 0-100 */
export interface HudState {
  playerHp: number;
  opponentHp: number;
  timeLeftMs: number;
  round: number;
  combo: number;
  guardPct: number;
}

/** speed in SW/s (shoulder-widths per second), ~0-5 */
export interface PunchInfo {
  type?: PunchType;
  speed: number;
  landed?: boolean;
}

export interface CoachCard {
  headline: string;
  tips: [string, string, string];
  drill: { name: string; description: string };
  badge: { name: string; description: string };
  formScore: number;
  fallback: boolean;
}

export interface RoundStats {
  punches: number;
  accuracyPct: number;
  fastestPunch: number;
  bestReactionMs: number;
  guardPct: number;
}

export interface LeaderboardRow {
  rank: number;
  player_id: string;
  name: string;
  score: number;
  fastest_punch: number;
  best_reaction_ms: number;
}

/** each 1-99 */
export interface Percentiles {
  punch_speed_mps: number;
  reaction_ms: number;
  accuracy_pct: number;
  guard_pct: number;
  symmetry_pct: number;
  fatigue_drop_pct: number;
}

export type DataSource = 'live' | 'pending' | 'offline';

// ---- UI-only types (not part of the API contract) ----
export type SportId = 'boxing' | 'keeper' | 'bow';
export type CalibrationState =
  | 'searching'
  | 'too_close'
  | 'too_far'
  | 'off_centre'
  | 'low_light'
  | 'holding'
  | 'locked';
export type HudEvent = 'BLOCK' | 'SLIP' | 'HIT' | 'COUNTER' | 'KO';
export type CoachStatus = 'loading' | 'ready';
