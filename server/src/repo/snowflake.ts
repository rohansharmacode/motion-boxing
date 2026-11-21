import { randomUUID } from 'node:crypto';
import { drillSearchSql, parseSearchResponse, type DrillSearchOptions, type DrillSearchResult } from '../drills';
import type { Logger } from '../logger';
import { emptyMix, roundStats } from '../metrics';
import type { Bind, Row, SqlExecutor } from '../snowflake/executor';
import {
  EVENT_TYPES,
  type Benchmark,
  type FeatureProbe,
  type Highlight,
  type HighlightsFeed,
  type PlayerProgress,
  type PlayerStyle,
  type ProgressPoint,
  type RepoFeatureProbes,
  type LeaderboardRow,
  type MotionEvent,
  type Player,
  type PlayerMetrics,
  type SessionAggregate,
  type SessionRecord,
  type SessionStats,
  type SessionSummary,
  type StoredCoach,
} from '../types';
import { TimeoutError, errorMessage, num, round, toNtzString, withTimeout } from '../util';
import type { Repo } from './types';

// All TIMESTAMP_NTZ values are stored in UTC; read them back as ISO-8601 with a Z.
const TS = `'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'`;
const PUNCH = `LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut')`;
const EVENT_COLUMNS = 13;

// ---------------------------------------------------------------------------------------------
// SQL. Every value that comes from a request is a bind variable (?). The only interpolations
// are server-side constants (column lists, formats, integer limits validated in code).
// ---------------------------------------------------------------------------------------------

