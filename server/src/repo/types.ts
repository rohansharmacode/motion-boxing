import type {
  Benchmark,
  LeaderboardRow,
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

  leaderboard(limit: number): Promise<LeaderboardRow[]>;
  playerSessions(playerId: string, limit: number): Promise<SessionSummary[]>;
  playerMetrics(playerId: string): Promise<PlayerMetrics>;
  benchmarks(sport: string): Promise<Benchmark[]>;

  /**
   * Runs an already-guarded SELECT under the read-only role with a hard row limit
   * (POST /api/ask only).
   */
  runReadOnlyQuery(sql: string, rowLimit: number): Promise<Record<string, unknown>[]>;

  close(): Promise<void>;
}
