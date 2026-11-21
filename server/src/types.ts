// Domain types. Column / field names follow sql/CONTRACT.md exactly.

export const SPORT = 'boxing' as const;
export type Sport = typeof SPORT;

export const EVENT_TYPES = ['jab', 'cross', 'hook', 'uppercut', 'block'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const PUNCH_TYPES = ['jab', 'cross', 'hook', 'uppercut'] as const;
/** Defensive moves: stored in MOTION_EVENTS but not counted as punches or in the punch mix. */
export const DEFENSE_TYPES = ['slip', 'duck'] as const;
export const STORED_EVENT_TYPES = [...EVENT_TYPES, ...DEFENSE_TYPES] as const;
export type StoredEventType = (typeof STORED_EVENT_TYPES)[number];

export type Hand = 'L' | 'R';

/** One row of MOTION_EVENTS as the server writes it. */
export interface MotionEvent {
  event_id: string;
  session_id: string;
  player_id: string;
  sport: string;
  /** ISO-8601 UTC, e.g. 2026-11-21T12:00:00.123Z (stored as TIMESTAMP_NTZ in UTC). */
  event_ts: string;
  event_type: StoredEventType;
  hand: Hand;
  speed_mps: number;
  accuracy: number | null;
  reaction_ms: number | null;
  guard_up: boolean | null;
  points: number;
  payload: Record<string, unknown> | null;
}

export interface Player {
  player_id: string;
  name: string;
}

/** The `stats` object of POST /api/session/end (and the SESSIONS summary columns). */
export interface SessionStats {
  score: number;
  total_punches: number;
  avg_speed: number | null;
  max_speed: number | null;
  avg_reaction_ms: number | null;
  best_reaction_ms: number | null;
  /** 0..1, same scale as MOTION_EVENTS.accuracy */
  accuracy: number | null;
}

/** Extra per-session aggregates; used only to give Cortex richer context. */
export interface SessionExtras {
  guard_pct: number | null;
  symmetry_pct: number | null;
  fatigue_drop_pct: number | null;
  punch_mix: Record<EventType, number>;
  total_events: number;
}

export interface SessionAggregate {
  stats: SessionStats;
  extras: SessionExtras;
}

export interface CoachCard {
  tips: [string, string, string];
  drill: string;
  badge: string;
  summary: string;
}

/** What is stored in SESSIONS.ai_coach_json (the card plus provenance). */
export interface StoredCoach extends CoachCard {
  fallback: boolean;
  model: string;
  generated_at: string;
  /** What the front end reported at round end (final_score, result, avg_inference_fps, stats). */
  client?: Record<string, unknown>;
}

export interface SessionRecord {
  session_id: string;
  player_id: string;
  sport: string;
  started_at: string;
  ended_at: string | null;
  /** Null until the session has been ended. */
  stats: SessionStats | null;
  coach: StoredCoach | null;
}

export interface SessionSummary {
  session_id: string;
  started_at: string;
  ended_at: string | null;
  score: number | null;
  total_punches: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  avg_reaction_ms: number | null;
  best_reaction_ms: number | null;
  accuracy: number | null;
  badge: string | null;
}

export const METRICS = [
  'punch_speed_mps',
  'reaction_ms',
  'accuracy_pct',
  'guard_pct',
  'symmetry_pct',
  'fatigue_drop_pct',
] as const;
export type MetricName = (typeof METRICS)[number];

/** Raw per-player metric values, in PRO_BENCHMARKS units. */
export type PlayerMetrics = Record<MetricName, number | null>;
export type Percentiles = Record<MetricName, number | null>;

export interface Benchmark {
  sport: string;
  metric: string;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  pro_avg: number | null;
  higher_is_better: boolean;
}

export interface LeaderboardRow {
  rank: number;
  player_id: string;
  name: string;
  score: number | null;
  fastest_punch: number | null;
  best_reaction_ms: number | null;
}

export interface SessionEndResult {
  session_id: string;
  stats: SessionStats;
  coach: CoachCard;
  fallback: boolean;
}