export const SQL = {
  ping: `SELECT 1 AS ok`,

  /** Needs the warehouse (filter + CURRENT_TIMESTAMP defeats metadata answers and the result cache). */
  warm: `SELECT COUNT(*) AS n FROM MOTION_EVENTS WHERE event_ts > DATEADD(minute, -1, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)`,

  insertPlayer: `INSERT INTO PLAYERS (player_id, name, created_at) SELECT ?, ?, TO_TIMESTAMP_NTZ(?)`,

  /** Insert-if-missing; a non-NULL name also renames (front end sends display_name at round end). */
  upsertPlayer: `
    MERGE INTO PLAYERS t
    USING (SELECT CAST(? AS VARCHAR) AS player_id, CAST(? AS VARCHAR) AS name, TO_TIMESTAMP_NTZ(?) AS created_at) s
    ON t.player_id = s.player_id
    WHEN MATCHED AND s.name IS NOT NULL AND (t.name IS NULL OR t.name <> s.name) THEN UPDATE SET name = s.name
    WHEN NOT MATCHED THEN INSERT (player_id, name, created_at) VALUES (s.player_id, COALESCE(s.name, 'Player'), s.created_at)`,

  /** Insert-if-missing for client-generated session ids. */
  ensureSession: `
    MERGE INTO SESSIONS t
    USING (SELECT CAST(? AS VARCHAR) AS session_id, CAST(? AS VARCHAR) AS player_id, CAST(? AS VARCHAR) AS sport,
                  TO_TIMESTAMP_NTZ(?) AS started_at) s
    ON t.session_id = s.session_id
    WHEN NOT MATCHED THEN INSERT (session_id, player_id, sport, started_at)
      VALUES (s.session_id, s.player_id, s.sport, s.started_at)`,

  getPlayer: `SELECT player_id, name FROM PLAYERS WHERE player_id = ? LIMIT 1`,

  insertSession: `INSERT INTO SESSIONS (session_id, player_id, sport, started_at) SELECT ?, ?, ?, TO_TIMESTAMP_NTZ(?)`,

  getSession: `
    SELECT session_id, player_id, sport,
           TO_VARCHAR(started_at, ${TS}) AS started_at,
           TO_VARCHAR(ended_at, ${TS})   AS ended_at,
           score, total_punches, avg_speed, max_speed, avg_reaction_ms, best_reaction_ms, accuracy,
           TO_JSON(ai_coach_json) AS ai_coach_json
    FROM SESSIONS WHERE session_id = ? LIMIT 1`,

  /** Multi-row INSERT ... SELECT FROM VALUES (VARIANT can't be bound inside INSERT ... VALUES). */
  insertEvents(rowCount: number, dedupe: boolean): string {
    const row = `(${Array.from({ length: EVENT_COLUMNS }, () => '?').join(', ')})`;
    const values = Array.from({ length: rowCount }, () => row).join(',\n      ');
    return `
    INSERT INTO MOTION_EVENTS
      (event_id, session_id, player_id, sport, event_ts, event_type, hand,
       speed_mps, accuracy, reaction_ms, guard_up, points, payload)
    SELECT v.event_id, v.session_id, v.player_id, v.sport, TO_TIMESTAMP_NTZ(v.event_ts), v.event_type, v.hand,
           v.speed_mps::FLOAT, v.accuracy::FLOAT, v.reaction_ms::FLOAT, v.guard_up::BOOLEAN, v.points::NUMBER,
           TRY_PARSE_JSON(v.payload)
    FROM VALUES
      ${values}
    AS v (event_id, session_id, player_id, sport, event_ts, event_type, hand,
          speed_mps, accuracy, reaction_ms, guard_up, points, payload)${
            dedupe
              ? `
    WHERE NOT EXISTS (SELECT 1 FROM MOTION_EVENTS e WHERE e.event_id = v.event_id AND e.session_id = v.session_id)`
              : ''
          }`;
  },

  /** Extras for the coach prompt (mix, L/R, quartile speeds); same rules as analytics.sql. */
  sessionExtrasCte: `
    x AS (
      SELECT
        COUNT(*) AS total_events,
        COUNT(CASE WHEN LOWER(event_type) = 'jab' THEN 1 END)      AS n_jab,
        COUNT(CASE WHEN LOWER(event_type) = 'cross' THEN 1 END)    AS n_cross,
        COUNT(CASE WHEN LOWER(event_type) = 'hook' THEN 1 END)     AS n_hook,
        COUNT(CASE WHEN LOWER(event_type) = 'uppercut' THEN 1 END) AS n_uppercut,
        COUNT(CASE WHEN LOWER(event_type) = 'block' THEN 1 END)    AS n_block,
        AVG(CASE WHEN ${PUNCH} AND guard_up IS NOT NULL THEN CASE WHEN guard_up THEN 100.0 ELSE 0.0 END END) AS x_guard_pct,
        COUNT(CASE WHEN ${PUNCH} AND UPPER(hand) = 'L' THEN 1 END) AS l_n,
        COUNT(CASE WHEN ${PUNCH} AND UPPER(hand) = 'R' THEN 1 END) AS r_n,
        AVG(CASE WHEN ${PUNCH} AND UPPER(hand) = 'L' THEN speed_mps END) AS l_speed,
        AVG(CASE WHEN ${PUNCH} AND UPPER(hand) = 'R' THEN speed_mps END) AS r_speed
      FROM MOTION_EVENTS WHERE session_id = ?
    ),
    q AS (
      SELECT
        AVG(CASE WHEN quartile = 1 THEN speed_mps END) AS q1_speed,
        AVG(CASE WHEN quartile = 4 THEN speed_mps END) AS q4_speed
      FROM (
        SELECT speed_mps,
               NTILE(4) OVER (ORDER BY event_ts, event_id) AS quartile,
               COUNT(*) OVER () AS n
        FROM MOTION_EVENTS
        WHERE session_id = ? AND ${PUNCH} AND speed_mps IS NOT NULL
      ) p
      WHERE n >= 8
    )`,

  /** Preferred: stats from the V_SESSION_STATS view (sql/analytics.sql) + extras. Binds: id, id, id. */
  get sessionAggregateFromView(): string {
    return `
    WITH v AS (
      SELECT score, total_punches, avg_speed, max_speed, avg_reaction_ms, best_reaction_ms, accuracy
      FROM V_SESSION_STATS WHERE session_id = ?
    ),
    ${SQL.sessionExtrasCte}
    SELECT v.*, x.*, q.* FROM x CROSS JOIN q LEFT JOIN v ON TRUE`;
  },

  /** Fallback when the view is missing: identical definitions, inline. Binds: id, id, id. */
  get sessionAggregateInline(): string {
    return `
    WITH v AS (
      SELECT
        COALESCE(SUM(COALESCE(points, 0)), 0)                         AS score,
        COUNT(CASE WHEN ${PUNCH} THEN 1 END)                          AS total_punches,
        AVG(CASE WHEN ${PUNCH} THEN speed_mps END)                    AS avg_speed,
        MAX(CASE WHEN ${PUNCH} THEN speed_mps END)                    AS max_speed,
        AVG(CASE WHEN reaction_ms > 0 THEN reaction_ms END)           AS avg_reaction_ms,
        MIN(CASE WHEN reaction_ms > 0 THEN reaction_ms END)           AS best_reaction_ms,
        AVG(CASE WHEN ${PUNCH} THEN accuracy END)                     AS accuracy
      FROM MOTION_EVENTS WHERE session_id = ?
    ),
    ${SQL.sessionExtrasCte}
    SELECT v.*, x.*, q.* FROM v CROSS JOIN x CROSS JOIN q`;
  },

  finalizeSession: `
    UPDATE SESSIONS SET
      ended_at = COALESCE(ended_at, SYSDATE()),
      score = ?, total_punches = ?, avg_speed = ?, max_speed = ?,
      avg_reaction_ms = ?, best_reaction_ms = ?, accuracy = ?,
      ai_coach_json = PARSE_JSON(?)
    WHERE session_id = ? AND ai_coach_json IS NULL`,

  leaderboardFromView(limit: number): string {
    return `
    SELECT rank, player_id, name, score, best_score, fastest_punch, best_reaction_ms
    FROM V_LEADERBOARD ORDER BY rank LIMIT ${limit}`;
  },

  /** Same logic as V_LEADERBOARD, used if the view is missing. */
  leaderboardInline(limit: number): string {
    return `
    WITH ev AS (
      SELECT session_id, player_id, speed_mps, reaction_ms, COALESCE(points, 0) AS points,
             CASE WHEN ${PUNCH} THEN 1 ELSE 0 END AS is_punch
      FROM MOTION_EVENTS
      WHERE player_id IS NOT NULL AND LOWER(COALESCE(sport, 'boxing')) = 'boxing'
    ),
    s AS (SELECT player_id, session_id, SUM(points) AS score FROM ev GROUP BY player_id, session_id),
    e AS (
      SELECT player_id,
             MAX(CASE WHEN is_punch = 1 THEN speed_mps END) AS fastest_punch,
             MIN(CASE WHEN reaction_ms > 0 THEN reaction_ms END) AS best_reaction_ms
      FROM ev GROUP BY player_id
    ),
    p AS (
      SELECT s.player_id, MAX(s.score) AS best_score, MAX(e.fastest_punch) AS fastest_punch,
             MIN(e.best_reaction_ms) AS best_reaction_ms
      FROM s JOIN e ON e.player_id = s.player_id GROUP BY s.player_id
    )
    SELECT ROW_NUMBER() OVER (ORDER BY p.best_score DESC NULLS LAST, p.fastest_punch DESC NULLS LAST,
                              p.best_reaction_ms ASC NULLS LAST, p.player_id) AS rank,
           p.player_id, COALESCE(n.name, 'Unknown') AS name, p.best_score AS score, p.best_score,
           ROUND(p.fastest_punch, 2) AS fastest_punch, ROUND(p.best_reaction_ms, 1) AS best_reaction_ms
    FROM p LEFT JOIN (SELECT player_id, MAX(name) AS name FROM PLAYERS GROUP BY player_id) n
      ON n.player_id = p.player_id
    ORDER BY rank LIMIT ${limit}`;
  },

  /** Goalkeeper/archery leaderboard from V_LEADERBOARD_BY_SPORT (sql/multisport.sql). Bind: sport. */
  sportLeaderboardFromView(limit: number): string {
    return `
    SELECT rank, player_id, name, score, best_score, max_speed, best_reaction_ms
    FROM V_LEADERBOARD_BY_SPORT WHERE sport = ? ORDER BY rank LIMIT ${limit}`;
  },

  /** Same logic as V_LEADERBOARD_BY_SPORT for one sport, used if the view is missing. Bind: sport. */
  sportLeaderboardInline(limit: number): string {
    return `
    WITH ev AS (
      SELECT session_id, player_id, speed_mps, reaction_ms, COALESCE(points, 0) AS points
      FROM MOTION_EVENTS
      WHERE player_id IS NOT NULL AND LOWER(COALESCE(sport, 'boxing')) = ?
    ),
    s AS (SELECT player_id, session_id, SUM(points) AS score FROM ev GROUP BY player_id, session_id),
    e AS (
      SELECT player_id,
             MAX(CASE WHEN speed_mps > 0 THEN speed_mps END) AS max_speed,
             MIN(CASE WHEN reaction_ms > 0 THEN reaction_ms END) AS best_reaction_ms
      FROM ev GROUP BY player_id
    ),
    p AS (
      SELECT s.player_id, MAX(s.score) AS best_score, MAX(e.max_speed) AS max_speed,
             MIN(e.best_reaction_ms) AS best_reaction_ms
      FROM s JOIN e ON e.player_id = s.player_id GROUP BY s.player_id
    )
    SELECT ROW_NUMBER() OVER (ORDER BY p.best_score DESC NULLS LAST, p.max_speed DESC NULLS LAST,
                              p.best_reaction_ms ASC NULLS LAST, p.player_id) AS rank,
           p.player_id, COALESCE(n.name, 'Unknown') AS name, p.best_score AS score, p.best_score,
           ROUND(p.max_speed, 2) AS max_speed, ROUND(p.best_reaction_ms, 1) AS best_reaction_ms
    FROM p LEFT JOIN (SELECT player_id, MAX(name) AS name FROM PLAYERS GROUP BY player_id) n
      ON n.player_id = p.player_id
    ORDER BY rank LIMIT ${limit}`;
  },

  sessionEvents: `
    SELECT event_id, session_id, player_id, sport, TO_VARCHAR(event_ts, ${TS}) AS event_ts, event_type, hand,
           speed_mps, accuracy, reaction_ms, guard_up, points, payload
    FROM MOTION_EVENTS WHERE session_id = ?
    ORDER BY event_ts, event_id LIMIT 1000`,

  playerSessions(limit: number): string {
    return `
    SELECT session_id,
           TO_VARCHAR(started_at, ${TS}) AS started_at,
           TO_VARCHAR(ended_at, ${TS})   AS ended_at,
           score, total_punches, avg_speed, max_speed, avg_reaction_ms, best_reaction_ms, accuracy,
           ai_coach_json:badge::STRING AS badge
    FROM SESSIONS WHERE player_id = ?
    ORDER BY started_at DESC NULLS LAST LIMIT ${limit}`;
  },

  /**
   * PLAYER_FORM (dynamic table, 1 min lag) plus the live punch count, so we can tell whether the
   * dynamic table has caught up with the player's latest events. Binds: id, id.
   */
  playerFormWithLiveCount: `
    WITH live AS (
      SELECT COUNT(CASE WHEN ${PUNCH} THEN 1 END) AS live_punches
      FROM MOTION_EVENTS
      WHERE player_id = ? AND LOWER(COALESCE(sport, 'boxing')) = 'boxing'
    )
    SELECT live.live_punches, f.punches, f.avg_speed, f.avg_reaction_ms, f.accuracy_pct,
           f.guard_pct, f.symmetry_pct, f.fatigue_drop_pct
    FROM live LEFT JOIN PLAYER_FORM f ON f.player_id = ?`,

  /** Same metric definitions as PLAYER_FORM, computed live. Binds: id. */
  playerMetricsInline: `
    WITH ev AS (
      SELECT session_id, event_id, event_ts, UPPER(hand) AS hand, speed_mps, accuracy, reaction_ms, guard_up,
             CASE WHEN ${PUNCH} THEN 1 ELSE 0 END AS is_punch
      FROM MOTION_EVENTS
      WHERE player_id = ? AND LOWER(COALESCE(sport, 'boxing')) = 'boxing'
    ),
    a AS (
      SELECT
        AVG(CASE WHEN is_punch = 1 THEN speed_mps END)            AS avg_speed,
        AVG(CASE WHEN reaction_ms > 0 THEN reaction_ms END)       AS avg_reaction_ms,
        AVG(CASE WHEN is_punch = 1 THEN accuracy END) * 100       AS accuracy_pct,
        AVG(CASE WHEN is_punch = 1 AND guard_up IS NOT NULL
                 THEN CASE WHEN guard_up THEN 100.0 ELSE 0.0 END END) AS guard_pct,
        COUNT(CASE WHEN is_punch = 1 AND hand = 'L' THEN 1 END)   AS l_n,
        COUNT(CASE WHEN is_punch = 1 AND hand = 'R' THEN 1 END)   AS r_n,
        AVG(CASE WHEN is_punch = 1 AND hand = 'L' THEN speed_mps END) AS l_speed,
        AVG(CASE WHEN is_punch = 1 AND hand = 'R' THEN speed_mps END) AS r_speed
      FROM ev
    ),
    f AS (
      SELECT AVG(CASE WHEN quartile = 1 THEN speed_mps END) AS q1_speed,
             AVG(CASE WHEN quartile = 4 THEN speed_mps END) AS q4_speed
      FROM (
        SELECT speed_mps,
               NTILE(4) OVER (PARTITION BY session_id ORDER BY event_ts, event_id) AS quartile,
               COUNT(*) OVER (PARTITION BY session_id) AS n
        FROM ev WHERE is_punch = 1 AND session_id IS NOT NULL AND speed_mps IS NOT NULL
      ) p
      WHERE n >= 8
    )
    SELECT a.*, f.* FROM a CROSS JOIN f`,

  benchmarks: `
    SELECT sport, metric, p25, p50, p75, p90, pro_avg, higher_is_better
    FROM PRO_BENCHMARKS WHERE sport = ?`,

  // --- Snowflake Plus objects (sql/pipelines.sql, sql/cortex.sql). Binds: player id. ---
  playerStyle: `
    SELECT player_id, name, c_speed, c_reaction, c_accuracy, c_guard, c_symmetry, c_endurance, pro_similarity_pct
    FROM V_PLAYER_STYLE WHERE player_id = ? LIMIT 1`,

  styleTwin: `
    SELECT twin_player_id, twin_name, similarity_pct
    FROM V_STYLE_TWINS WHERE player_id = ? LIMIT 1`,

  scouting: `
    SELECT fighting_style, scouting_report, TO_VARCHAR(updated_at, ${TS}) AS updated_at
    FROM PLAYER_SCOUTING WHERE player_id = ? LIMIT 1`,

  playerProgress: `
    SELECT sessions, best_score, last_score, speed_trend_mps_per_session, score_trend_per_session,
           accuracy_trend_pct_per_session, reaction_trend_ms_per_session, improving
    FROM PLAYER_PROGRESS WHERE player_id = ? LIMIT 1`,

  /** Latest `limit` sessions, returned oldest first. */
  progressHistory(limit: number): string {
    return `
    SELECT session_index, session_id, score, avg_speed, accuracy_pct FROM (
      SELECT session_index, session_id, score, avg_speed, accuracy_pct
      FROM SESSION_SUMMARY WHERE player_id = ?
      ORDER BY session_index DESC LIMIT ${limit}
    ) h ORDER BY session_index`;
  },

  highlights(limit: number): string {
    return `
    SELECT highlight_id, TO_VARCHAR(created_at, ${TS}) AS created_at, kind, player_id, name, session_id, value, unit, message
    FROM V_HIGHLIGHTS_FEED ORDER BY created_at DESC, highlight_id DESC LIMIT ${limit}`;
  },

  dynamicTableHistory: `
    SELECT name, state, TO_VARCHAR(CONVERT_TIMEZONE('UTC', refresh_end_time), ${TS}) AS refresh_end_time
    FROM TABLE(MOTION_DB.INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(NAME_PREFIX => 'MOTION_DB.PUBLIC.', RESULT_LIMIT => 100))
    ORDER BY refresh_end_time DESC NULLS LAST`,

  showDynamicTables: `SHOW DYNAMIC TABLES IN SCHEMA MOTION_DB.PUBLIC`,

  taskHistory: `
    SELECT name, state, TO_VARCHAR(CONVERT_TIMEZONE('UTC', completed_time), ${TS}) AS completed_time
    FROM TABLE(MOTION_DB.INFORMATION_SCHEMA.TASK_HISTORY(RESULT_LIMIT => 100))
    WHERE name IN ('T_HIGHLIGHTS', 'T_SCOUTING')
    ORDER BY scheduled_time DESC NULLS LAST`,

  showTasks: `SHOW TASKS IN SCHEMA MOTION_DB.PUBLIC`,

  vectorsProbe: `SELECT player_id, similarity_pct FROM V_STYLE_TWINS LIMIT 1`,

  /** Row-limit wrapper for already-guarded text-to-SQL output. `limit` is a server constant. */
  readOnlyWrap(innerSql: string, limit: number): string {
    return `SELECT * FROM (\n${innerSql}\n) LIMIT ${limit}`;
  },
};

