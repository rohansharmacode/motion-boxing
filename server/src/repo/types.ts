import type { DrillSearchOptions, DrillSearchResult } from '../drills';
import type {
  Benchmark,
  HighlightsFeed,
  LeaderboardRow,
  PlayerProgress,
  PlayerStyle,
  RepoFeatureProbes,
  MotionEvent,
  Player,
  PlayerMetrics,
  SessionAggregate,
  SessionRecord,
  SessionStats,
  SessionSummary,
  StoredCoach,
} from '../types';

/**
 * Storage abstraction. SnowflakeRepo talks to MOTION_DB.PUBLIC; MemoryRepo keeps everything
 * in process (SNOWFLAKE_MOCK=1 and tests). Both implement the same metric definitions.
 */
export interface Repo {
  readonly mode: 'snowflake' | 'mock';

  /** Cheap connectivity check; must not throw. */
  ping(): Promise<boolean>;

  /** Runs a tiny query that needs the warehouse (SELECT 1 is answered without one), to keep it resumed. */
  warm(): Promise<void>;

  createPlayer(name: string): Promise<string>;
  getPlayer(playerId: string): Promise<Player | null>;

  createSession(playerId: string, sport: string): Promise<string>;

  /**
   * Front-end flow (client-generated ids): create the player if missing; when `name` is given,
   * also update the stored name. Never creates duplicates for an existing player_id.
   */
  ensurePlayer(playerId: string, name: string | null): Promise<void>;

  /** Front-end flow: create the session row if missing (no-op when it already exists). */
  ensureSession(sessionId: string, playerId: string, sport: string, startedAt: string | null): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;

  /**
   * Multi-row insert into MOTION_EVENTS. With `dedupe`, rows whose event_id already exists are
   * skipped (used on retries, in case a timed-out attempt actually committed).
   */
  insertEvents(events: MotionEvent[], opts?: { dedupe?: boolean }): Promise<void>;

  /** Session aggregate computed from MOTION_EVENTS (V_SESSION_STATS + extras). */
  aggregateSession(sessionId: string): Promise<SessionAggregate>;

  /**
   * Writes ended_at, the summary columns and ai_coach_json, only if the session has no coach card
   * yet. Returns false when another caller finalized it first.
   */
  finalizeSession(sessionId: string, stats: SessionStats, coach: StoredCoach): Promise<boolean>;

  /**
   * Best single-session score per player, top N. sport defaults to boxing (V_LEADERBOARD, unchanged);
   * goalkeeper/archery read V_LEADERBOARD_BY_SPORT (sql/multisport.sql), fastest_punch = fastest
   * glove / release speed.
   */
  leaderboard(limit: number, sport?: string): Promise<LeaderboardRow[]>;

  /** All MOTION_EVENTS rows of one session, oldest first (goalkeeper/archery coach card). */
  sessionEvents(sessionId: string): Promise<MotionEvent[]>;
  playerSessions(playerId: string, limit: number): Promise<SessionSummary[]>;
  playerMetrics(playerId: string): Promise<PlayerMetrics>;
  benchmarks(sport: string): Promise<Benchmark[]>;

  // --- Snowflake Plus (sql/PLUS_CONTRACT.md). Missing objects -> available:false, never a throw. ---

  /** V_PLAYER_STYLE + V_STYLE_TWINS + PLAYER_SCOUTING. */
  playerStyle(playerId: string): Promise<PlayerStyle>;
  /** PLAYER_PROGRESS + SESSION_SUMMARY history (oldest first, at most `historyLimit` latest sessions). */
  playerProgress(playerId: string, historyLimit: number): Promise<PlayerProgress>;
  /** V_HIGHLIGHTS_FEED, newest first. */
  highlights(limit: number): Promise<HighlightsFeed>;
  /** Independent short probes for GET /api/snowflake/status; never throws. */
  probeFeatures(timeoutMs: number): Promise<RepoFeatureProbes>;

  /**
   * Cortex Search over COACH_DRILLS (keyword search in mock mode). available:false when the
   * search service does not exist; other failures throw.
   */
  searchDrills(query: string, opts: DrillSearchOptions): Promise<DrillSearchResult>;

  /**
   * Runs an already-guarded SELECT under the read-only role with a hard row limit
   * (POST /api/ask only).
   */
  runReadOnlyQuery(sql: string, rowLimit: number): Promise<Record<string, unknown>[]>;

  close(): Promise<void>;
}
