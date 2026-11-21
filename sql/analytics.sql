-- =============================================================================
-- Motion Boxing on Snowflake: analytics layer
-- Run AFTER sql/setup.sql, as ACCOUNTADMIN. Safe to re-run: every object here is
-- derived (no stored data), so CREATE OR REPLACE is used throughout.
--
-- Conventions used by every object below:
--   * "punch"   = event_type IN ('jab','cross','hook','uppercut')  (blocks excluded)
--   * event_type / hand / sport are normalised with LOWER/UPPER so 'Jab' or 'l' still count
--   * reaction_ms only counts when > 0 (NULL / 0 = not applicable)
--   * speeds/accuracies are averaged over punches only (blocks have speed 0)
--   * accuracy in events is 0..1; *_pct columns are 0..100
--   * score = SUM(points) over ALL events of a session (blocks can score too)
--   * fatigue: punches of each (player, session) are split into quartiles by
--     event_ts with NTILE(4); only sessions with >= 8 punches are used so every
--     quartile has >= 2 punches. fatigue_drop_pct = 100 * (Q1 avg - Q4 avg) / Q1 avg
--     (positive = slower at the end). V_FATIGUE_CURVE uses the same rules.
--   * GREATEST/LEAST return NULL if any argument is NULL in Snowflake, so NULLs are
--     handled explicitly with CASE before calling them.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE MOTION_WH;
USE SCHEMA MOTION_DB.PUBLIC;

-- -----------------------------------------------------------------------------
-- PLAYER_FORM: one row per player_id.
--
-- REFRESH_MODE = FULL (deliberate): the query uses NTILE() windows, UNIONs and
-- aggregates over window output, which are outside (or at the edge of) what
-- incremental refresh supports (and REFRESH_MODE = AUTO would silently pick FULL
-- anyway, or could change on re-create). FULL always works, and the query uses no
-- non-deterministic functions. At hackathon data volumes a full recompute on an
-- X-SMALL warehouse takes seconds. Snowflake skips a scheduled refresh when no
-- base table changed, so an idle game does not keep the warehouse running.
-- TARGET_LAG = '1 minute' is the minimum Snowflake allows.
--
-- form_score (0..100) = weighted mean of six 0..100 components:
--     speed      25%  avg_speed / 10 m/s * 100            (10 m/s = full marks)
--     reaction   20%  (500 - avg_reaction_ms) / 320 * 100  (180 ms = 100, 500 ms = 0)
--     accuracy   20%  accuracy_pct
--     guard      15%  guard_pct
--     symmetry   10%  symmetry_pct
--     endurance  10%  100 - 2 * fatigue_drop_pct          (0% drop = 100, 50% drop = 0)
--   Each component is clamped to [0,100]. Components that are NULL (e.g. no
--   reaction data, too few punches for fatigue) are dropped and the remaining
--   weights are re-normalised. Final score clamped to [0,100], rounded to 0.1.
--   Players with no punches get form_score = 0.
--
-- symmetry_pct = mean of
--     count symmetry  100 * min(L punches, R punches) / max(L, R)
--     speed symmetry  100 * min(L avg speed, R avg speed) / max(L, R)
--   One-handed players score 0 on both. Both hands at 0 m/s count as symmetric.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_FORM
  TARGET_LAG = '1 minute'
  WAREHOUSE = MOTION_WH
  REFRESH_MODE = FULL
  INITIALIZE = ON_CREATE
  COMMENT = 'Per-player form: speed, reaction, accuracy, fatigue, symmetry, guard, punch mix, form_score'