function safeLimit(n: number, max = 1000): number {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(v, max);
}

/** Same formula as PLAYER_FORM.symmetry_pct. */
export function symmetryFromParts(lN: number | null, rN: number | null, lSpeed: number | null, rSpeed: number | null): number | null {
  const l = lN ?? 0;
  const r = rN ?? 0;
  if (l + r === 0) return null;
  const countSym = (100 * Math.min(l, r)) / Math.max(l, r);
  let speedSym: number;
  if (lSpeed === null || rSpeed === null) speedSym = 0;
  else if (Math.max(lSpeed, rSpeed) <= 0) speedSym = 100;
  else speedSym = (100 * Math.max(Math.min(lSpeed, rSpeed), 0)) / Math.max(lSpeed, rSpeed);
  return (countSym + speedSym) / 2;
}

export function fatigueFromParts(q1: number | null, q4: number | null): number | null {
  if (q1 === null || q4 === null || q1 <= 0) return null;
  return (100 * (q1 - q4)) / q1;
}

/**
 * "Object does not exist or not authorized" (code 002003) and friends: the optional PLUS objects
 * (sql/PLUS_CONTRACT.md) have not been created, or the role has no grant. Callers degrade to
 * available:false instead of failing.
 */
export function isMissingObjectError(err: unknown): boolean {
  const code = String((err as { code?: unknown } | null)?.code ?? '');
  if (code === '002003' || code === '390201') return true;
  return /does not exist or not authorized|does not exist|not authorized|unknown function|insufficient privileges/i.test(errorMessage(err));
}

