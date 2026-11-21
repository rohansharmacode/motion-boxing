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

/** Cortex Search drills the coach card was grounded on (sql/PLUS_CONTRACT.md). */
export interface CoachGrounding {
  source: 'cortex_search' | 'mock' | 'fallback';
  drills: { drill_id: string; title: string }[];
}

/** Optional extras of a coach card; only the front-end response shape exposes them. */
export interface CoachMeta {
  focus: string | null;
  grounding: CoachGrounding;
  /** True when the card came from AI_COMPLETE structured output. */
  structured: boolean;
  headline?: string | null;
}

/** What is stored in SESSIONS.ai_coach_json (the card plus provenance). */
export interface StoredCoach extends CoachCard {
  fallback: boolean;
  model: string;
  generated_at: string;
  focus?: string | null;
  grounding?: CoachGrounding;
  structured?: boolean;
  headline?: string | null;
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
  /** Cortex was slower than COACH_FAST_MS: `coach` is provisional; poll GET /api/session/:id/coach. */
  warming_up?: boolean;
  /** Internal: merged into the front-end coach card, stripped from the original response shape. */
  coach_meta?: CoachMeta;
}

// ---------------------------------------------------------------------------------------------
// Snowflake Plus endpoints (sql/PLUS_CONTRACT.md "New server endpoints")
// ---------------------------------------------------------------------------------------------

/** Style vector components, ALWAYS in this order. */
export const STYLE_COMPONENTS = ['speed', 'reaction', 'accuracy', 'guard', 'symmetry', 'endurance'] as const;
export type StyleComponent = (typeof STYLE_COMPONENTS)[number];
export type StyleComponents = Record<StyleComponent, number>;

export interface PlayerStyle {
  player_id: string;
  available: boolean;
  /** 0..100 each; null when the player has no punches yet. */
  components: StyleComponents | null;
  pro_similarity_pct: number | null;
  twin: { player_id: string; name: string; similarity_pct: number } | null;
  scouting: { fighting_style: string; scouting_report: string; updated_at: string | null } | null;
}

export interface ProgressPoint {
  session_index: number;
  session_id: string;
  score: number | null;
  avg_speed: number | null;
  accuracy_pct: number | null;
}

export interface PlayerProgress {
  player_id: string;
  available: boolean;
  sessions: number;
  best_score: number | null;
  last_score: number | null;
  speed_trend_mps_per_session: number | null;
  score_trend_per_session: number | null;
  accuracy_trend_pct_per_session: number | null;
  reaction_trend_ms_per_session: number | null;
  improving: boolean;
  history: ProgressPoint[];
}

export const HIGHLIGHT_KINDS = ['speed_record', 'reaction_record', 'personal_best_speed', 'punch_milestone', 'suspicious_speed'] as const;
export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number];

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

export interface HighlightsFeed {
  available: boolean;
  highlights: Highlight[];
}

export type ProbeStatus = 'up' | 'missing' | 'error' | 'mock' | 'unknown' | 'streamlit';
export interface FeatureProbe {
  status: ProbeStatus;
  detail?: string;
}

/** Repo-side probes for GET /api/snowflake/status (Cortex state comes from the Cortex object). */
export interface RepoFeatureProbes {
  dynamic_tables: FeatureProbe;
  cortex_search: FeatureProbe;
  streams_tasks: FeatureProbe;
  vectors: FeatureProbe;
  player_form_last_refresh?: string | null;
}