AS
WITH ev AS (
  SELECT
    event_id, session_id, player_id, event_ts,
    LOWER(event_type) AS etype,
    UPPER(hand)       AS hand,
    speed_mps, accuracy, reaction_ms, guard_up,
    COALESCE(points, 0) AS points,
    CASE WHEN LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut') THEN 1 ELSE 0 END AS is_punch
  FROM MOTION_DB.PUBLIC.MOTION_EVENTS
  WHERE player_id IS NOT NULL
    AND LOWER(COALESCE(sport, 'boxing')) = 'boxing'
),
player_ids AS (
  SELECT player_id FROM MOTION_DB.PUBLIC.PLAYERS WHERE player_id IS NOT NULL
  UNION
  SELECT player_id FROM ev
),
player_names AS (
  SELECT player_id, MAX(name) AS name
  FROM MOTION_DB.PUBLIC.PLAYERS
  GROUP BY player_id
),
player_sessions AS (
  SELECT player_id, COUNT(DISTINCT session_id) AS sessions
  FROM (
    SELECT player_id, session_id FROM MOTION_DB.PUBLIC.SESSIONS
    WHERE player_id IS NOT NULL AND session_id IS NOT NULL
    UNION
    SELECT player_id, session_id FROM ev WHERE session_id IS NOT NULL
  ) s
  GROUP BY player_id
),
agg AS (
  SELECT
    player_id,
    SUM(is_punch)                                                         AS punches,
    COUNT(CASE WHEN etype IN ('jab', 'cross', 'hook', 'uppercut', 'block') THEN 1 END) AS typed_events,
    AVG(CASE WHEN is_punch = 1 THEN speed_mps END)                        AS avg_speed,
    MAX(CASE WHEN is_punch = 1 THEN speed_mps END)                        AS max_speed,
    AVG(CASE WHEN reaction_ms > 0 THEN reaction_ms END)                   AS avg_reaction_ms,
    MIN(CASE WHEN reaction_ms > 0 THEN reaction_ms END)                   AS best_reaction_ms,
    AVG(CASE WHEN is_punch = 1 THEN accuracy END) * 100                   AS accuracy_pct,
    AVG(CASE WHEN is_punch = 1 AND guard_up IS NOT NULL
             THEN CASE WHEN guard_up THEN 100.0 ELSE 0.0 END END)         AS guard_pct,
    COUNT(CASE WHEN is_punch = 1 AND hand = 'L' THEN 1 END)               AS l_n,
    COUNT(CASE WHEN is_punch = 1 AND hand = 'R' THEN 1 END)               AS r_n,
    AVG(CASE WHEN is_punch = 1 AND hand = 'L' THEN speed_mps END)         AS l_speed,
    AVG(CASE WHEN is_punch = 1 AND hand = 'R' THEN speed_mps END)         AS r_speed,
    COUNT(CASE WHEN etype = 'jab'      THEN 1 END)                        AS n_jab,
    COUNT(CASE WHEN etype = 'cross'    THEN 1 END)                        AS n_cross,
    COUNT(CASE WHEN etype = 'hook'     THEN 1 END)                        AS n_hook,
    COUNT(CASE WHEN etype = 'uppercut' THEN 1 END)                        AS n_uppercut,
    COUNT(CASE WHEN etype = 'block'    THEN 1 END)                        AS n_block
  FROM ev
  GROUP BY player_id
),
punch_q AS (
  SELECT
    player_id, session_id, speed_mps,
    NTILE(4) OVER (PARTITION BY player_id, session_id ORDER BY event_ts, event_id) AS quartile
  FROM (
    SELECT player_id, session_id, event_id, event_ts, speed_mps,
           COUNT(*) OVER (PARTITION BY player_id, session_id) AS session_punches
    FROM ev
    WHERE is_punch = 1 AND session_id IS NOT NULL AND speed_mps IS NOT NULL
  ) p
  WHERE session_punches >= 8
),
fatigue AS (
  SELECT
    player_id,
    AVG(CASE WHEN quartile = 1 THEN speed_mps END) AS q1_speed,
    AVG(CASE WHEN quartile = 4 THEN speed_mps END) AS q4_speed
  FROM punch_q
  GROUP BY player_id
),
metrics AS (
  SELECT
    i.player_id,
    COALESCE(n.name, 'Unknown')            AS name,
    COALESCE(s.sessions, 0)                AS sessions,
    COALESCE(a.punches, 0)                 AS punches,
    a.avg_speed, a.max_speed, a.avg_reaction_ms, a.best_reaction_ms,
    a.accuracy_pct,
    CASE WHEN f.q1_speed > 0
         THEN 100 * (f.q1_speed - f.q4_speed) / f.q1_speed END AS fatigue_drop_pct,
    -- symmetry: see header comment
    CASE
      WHEN COALESCE(a.l_n, 0) + COALESCE(a.r_n, 0) = 0 THEN NULL
      ELSE (
        100.0 * LEAST(a.l_n, a.r_n) / GREATEST(a.l_n, a.r_n)
        + CASE
            WHEN a.l_speed IS NULL OR a.r_speed IS NULL THEN 0
            WHEN GREATEST(a.l_speed, a.r_speed) <= 0 THEN 100
            ELSE 100.0 * GREATEST(LEAST(a.l_speed, a.r_speed), 0) / GREATEST(a.l_speed, a.r_speed)
          END
      ) / 2
    END                                    AS symmetry_pct,
    a.guard_pct,
    100.0 * a.n_jab      / NULLIF(a.typed_events, 0) AS mix_jab_pct,
    100.0 * a.n_cross    / NULLIF(a.typed_events, 0) AS mix_cross_pct,
    100.0 * a.n_hook     / NULLIF(a.typed_events, 0) AS mix_hook_pct,
    100.0 * a.n_uppercut / NULLIF(a.typed_events, 0) AS mix_uppercut_pct,
    100.0 * a.n_block    / NULLIF(a.typed_events, 0) AS mix_block_pct
  FROM player_ids i
  LEFT JOIN player_names    n ON n.player_id = i.player_id
  LEFT JOIN player_sessions s ON s.player_id = i.player_id
  LEFT JOIN agg             a ON a.player_id = i.player_id
  LEFT JOIN fatigue         f ON f.player_id = i.player_id
),
components AS (
  SELECT
    m.*,
    CASE WHEN avg_speed IS NULL THEN NULL
         ELSE LEAST(100, GREATEST(0, avg_speed / 10.0 * 100)) END                  AS c_speed,
    CASE WHEN avg_reaction_ms IS NULL THEN NULL
         ELSE LEAST(100, GREATEST(0, (500 - avg_reaction_ms) / 320.0 * 100)) END    AS c_reaction,
    CASE WHEN accuracy_pct IS NULL THEN NULL
         ELSE LEAST(100, GREATEST(0, accuracy_pct)) END                             AS c_accuracy,
    CASE WHEN guard_pct IS NULL THEN NULL
         ELSE LEAST(100, GREATEST(0, guard_pct)) END                                AS c_guard,
    CASE WHEN symmetry_pct IS NULL THEN NULL
         ELSE LEAST(100, GREATEST(0, symmetry_pct)) END                             AS c_symmetry,
    CASE WHEN fatigue_drop_pct IS NULL THEN NULL
         ELSE LEAST(100, GREATEST(0, 100 - 2 * fatigue_drop_pct)) END               AS c_endurance
  FROM metrics m
),
scored AS (
  SELECT
    c.*,
    COALESCE(0.25 * c_speed, 0) + COALESCE(0.20 * c_reaction, 0) + COALESCE(0.20 * c_accuracy, 0)
      + COALESCE(0.15 * c_guard, 0) + COALESCE(0.10 * c_symmetry, 0) + COALESCE(0.10 * c_endurance, 0)
      AS w_sum,
    CASE WHEN c_speed     IS NULL THEN 0 ELSE 0.25 END
      + CASE WHEN c_reaction  IS NULL THEN 0 ELSE 0.20 END
      + CASE WHEN c_accuracy  IS NULL THEN 0 ELSE 0.20 END
      + CASE WHEN c_guard     IS NULL THEN 0 ELSE 0.15 END
      + CASE WHEN c_symmetry  IS NULL THEN 0 ELSE 0.10 END
      + CASE WHEN c_endurance IS NULL THEN 0 ELSE 0.10 END
      AS w_total
  FROM components c
)
SELECT
  player_id,
  name,
  sessions,
  punches,
  ROUND(avg_speed, 2)         AS avg_speed,
  ROUND(max_speed, 2)         AS max_speed,
  ROUND(avg_reaction_ms, 1)   AS avg_reaction_ms,
  ROUND(best_reaction_ms, 1)  AS best_reaction_ms,
  ROUND(accuracy_pct, 1)      AS accuracy_pct,
  ROUND(fatigue_drop_pct, 1)  AS fatigue_drop_pct,
  ROUND(symmetry_pct, 1)      AS symmetry_pct,
  ROUND(guard_pct, 1)         AS guard_pct,
  ROUND(mix_jab_pct, 1)       AS mix_jab_pct,
  ROUND(mix_cross_pct, 1)     AS mix_cross_pct,
  ROUND(mix_hook_pct, 1)      AS mix_hook_pct,
  ROUND(mix_uppercut_pct, 1)  AS mix_uppercut_pct,
  ROUND(mix_block_pct, 1)     AS mix_block_pct,
  CASE
    WHEN punches = 0 OR w_total = 0 THEN 0
    ELSE ROUND(LEAST(100, GREATEST(0, w_sum / w_total)), 1)
  END                         AS form_score