function parseCoach(v: unknown): StoredCoach | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    const obj = typeof v === 'string' ? JSON.parse(v) : v;
    if (obj && typeof obj === 'object' && Array.isArray((obj as StoredCoach).tips)) return obj as StoredCoach;
  } catch {
    /* fall through */
  }
  return null;
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export class SnowflakeRepo implements Repo {
  readonly mode = 'snowflake' as const;
  /** Optional features already reported as missing (one warning each per process). */
  private readonly warnedMissing = new Set<string>();

  constructor(
    private readonly db: SqlExecutor,
    private readonly log: Logger,
    /** Separate executor whose role can only SELECT (POST /api/ask). */
    private readonly readOnlyDb?: SqlExecutor,
    private readonly opts: { askQueryTimeoutMs?: number } = {},
  ) {}

  async ping(): Promise<boolean> {
    try {
      await this.db.query(SQL.ping, [], { timeoutMs: 5000 });
      return true;
    } catch (err) {
      this.log.warn('snowflake ping failed', { error: errorMessage(err) });
      return false;
    }
  }

  async warm(): Promise<void> {
    await this.db.query(SQL.warm, [], { timeoutMs: 30_000 });
  }

  async createPlayer(name: string): Promise<string> {
    const id = randomUUID();
    await this.db.query(SQL.insertPlayer, [id, name, toNtzString(new Date())]);
    return id;
  }

  async getPlayer(playerId: string): Promise<Player | null> {
    const { rows } = await this.db.query(SQL.getPlayer, [playerId]);
    const r = rows[0];
    return r ? { player_id: String(r.player_id), name: String(r.name ?? '') } : null;
  }

  async createSession(playerId: string, sport: string): Promise<string> {
    const id = randomUUID();
    await this.db.query(SQL.insertSession, [id, playerId, sport, toNtzString(new Date())]);
    return id;
  }

  async ensurePlayer(playerId: string, name: string | null): Promise<void> {
    await this.db.query(SQL.upsertPlayer, [playerId, name, toNtzString(new Date())]);
  }

  async ensureSession(sessionId: string, playerId: string, sport: string, startedAt: string | null): Promise<void> {
    await this.db.query(SQL.ensureSession, [sessionId, playerId, sport, toNtzString(startedAt ?? new Date())]);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const { rows } = await this.db.query(SQL.getSession, [sessionId]);
    const r = rows[0];
    if (!r) return null;
    const coach = parseCoach(r.ai_coach_json);
    const hasStats = r.score !== null && r.score !== undefined;
    return {
      session_id: String(r.session_id),
      player_id: String(r.player_id),
      sport: String(r.sport ?? 'boxing'),
      started_at: String(r.started_at ?? ''),
      ended_at: str(r.ended_at),
      stats: hasStats ? statsFromRow(r) : null,
      coach,
    };
  }

  async insertEvents(events: MotionEvent[], opts: { dedupe?: boolean } = {}): Promise<void> {
    if (events.length === 0) return;
    const binds: Bind[] = [];
    for (const e of events) {
      binds.push(
        e.event_id,
        e.session_id,
        e.player_id,
        e.sport,
        toNtzString(e.event_ts),
        e.event_type,
        e.hand,
        e.speed_mps,
        e.accuracy,
        e.reaction_ms,
        e.guard_up,
        e.points,
        e.payload ? JSON.stringify(e.payload) : null,
      );
    }
    await this.db.query(SQL.insertEvents(events.length, Boolean(opts.dedupe)), binds);
  }

  async aggregateSession(sessionId: string): Promise<SessionAggregate> {
    const binds = [sessionId, sessionId, sessionId];
    let row: Row | undefined;
    try {
      row = (await this.db.query(SQL.sessionAggregateFromView, binds)).rows[0];
    } catch (err) {
      this.log.warn('V_SESSION_STATS query failed; using inline aggregate', { error: errorMessage(err) });
    }
    if (!row || row.score === null || row.score === undefined) {
      row = (await this.db.query(SQL.sessionAggregateInline, binds)).rows[0] ?? {};
    }
    const mix = emptyMix();
    for (const t of EVENT_TYPES) mix[t] = num(row[`n_${t}`]) ?? 0;
    return {
      stats: statsFromRow(row),
      extras: {
        guard_pct: round(num(row.x_guard_pct), 1),
        symmetry_pct: round(symmetryFromParts(num(row.l_n), num(row.r_n), num(row.l_speed), num(row.r_speed)), 1),
        fatigue_drop_pct: round(fatigueFromParts(num(row.q1_speed), num(row.q4_speed)), 1),
        punch_mix: mix,
        total_events: num(row.total_events) ?? 0,
      },
    };
  }

  async finalizeSession(sessionId: string, stats: SessionStats, coach: StoredCoach): Promise<boolean> {
    const { rows, numUpdated } = await this.db.query(SQL.finalizeSession, [
      stats.score,
      stats.total_punches,
      stats.avg_speed,
      stats.max_speed,
      stats.avg_reaction_ms,
      stats.best_reaction_ms,
      stats.accuracy,
      JSON.stringify(coach),
      sessionId,
    ]);
    const updated = numUpdated ?? num(rows[0]?.['number of rows updated']) ?? 0;
    return updated > 0;
  }

  async leaderboard(limit: number, sport: string = 'boxing'): Promise<LeaderboardRow[]> {
    const n = safeLimit(limit, 10);
    if (sport.toLowerCase() !== 'boxing') return this.sportLeaderboard(n, sport.toLowerCase());
    let rows: Row[];
    try {
      rows = (await this.db.query(SQL.leaderboardFromView(n))).rows;
    } catch (err) {
      this.log.warn('V_LEADERBOARD query failed; using inline leaderboard', { error: errorMessage(err) });
      rows = (await this.db.query(SQL.leaderboardInline(n))).rows;
    }
    return rows.map((r) => ({
      rank: num(r.rank) ?? 0,
      player_id: String(r.player_id),
      name: String(r.name ?? 'Unknown'),
      score: num(r.score ?? r.best_score),
      fastest_punch: num(r.fastest_punch),
      best_reaction_ms: num(r.best_reaction_ms),
    }));
  }

  private async sportLeaderboard(n: number, sport: string): Promise<LeaderboardRow[]> {
    let rows: Row[];
    try {
      rows = (await this.db.query(SQL.sportLeaderboardFromView(n), [sport])).rows;
    } catch (err) {
      this.log.warn('V_LEADERBOARD_BY_SPORT query failed; using inline leaderboard', { sport, error: errorMessage(err) });
      rows = (await this.db.query(SQL.sportLeaderboardInline(n), [sport])).rows;
    }
    return rows.map((r) => ({
      rank: num(r.rank) ?? 0,
      player_id: String(r.player_id),
      name: String(r.name ?? 'Unknown'),
      score: num(r.score ?? r.best_score),
      fastest_punch: num(r.max_speed),
      best_reaction_ms: num(r.best_reaction_ms),
    }));
  }

  async sessionEvents(sessionId: string): Promise<MotionEvent[]> {
    const { rows } = await this.db.query(SQL.sessionEvents, [sessionId]);
    return rows.map((r) => {
      let payload: unknown = r.payload ?? null;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          payload = null;
        }
      }
      const hand = String(r.hand ?? '').toUpperCase();
      return {
        event_id: String(r.event_id ?? ''),
        session_id: String(r.session_id ?? sessionId),
        player_id: String(r.player_id ?? ''),
        sport: String(r.sport ?? 'boxing'),
        event_ts: String(r.event_ts ?? ''),
        event_type: String(r.event_type ?? '').toLowerCase() as MotionEvent['event_type'],
        hand: hand === 'L' || hand === 'R' ? hand : null,
        speed_mps: num(r.speed_mps) ?? 0,
        accuracy: num(r.accuracy),
        reaction_ms: num(r.reaction_ms),
        guard_up: typeof r.guard_up === 'boolean' ? r.guard_up : null,
        points: num(r.points) ?? 0,
        payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null,
      };
    });
  }

  async playerSessions(playerId: string, limit: number): Promise<SessionSummary[]> {
    const { rows } = await this.db.query(SQL.playerSessions(safeLimit(limit, 200)), [playerId]);
    return rows.map((r) => ({
      session_id: String(r.session_id),
      started_at: String(r.started_at ?? ''),
      ended_at: str(r.ended_at),
      score: num(r.score),
      total_punches: num(r.total_punches),
      avg_speed: num(r.avg_speed),
      max_speed: num(r.max_speed),
      avg_reaction_ms: num(r.avg_reaction_ms),
      best_reaction_ms: num(r.best_reaction_ms),
      accuracy: num(r.accuracy),
      badge: str(r.badge),
    }));
  }

  async playerMetrics(playerId: string): Promise<PlayerMetrics> {
    // Prefer the PLAYER_FORM dynamic table when it has caught up with the live event count.
    try {
      const r = (await this.db.query(SQL.playerFormWithLiveCount, [playerId, playerId])).rows[0];
      const live = num(r?.live_punches) ?? 0;
      if (r && live > 0 && num(r.punches) === live) {
        return {
          punch_speed_mps: round(num(r.avg_speed), 2),
          reaction_ms: round(num(r.avg_reaction_ms), 1),
          accuracy_pct: round(num(r.accuracy_pct), 1),
          guard_pct: round(num(r.guard_pct), 1),
          symmetry_pct: round(num(r.symmetry_pct), 1),
          fatigue_drop_pct: round(num(r.fatigue_drop_pct), 1),
        };
      }
    } catch (err) {
      this.log.warn('PLAYER_FORM query failed; computing metrics inline', { error: errorMessage(err) });
    }
    const r = (await this.db.query(SQL.playerMetricsInline, [playerId])).rows[0] ?? {};
    return {
      punch_speed_mps: round(num(r.avg_speed), 2),
      reaction_ms: round(num(r.avg_reaction_ms), 1),
      accuracy_pct: round(num(r.accuracy_pct), 1),
      guard_pct: round(num(r.guard_pct), 1),
      symmetry_pct: round(symmetryFromParts(num(r.l_n), num(r.r_n), num(r.l_speed), num(r.r_speed)), 1),
      fatigue_drop_pct: round(fatigueFromParts(num(r.q1_speed), num(r.q4_speed)), 1),
    };
  }

  async benchmarks(sport: string): Promise<Benchmark[]> {
    const { rows } = await this.db.query(SQL.benchmarks, [sport]);
    return rows
      .map((r) => ({
        sport: String(r.sport),
        metric: String(r.metric),
        p25: num(r.p25) ?? NaN,
        p50: num(r.p50) ?? NaN,
        p75: num(r.p75) ?? NaN,
        p90: num(r.p90) ?? NaN,
        pro_avg: num(r.pro_avg),
        higher_is_better: r.higher_is_better === true || String(r.higher_is_better).toLowerCase() === 'true',
      }))
      .filter((b) => [b.p25, b.p50, b.p75, b.p90].every(Number.isFinite));
  }

  /** Logs the first "missing object" per feature; returns true when `err` is one. */
  private missing(feature: string, err: unknown): boolean {
    if (!isMissingObjectError(err)) return false;
    if (!this.warnedMissing.has(feature)) {
      this.warnedMissing.add(feature);
      this.log.warn(`${feature}: Snowflake object missing or not granted; reporting available:false (run the sql/*.sql PLUS files)`, {
        error: errorMessage(err).slice(0, 300),
      });
    }
    return true;
  }

  async searchDrills(query: string, opts: DrillSearchOptions): Promise<DrillSearchResult> {
    try {
      const { rows } = await this.db.query(drillSearchSql(query, opts), [], { timeoutMs: opts.timeoutMs });
      return { available: true, source: 'cortex_search', results: parseSearchResponse(rows[0]?.response).slice(0, opts.limit) };
    } catch (err) {
      if (this.missing('COACH_DRILL_SEARCH', err)) return { available: false, source: 'cortex_search', results: [] };
      throw err;
    }
  }

  /** Runs an optional-object query; null when the object is missing (warned once per feature). */
  private async optional(feature: string, sql: string, binds: Bind[]): Promise<Row[] | null> {
    try {
      return (await this.db.query(sql, binds)).rows;
    } catch (err) {
      if (this.missing(feature, err)) return null;
      throw err;
    }
  }

  async playerStyle(playerId: string): Promise<PlayerStyle> {
    const [style, twin, scout] = await Promise.all([
      this.optional('V_PLAYER_STYLE', SQL.playerStyle, [playerId]),
      this.optional('V_STYLE_TWINS', SQL.styleTwin, [playerId]),
      this.optional('PLAYER_SCOUTING', SQL.scouting, [playerId]),
    ]);
    const r = style?.[0];
    const t = twin?.[0];
    const sc = scout?.[0];
    const c = (v: unknown) => round(num(v) ?? 50, 1) ?? 50;
    return {
      player_id: playerId,
      available: style !== null,
      components: r
        ? { speed: c(r.c_speed), reaction: c(r.c_reaction), accuracy: c(r.c_accuracy), guard: c(r.c_guard), symmetry: c(r.c_symmetry), endurance: c(r.c_endurance) }
        : null,
      pro_similarity_pct: r ? num(r.pro_similarity_pct) : null,
      twin: t && t.twin_player_id ? { player_id: String(t.twin_player_id), name: String(t.twin_name ?? 'Unknown'), similarity_pct: num(t.similarity_pct) ?? 0 } : null,
      scouting: sc && sc.fighting_style
        ? { fighting_style: String(sc.fighting_style), scouting_report: String(sc.scouting_report ?? ''), updated_at: str(sc.updated_at) }
        : null,
    };
  }

  async playerProgress(playerId: string, historyLimit: number): Promise<PlayerProgress> {
    const [prog, hist] = await Promise.all([
      this.optional('PLAYER_PROGRESS', SQL.playerProgress, [playerId]),
      this.optional('SESSION_SUMMARY', SQL.progressHistory(safeLimit(historyLimit, 200)), [playerId]),
    ]);
    const r = prog?.[0];
    const history: ProgressPoint[] = (hist ?? []).map((h) => ({
      session_index: num(h.session_index) ?? 0,
      session_id: String(h.session_id),
      score: num(h.score),
      avg_speed: num(h.avg_speed),
      accuracy_pct: num(h.accuracy_pct),
    }));
    return {
      player_id: playerId,
      available: prog !== null && hist !== null,
      sessions: num(r?.sessions) ?? 0,
      best_score: num(r?.best_score),
      last_score: num(r?.last_score),
      speed_trend_mps_per_session: num(r?.speed_trend_mps_per_session),
      score_trend_per_session: num(r?.score_trend_per_session),
      accuracy_trend_pct_per_session: num(r?.accuracy_trend_pct_per_session),
      reaction_trend_ms_per_session: num(r?.reaction_trend_ms_per_session),
      improving: r?.improving === true || String(r?.improving).toLowerCase() === 'true',
      history,
    };
  }

  async highlights(limit: number): Promise<HighlightsFeed> {
    const rows = await this.optional('V_HIGHLIGHTS_FEED', SQL.highlights(safeLimit(limit, 50)), []);
    if (rows === null) return { available: false, highlights: [] };
    return {
      available: true,
      highlights: rows.map(
        (h): Highlight => ({
          highlight_id: String(h.highlight_id),
          created_at: String(h.created_at ?? ''),
          kind: String(h.kind ?? ''),
          player_id: String(h.player_id ?? ''),
          name: String(h.name ?? 'Unknown'),
          session_id: String(h.session_id ?? ''),
          value: num(h.value),
          unit: String(h.unit ?? ''),
          message: String(h.message ?? ''),
        }),
      ),
    };
  }

  private searchProbe: { at: number; probe: FeatureProbe } | null = null;

  async probeFeatures(timeoutMs: number): Promise<RepoFeatureProbes> {
    let lastRefresh: string | null = null;
    const q = (sql: string) => this.db.query(sql, [], { timeoutMs }).then((r) => r.rows);
    const [dynamic_tables, cortex_search, streams_tasks, vectors] = await Promise.all([
      probe(timeoutMs, async () => {
        const rows = await q(SQL.dynamicTableHistory).catch(() => null);
        if (rows && rows.length > 0) {
          const pf = rows.find((r) => String(r.name).toUpperCase() === 'PLAYER_FORM' && String(r.state).toUpperCase() === 'SUCCEEDED');
          lastRefresh = pf ? str(pf.refresh_end_time) : null;
          const names = [...new Set(rows.map((r) => String(r.name).toUpperCase()))].sort();
          const latestPf = rows.find((r) => String(r.name).toUpperCase() === 'PLAYER_FORM' && !['SCHEDULED', 'EXECUTING'].includes(String(r.state).toUpperCase()));
          if (latestPf && String(latestPf.state).toUpperCase() === 'FAILED') return { status: 'error', detail: 'latest PLAYER_FORM refresh FAILED (see DYNAMIC_TABLE_REFRESH_HISTORY)' };
          return { status: 'up', detail: `refresh history for ${names.join(', ')}` };
        }
        const shown = await q(SQL.showDynamicTables);
        const names = shown.map((r) => String(r.name).toUpperCase()).sort();
        return names.includes('PLAYER_FORM')
          ? { status: 'up', detail: `dynamic tables: ${names.join(', ')}` }
          : { status: 'missing', detail: 'PLAYER_FORM dynamic table not found (run sql/analytics.sql)' };
      }),
      this.probeSearch(timeoutMs),
      probe(timeoutMs, async () => {
        const rows = await q(SQL.taskHistory).catch(() => null);
        if (rows && rows.length > 0) {
          const latest = new Map<string, Row>();
          for (const r of rows) {
            const s = String(r.state).toUpperCase();
            if (s === 'SCHEDULED' || s === 'EXECUTING') continue; // future / running rows say nothing about health
            if (!latest.has(String(r.name))) latest.set(String(r.name), r);
          }
          const parts = [...latest.values()].map((r) => `${String(r.name)} ${String(r.state)}${r.completed_time ? ` at ${String(r.completed_time)}` : ''}`);
          const failed = [...latest.values()].some((r) => /FAIL|CANCEL/.test(String(r.state).toUpperCase()));
          if (latest.size === 0) return { status: 'up', detail: 'tasks scheduled, no completed runs yet' };
          return { status: failed ? 'error' : 'up', detail: parts.join('; ') };
        }
        const tasks = (await q(SQL.showTasks)).filter((r) => ['T_HIGHLIGHTS', 'T_SCOUTING'].includes(String(r.name).toUpperCase()));
        return tasks.length > 0
          ? { status: 'up', detail: tasks.map((r) => `${String(r.name)} ${String(r.state ?? '')}`.trim()).join('; ') + ' (no runs yet)' }
          : { status: 'missing', detail: 'T_HIGHLIGHTS / T_SCOUTING not found (run sql/pipelines.sql, sql/cortex.sql)' };
      }),
      probe(timeoutMs, async () => {
        const rows = await q(SQL.vectorsProbe);
        return { status: 'up', detail: rows.length ? 'V_STYLE_TWINS (VECTOR_COSINE_SIMILARITY) answered' : 'V_STYLE_TWINS exists, no pairs yet' };
      }),
    ]);
    return { dynamic_tables, cortex_search, streams_tasks, vectors, player_form_last_refresh: lastRefresh };
  }

  /** One SEARCH_PREVIEW with limit 1, cached for 60 s (each call costs search credits). */
  private async probeSearch(timeoutMs: number): Promise<FeatureProbe> {
    if (this.searchProbe && Date.now() - this.searchProbe.at < 60_000) return this.searchProbe.probe;
    const result = await probe(timeoutMs, async () => {
      const r = await this.searchDrills('jab', { limit: 1, timeoutMs });
      if (!r.available) return { status: 'missing', detail: 'COACH_DRILL_SEARCH not found (run sql/cortex.sql)' };
      return { status: 'up', detail: `COACH_DRILL_SEARCH answered (${r.results.length} result)` };
    });
    this.searchProbe = { at: Date.now(), probe: result };
    return result;
  }

  async runReadOnlyQuery(sql: string, rowLimit: number): Promise<Record<string, unknown>[]> {
    if (!this.readOnlyDb) throw new Error('read-only Snowflake role is not configured');
    const { rows } = await this.readOnlyDb.query(SQL.readOnlyWrap(sql, safeLimit(rowLimit)), [], {
      timeoutMs: this.opts.askQueryTimeoutMs,
    });
    return rows;
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.db.close(), this.readOnlyDb?.close()]);
  }
}

/** Runs one status probe with its own timeout; maps every failure to a status instead of throwing. */
async function probe(timeoutMs: number, fn: () => Promise<FeatureProbe>): Promise<FeatureProbe> {
  try {
    return await withTimeout(fn(), timeoutMs, 'status probe');
  } catch (err) {
    if (isMissingObjectError(err)) return { status: 'missing', detail: errorMessage(err).slice(0, 200) };
    if (err instanceof TimeoutError) return { status: 'error', detail: `timed out after ${timeoutMs} ms` };
    return { status: 'error', detail: errorMessage(err).slice(0, 200) };
  }
}

function statsFromRow(r: Row): SessionStats {
  return roundStats({
    score: num(r.score) ?? 0,
    total_punches: num(r.total_punches) ?? 0,
    avg_speed: num(r.avg_speed),
    max_speed: num(r.max_speed),
    avg_reaction_ms: num(r.avg_reaction_ms),
    best_reaction_ms: num(r.best_reaction_ms),
    accuracy: num(r.accuracy),
  });
}