FROM scored;

-- -----------------------------------------------------------------------------
-- V_LEADERBOARD: top 10 players by best single-session score (live, from base
-- tables, so it updates instantly - no dynamic-table lag).
-- Ties broken by fastest punch, then best reaction, then player_id.
-- `score` duplicates `best_score` to match the /api/leaderboard JSON shape.
-- A view's ORDER BY is not guaranteed to survive: callers should ORDER BY rank.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW MOTION_DB.PUBLIC.V_LEADERBOARD
  COMMENT = 'Top 10 players: rank, player_id, name, best_score, fastest_punch, best_reaction_ms'
AS
WITH ev AS (
  SELECT
    session_id, player_id, speed_mps, reaction_ms,
    COALESCE(points, 0) AS points,
    CASE WHEN LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut') THEN 1 ELSE 0 END AS is_punch
  FROM MOTION_DB.PUBLIC.MOTION_EVENTS
  WHERE player_id IS NOT NULL
    AND LOWER(COALESCE(sport, 'boxing')) = 'boxing'
),
session_scores AS (
  SELECT player_id, session_id, SUM(points) AS score
  FROM ev
  GROUP BY player_id, session_id
),
per_player AS (
  SELECT
    s.player_id,
    MAX(s.score) AS best_score,
    MAX(e.fastest_punch) AS fastest_punch,
    MIN(e.best_reaction_ms) AS best_reaction_ms
  FROM session_scores s
  JOIN (
    SELECT player_id,
           MAX(CASE WHEN is_punch = 1 THEN speed_mps END) AS fastest_punch,
           MIN(CASE WHEN reaction_ms > 0 THEN reaction_ms END) AS best_reaction_ms
    FROM ev
    GROUP BY player_id
  ) e ON e.player_id = s.player_id
  GROUP BY s.player_id
),
ranked AS (
  SELECT
    ROW_NUMBER() OVER (
      ORDER BY best_score DESC NULLS LAST,
               fastest_punch DESC NULLS LAST,
               best_reaction_ms ASC NULLS LAST,
               p.player_id
    ) AS rank,
    p.player_id,
    COALESCE(n.name, 'Unknown') AS name,
    p.best_score,
    p.best_score AS score,
    ROUND(p.fastest_punch, 2) AS fastest_punch,
    ROUND(p.best_reaction_ms, 1) AS best_reaction_ms
  FROM per_player p
  LEFT JOIN (
    SELECT player_id, MAX(name) AS name FROM MOTION_DB.PUBLIC.PLAYERS GROUP BY player_id
  ) n ON n.player_id = p.player_id
)
SELECT rank, player_id, name, best_score, score, fastest_punch, best_reaction_ms
FROM ranked
WHERE rank <= 10
ORDER BY rank;

-- -----------------------------------------------------------------------------
-- V_GLOBAL_STATS: single row of headline numbers.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW MOTION_DB.PUBLIC.V_GLOBAL_STATS
  COMMENT = 'One row: total_players, total_sessions, total_punches, avg_speed, max_speed'
AS
SELECT
  (SELECT COUNT(DISTINCT player_id) FROM MOTION_DB.PUBLIC.PLAYERS)  AS total_players,
  (SELECT COUNT(DISTINCT session_id) FROM MOTION_DB.PUBLIC.SESSIONS) AS total_sessions,
  e.total_punches,
  e.avg_speed,
  e.max_speed
FROM (
  SELECT
    COUNT(*)                 AS total_punches,
    ROUND(AVG(speed_mps), 2) AS avg_speed,
    ROUND(MAX(speed_mps), 2) AS max_speed
  FROM MOTION_DB.PUBLIC.MOTION_EVENTS
  WHERE LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut')
    AND LOWER(COALESCE(sport, 'boxing')) = 'boxing'
) e;

-- -----------------------------------------------------------------------------
-- V_SESSION_STATS: one row per SESSIONS row, aggregated live from MOTION_EVENTS.
-- Used by /api/session/end:  SELECT ... FROM V_SESSION_STATS WHERE session_id = ?
-- Columns score..accuracy match the API `stats` object; accuracy is 0..1
-- (same scale as MOTION_EVENTS.accuracy and SESSIONS.accuracy), accuracy_pct 0..100.
-- Sessions with no events return score 0 / total_punches 0 and NULL averages.
-- No sport filter here: a session is one sport, so all its events count.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW MOTION_DB.PUBLIC.V_SESSION_STATS
  COMMENT = 'Per-session aggregates for /api/session/end'
AS
WITH agg AS (
  SELECT
    session_id,
    COUNT(*)                                                           AS total_events,
    SUM(COALESCE(points, 0))                                           AS score,
    COUNT(CASE WHEN LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut') THEN 1 END) AS total_punches,
    COUNT(CASE WHEN LOWER(event_type) = 'block' THEN 1 END)            AS total_blocks,
    AVG(CASE WHEN LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut') THEN speed_mps END) AS avg_speed,
    MAX(CASE WHEN LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut') THEN speed_mps END) AS max_speed,
    AVG(CASE WHEN reaction_ms > 0 THEN reaction_ms END)                AS avg_reaction_ms,
    MIN(CASE WHEN reaction_ms > 0 THEN reaction_ms END)                AS best_reaction_ms,
    AVG(CASE WHEN LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut') THEN accuracy END) AS accuracy,
    AVG(CASE WHEN LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut') AND guard_up IS NOT NULL
             THEN CASE WHEN guard_up THEN 100.0 ELSE 0.0 END END)      AS guard_pct,
    MIN(event_ts)                                                      AS first_event_ts,
    MAX(event_ts)                                                      AS last_event_ts
  FROM MOTION_DB.PUBLIC.MOTION_EVENTS
  WHERE session_id IS NOT NULL
  GROUP BY session_id
)
SELECT
  s.session_id,
  s.player_id,
  s.sport,
  s.started_at,
  s.ended_at,
  COALESCE(a.score, 0)                  AS score,
  COALESCE(a.total_punches, 0)          AS total_punches,
  ROUND(a.avg_speed, 2)                 AS avg_speed,
  ROUND(a.max_speed, 2)                 AS max_speed,
  ROUND(a.avg_reaction_ms, 1)           AS avg_reaction_ms,
  ROUND(a.best_reaction_ms, 1)          AS best_reaction_ms,
  ROUND(a.accuracy, 3)                  AS accuracy,
  ROUND(a.accuracy * 100, 1)            AS accuracy_pct,
  ROUND(a.guard_pct, 1)                 AS guard_pct,
  COALESCE(a.total_blocks, 0)           AS total_blocks,
  COALESCE(a.total_events, 0)           AS total_events,
  a.first_event_ts,
  a.last_event_ts,
  DATEDIFF('second', a.first_event_ts, a.last_event_ts) AS duration_s
FROM MOTION_DB.PUBLIC.SESSIONS s
LEFT JOIN agg a ON a.session_id = s.session_id;

-- -----------------------------------------------------------------------------
-- V_SPEED_OVER_TIME: punch speed per 10-second bucket within each session.
--   bucket          0-based index of the 10 s bucket since the session's first event
--   bucket_start_s  seconds since the first event (bucket * 10)
--   minute          bucket_start_s / 60 as a decimal (handy chart x-axis)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW MOTION_DB.PUBLIC.V_SPEED_OVER_TIME
  COMMENT = 'Avg punch speed per 10 s bucket per session (charts)'
AS
WITH p AS (
  SELECT
    session_id, player_id, event_ts, speed_mps,
    MIN(event_ts) OVER (PARTITION BY session_id) AS t0
  FROM MOTION_DB.PUBLIC.MOTION_EVENTS
  WHERE session_id IS NOT NULL
    AND event_ts IS NOT NULL
    AND LOWER(COALESCE(sport, 'boxing')) = 'boxing'
    AND LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut')
),
b AS (
  SELECT
    session_id, player_id, speed_mps, t0,
    CAST(FLOOR(DATEDIFF('second', t0, event_ts) / 10) AS INTEGER) AS bucket
  FROM p
)
SELECT
  session_id,
  player_id,
  bucket,
  bucket * 10                     AS bucket_start_s,
  ROUND(bucket * 10 / 60.0, 3)    AS minute,
  MIN(t0)                         AS session_first_event_ts,
  COUNT(*)                        AS punches,
  ROUND(AVG(speed_mps), 2)        AS avg_speed,
  ROUND(MAX(speed_mps), 2)        AS max_speed
FROM b
GROUP BY session_id, player_id, bucket;

-- -----------------------------------------------------------------------------
-- V_FATIGUE_CURVE: per player, average punch speed in each quartile (1-4) of
-- their sessions (same NTILE(4) rules as PLAYER_FORM.fatigue_drop_pct, so
-- 100 * (q1 - q4) / q1 here equals that column, before rounding).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW MOTION_DB.PUBLIC.V_FATIGUE_CURVE
  COMMENT = 'Avg punch speed per session quartile, per player'
AS
WITH ev AS (
  SELECT event_id, session_id, player_id, event_ts, speed_mps
  FROM MOTION_DB.PUBLIC.MOTION_EVENTS
  WHERE player_id IS NOT NULL
    AND session_id IS NOT NULL
    AND speed_mps IS NOT NULL
    AND LOWER(COALESCE(sport, 'boxing')) = 'boxing'
    AND LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut')
),
punch_q AS (
  SELECT
    player_id, session_id, speed_mps,
    NTILE(4) OVER (PARTITION BY player_id, session_id ORDER BY event_ts, event_id) AS quartile
  FROM (
    SELECT player_id, session_id, event_id, event_ts, speed_mps,
           COUNT(*) OVER (PARTITION BY player_id, session_id) AS session_punches
    FROM ev
  ) x
  WHERE session_punches >= 8
)
SELECT
  player_id,
  quartile,
  ROUND(AVG(speed_mps), 2)   AS avg_speed,
  COUNT(*)                   AS punches,
  COUNT(DISTINCT session_id) AS sessions
FROM punch_q
GROUP BY player_id, quartile;

-- -----------------------------------------------------------------------------
-- Grants for the app role (explicit; setup.sql also has FUTURE grants).
-- CREATE OR REPLACE drops grants on the old object, so these must be re-run
-- every time this file is run - they are idempotent.
-- -----------------------------------------------------------------------------
GRANT SELECT, MONITOR ON DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_FORM TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_LEADERBOARD     TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_GLOBAL_STATS    TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_SESSION_STATS   TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_SPEED_OVER_TIME TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_FATIGUE_CURVE   TO ROLE MOTION_APP_ROLE;

-- Optional: let the app force an immediate refresh after a round
-- (ALTER DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_FORM REFRESH):
-- GRANT OPERATE ON DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_FORM TO ROLE MOTION_APP_ROLE;
