-- =============================================================================
-- Motion Boxing on Snowflake: pipelines (Dynamic Table chain, vectors, Streams + Tasks)
-- Source of truth for names/columns: sql/PLUS_CONTRACT.md, section "pipelines.sql".
--
-- Run AFTER sql/setup.sql and sql/analytics.sql, as ACCOUNTADMIN:
--   cd scripts && npx tsx src/run-sql.ts ../sql/pipelines.sql
-- Then check it with sql/verify_pipelines.sql.
--
-- Safe to re-run:
--   * derived objects (dynamic tables, views, task) use CREATE OR REPLACE
--   * HIGHLIGHTS (stored data) and the stream use IF NOT EXISTS, so re-running
--     never drops highlights and never resets the stream offset
--   * CREATE OR REPLACE drops grants, so every GRANT is at the end of this file
--
-- Objects:
--   SESSION_SUMMARY          DT, one row per (player, session): score, speed, reaction, accuracy, guard
--   PLAYER_PROGRESS          DT on SESSION_SUMMARY, one row per player: bests and per-session trends
--   V_PLAYER_STYLE           view, 6-number style vector per player + similarity to the pro profile
--   V_STYLE_TWINS            view, the most similar OTHER player per player (VECTOR_COSINE_SIMILARITY)
--   HIGHLIGHTS               table, live feed rows written only by task T_HIGHLIGHTS
--   MOTION_EVENTS_HL_STREAM  append-only stream on MOTION_EVENTS (new punches since the last task run)
--   T_HIGHLIGHTS             task, every minute when the stream has data: records, milestones, anti-cheat
--   V_HIGHLIGHTS_FEED        view, latest 50 highlights, newest first
--
-- Snowsight lineage: MOTION_EVENTS -> SESSION_SUMMARY -> PLAYER_PROGRESS
-- (Monitoring > Dynamic Tables > PLAYER_PROGRESS > Graph).
--
-- Conventions (same as analytics.sql):
--   * "punch" = event_type IN ('jab','cross','hook','uppercut'), normalised with LOWER
--   * only boxing events: LOWER(COALESCE(sport, 'boxing')) = 'boxing'
--   * reaction_ms only counts when > 0
--   * accuracy in events is 0..1; *_pct columns are 0..100
--   * score = SUM(points) over ALL events of a session
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE MOTION_WH;
USE SCHEMA MOTION_DB.PUBLIC;

-- -----------------------------------------------------------------------------
-- SESSION_SUMMARY: one row per (player_id, session_id) that has boxing events.
--
-- TARGET_LAG = DOWNSTREAM: this table has no schedule of its own. It refreshes
-- only when PLAYER_PROGRESS (below) needs fresh data, so the chain costs one
-- refresh per minute at most, and nothing when no base table changed.
--
-- REFRESH_MODE = FULL (deliberate): session_index uses a ROW_NUMBER() window
-- over the output of a GROUP BY, and PLAYER_PROGRESS uses REGR_SLOPE and a
-- window. Those are at the edge of what incremental refresh supports, and a
-- dynamic table in incremental mode cannot sit downstream of one in full mode,
-- so both tables in the chain are FULL. That always works, the query has no
-- non-deterministic functions, and at hackathon volumes a full recompute on an
-- X-SMALL warehouse takes seconds.
--
-- session_start_ts = SESSIONS.started_at when the session row has one, else the
-- first event time. session_index = 1 for the player's first session, ordered by
-- session_start_ts (ties and NULLs broken by session_id, so it is deterministic).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE MOTION_DB.PUBLIC.SESSION_SUMMARY
  TARGET_LAG = DOWNSTREAM
  WAREHOUSE = MOTION_WH
  REFRESH_MODE = FULL
  INITIALIZE = ON_CREATE
  COMMENT = 'Per (player, session): session_index, score, punches, speed, reaction, accuracy_pct, guard_pct'
AS
WITH ev AS (
  SELECT
    session_id, player_id, event_ts,
    speed_mps, accuracy, reaction_ms, guard_up,
    COALESCE(points, 0) AS points,
    CASE WHEN LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut') THEN 1 ELSE 0 END AS is_punch
  FROM MOTION_DB.PUBLIC.MOTION_EVENTS
  WHERE player_id IS NOT NULL
    AND session_id IS NOT NULL
    AND LOWER(COALESCE(sport, 'boxing')) = 'boxing'
),
sess AS (
  SELECT session_id, MIN(started_at) AS started_at
  FROM MOTION_DB.PUBLIC.SESSIONS
  WHERE session_id IS NOT NULL
  GROUP BY session_id
),
agg AS (
  SELECT
    player_id,
    session_id,
    MIN(event_ts)                                                 AS first_event_ts,
    SUM(points)                                                   AS score,
    SUM(is_punch)                                                 AS punches,
    AVG(CASE WHEN is_punch = 1 THEN speed_mps END)                AS avg_speed,
    MAX(CASE WHEN is_punch = 1 THEN speed_mps END)                AS max_speed,
    AVG(CASE WHEN reaction_ms > 0 THEN reaction_ms END)           AS avg_reaction_ms,
    AVG(CASE WHEN is_punch = 1 THEN accuracy END) * 100           AS accuracy_pct,
    AVG(CASE WHEN is_punch = 1 AND guard_up IS NOT NULL
             THEN CASE WHEN guard_up THEN 100.0 ELSE 0.0 END END) AS guard_pct
  FROM ev
  GROUP BY player_id, session_id
),
dated AS (
  SELECT a.*, COALESCE(s.started_at, a.first_event_ts) AS session_start_ts
  FROM agg a
  LEFT JOIN sess s ON s.session_id = a.session_id
)
SELECT
  player_id,
  session_id,
  session_start_ts,
  ROW_NUMBER() OVER (
    PARTITION BY player_id
    ORDER BY session_start_ts ASC NULLS LAST, session_id
  )                             AS session_index,
  score,
  punches,
  ROUND(avg_speed, 2)           AS avg_speed,
  ROUND(max_speed, 2)           AS max_speed,
  ROUND(avg_reaction_ms, 1)     AS avg_reaction_ms,
  ROUND(accuracy_pct, 1)        AS accuracy_pct,
  ROUND(guard_pct, 1)           AS guard_pct
FROM dated;

-- -----------------------------------------------------------------------------
-- PLAYER_PROGRESS: one row per player_id, built on SESSION_SUMMARY.
-- TARGET_LAG = '1 minute' (the minimum) drives the whole chain.
-- REFRESH_MODE = FULL: see SESSION_SUMMARY (FULL upstream requires FULL here).
--
-- Trends are least-squares slopes against session_index, i.e. "change per
-- session": REGR_SLOPE(y, x) with y first. Sessions where y is NULL are ignored
-- by REGR_SLOPE. All trends are NULL when the player has fewer than 2 sessions.
-- reaction_trend_ms_per_session < 0 means the player is getting FASTER.
-- improving = score trend > 0 (FALSE when there is no trend yet).
-- last_score = score of the session with the highest session_index.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_PROGRESS
  TARGET_LAG = '1 minute'
  WAREHOUSE = MOTION_WH
  REFRESH_MODE = FULL
  INITIALIZE = ON_CREATE
  COMMENT = 'Per player: sessions, best/last score, per-session trends (REGR_SLOPE), improving flag'
AS
WITH s AS (
  SELECT
    player_id, session_index, session_start_ts, score, avg_speed, accuracy_pct, avg_reaction_ms,
    FIRST_VALUE(score) OVER (PARTITION BY player_id ORDER BY session_index DESC) AS last_score_w
  FROM MOTION_DB.PUBLIC.SESSION_SUMMARY
),
agg AS (
  SELECT
    player_id,
    COUNT(*)                                     AS sessions,
    MIN(session_start_ts)                        AS first_session_ts,
    MAX(session_start_ts)                        AS last_session_ts,
    MAX(score)                                   AS best_score,
    MAX(last_score_w)                            AS last_score,
    REGR_SLOPE(avg_speed, session_index)         AS speed_slope,
    REGR_SLOPE(score, session_index)             AS score_slope,
    REGR_SLOPE(accuracy_pct, session_index)      AS accuracy_slope,
    REGR_SLOPE(avg_reaction_ms, session_index)   AS reaction_slope
  FROM s
  GROUP BY player_id
)
SELECT
  player_id,
  sessions,
  first_session_ts,
  last_session_ts,
  best_score,
  last_score,
  CASE WHEN sessions >= 2 THEN ROUND(speed_slope, 3)    END AS speed_trend_mps_per_session,
  CASE WHEN sessions >= 2 THEN ROUND(score_slope, 2)    END AS score_trend_per_session,
  CASE WHEN sessions >= 2 THEN ROUND(accuracy_slope, 2) END AS accuracy_trend_pct_per_session,
  CASE WHEN sessions >= 2 THEN ROUND(reaction_slope, 2) END AS reaction_trend_ms_per_session,
  COALESCE(sessions >= 2 AND score_slope > 0, FALSE)         AS improving
FROM agg;

-- -----------------------------------------------------------------------------
-- V_PLAYER_STYLE: one row per player with punches > 0 (from PLAYER_FORM).
--
-- Style vector convention (PLUS_CONTRACT.md), order speed, reaction, accuracy,
-- guard, symmetry, endurance. Each c_* is 0..100 with the SAME formulas as
-- PLAYER_FORM.form_score; a NULL component becomes 50 (neutral).
-- LEAST/GREATEST return NULL when an argument is NULL, so COALESCE(..., 50)
-- catches every missing input. Vector element = c / 100 - 0.5 (-0.5..0.5).
--
-- pro_similarity_pct compares the player with a "pro" vector built from
-- PRO_BENCHMARKS.pro_avg (sport 'boxing') through the same formulas:
--   punch_speed_mps -> speed, reaction_ms -> reaction, accuracy_pct, guard_pct,
--   symmetry_pct, fatigue_drop_pct -> endurance.
-- similarity_pct = ROUND(50 * (cosine + 1), 1), 0..100.
--
-- Zero vectors: a player whose six components are all exactly 50 has an
-- all-zero vector, and cosine similarity is undefined for it. Such players get
-- pro_similarity_pct = NULL. The similarity call itself uses a copy of the
-- vector whose first element is nudged to 1e-6 when the vector is all zeros, so
-- the function never sees a zero vector whatever order Snowflake evaluates in.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW MOTION_DB.PUBLIC.V_PLAYER_STYLE
  COMMENT = 'Per player: 6 style components (0..100), style_vec VECTOR(FLOAT,6), pro_similarity_pct'
AS
WITH comp AS (
  SELECT
    player_id,
    name,
    COALESCE(LEAST(100, GREATEST(0, avg_speed / 10.0 * 100)), 50)::FLOAT               AS c_speed,
    COALESCE(LEAST(100, GREATEST(0, (500 - avg_reaction_ms) / 320.0 * 100)), 50)::FLOAT AS c_reaction,
    COALESCE(LEAST(100, GREATEST(0, accuracy_pct)), 50)::FLOAT                          AS c_accuracy,
    COALESCE(LEAST(100, GREATEST(0, guard_pct)), 50)::FLOAT                             AS c_guard,
    COALESCE(LEAST(100, GREATEST(0, symmetry_pct)), 50)::FLOAT                          AS c_symmetry,
    COALESCE(LEAST(100, GREATEST(0, 100 - 2 * fatigue_drop_pct)), 50)::FLOAT            AS c_endurance
  FROM MOTION_DB.PUBLIC.PLAYER_FORM
  WHERE punches > 0
),
pro_raw AS (
  SELECT
    MAX(CASE WHEN LOWER(metric) = 'punch_speed_mps'  THEN pro_avg END) AS avg_speed,
    MAX(CASE WHEN LOWER(metric) = 'reaction_ms'      THEN pro_avg END) AS avg_reaction_ms,
    MAX(CASE WHEN LOWER(metric) = 'accuracy_pct'     THEN pro_avg END) AS accuracy_pct,
    MAX(CASE WHEN LOWER(metric) = 'guard_pct'        THEN pro_avg END) AS guard_pct,
    MAX(CASE WHEN LOWER(metric) = 'symmetry_pct'     THEN pro_avg END) AS symmetry_pct,
    MAX(CASE WHEN LOWER(metric) = 'fatigue_drop_pct' THEN pro_avg END) AS fatigue_drop_pct
  FROM MOTION_DB.PUBLIC.PRO_BENCHMARKS
  WHERE LOWER(sport) = 'boxing'
),
pro AS (
  -- pro_raw is an aggregate without GROUP BY, so it always has exactly one row
  -- (all NULL if PRO_BENCHMARKS is empty, which gives an all-50 pro profile).
  SELECT
    COALESCE(LEAST(100, GREATEST(0, avg_speed / 10.0 * 100)), 50)::FLOAT               AS p_speed,
    COALESCE(LEAST(100, GREATEST(0, (500 - avg_reaction_ms) / 320.0 * 100)), 50)::FLOAT AS p_reaction,
    COALESCE(LEAST(100, GREATEST(0, accuracy_pct)), 50)::FLOAT                          AS p_accuracy,
    COALESCE(LEAST(100, GREATEST(0, guard_pct)), 50)::FLOAT                             AS p_guard,
    COALESCE(LEAST(100, GREATEST(0, symmetry_pct)), 50)::FLOAT                          AS p_symmetry,
    COALESCE(LEAST(100, GREATEST(0, 100 - 2 * fatigue_drop_pct)), 50)::FLOAT            AS p_endurance
  FROM pro_raw
),
elems AS (
  SELECT
    c.*,
    (c.c_speed     / 100 - 0.5)::FLOAT AS e1,
    (c.c_reaction  / 100 - 0.5)::FLOAT AS e2,
    (c.c_accuracy  / 100 - 0.5)::FLOAT AS e3,
    (c.c_guard     / 100 - 0.5)::FLOAT AS e4,
    (c.c_symmetry  / 100 - 0.5)::FLOAT AS e5,
    (c.c_endurance / 100 - 0.5)::FLOAT AS e6,
    (p.p_speed     / 100 - 0.5)::FLOAT AS q1,
    (p.p_reaction  / 100 - 0.5)::FLOAT AS q2,
    (p.p_accuracy  / 100 - 0.5)::FLOAT AS q3,
    (p.p_guard     / 100 - 0.5)::FLOAT AS q4,
    (p.p_symmetry  / 100 - 0.5)::FLOAT AS q5,
    (p.p_endurance / 100 - 0.5)::FLOAT AS q6
  FROM comp c
  CROSS JOIN pro p
),
flags AS (
  SELECT
    e.*,
    (e1 = 0 AND e2 = 0 AND e3 = 0 AND e4 = 0 AND e5 = 0 AND e6 = 0) AS player_zero,
    (q1 = 0 AND q2 = 0 AND q3 = 0 AND q4 = 0 AND q5 = 0 AND q6 = 0) AS pro_zero
  FROM elems e
),
vecs AS (
  SELECT
    f.*,
    ARRAY_CONSTRUCT(e1, e2, e3, e4, e5, e6)::VECTOR(FLOAT, 6) AS style_vec,
    ARRAY_CONSTRUCT(IFF(player_zero, 1e-6::FLOAT, e1), e2, e3, e4, e5, e6)::VECTOR(FLOAT, 6) AS safe_vec,
    ARRAY_CONSTRUCT(IFF(pro_zero, 1e-6::FLOAT, q1), q2, q3, q4, q5, q6)::VECTOR(FLOAT, 6)    AS pro_vec
  FROM flags f
)
SELECT
  player_id,
  name,
  ROUND(c_speed, 1)      AS c_speed,
  ROUND(c_reaction, 1)   AS c_reaction,
  ROUND(c_accuracy, 1)   AS c_accuracy,
  ROUND(c_guard, 1)      AS c_guard,
  ROUND(c_symmetry, 1)   AS c_symmetry,
  ROUND(c_endurance, 1)  AS c_endurance,
  style_vec,
  CASE WHEN player_zero OR pro_zero THEN NULL
       ELSE ROUND(50 * (VECTOR_COSINE_SIMILARITY(safe_vec, pro_vec) + 1), 1)
  END                    AS pro_similarity_pct
FROM vecs;

-- -----------------------------------------------------------------------------
-- V_STYLE_TWINS: for each player in V_PLAYER_STYLE, the most similar OTHER
-- player (both have punches > 0). Brute-force pairwise VECTOR_COSINE_SIMILARITY
-- is fine for a few hundred players.
-- Players with an all-zero vector (all six components exactly 50) are left out
-- on both sides, because cosine similarity is undefined for them; filtering
-- happens before the join, so the function only ever sees non-zero vectors.
-- Ties: highest similarity first, then the smallest twin_player_id.
-- A player with no other eligible player has no row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW MOTION_DB.PUBLIC.V_STYLE_TWINS
  COMMENT = 'Per player: nearest other player by style vector (cosine similarity)'
AS
WITH s AS (
  SELECT player_id, name, style_vec
  FROM MOTION_DB.PUBLIC.V_PLAYER_STYLE
  WHERE NOT (c_speed = 50 AND c_reaction = 50 AND c_accuracy = 50
             AND c_guard = 50 AND c_symmetry = 50 AND c_endurance = 50)
),
pairs AS (
  SELECT
    a.player_id,
    a.name,
    b.player_id AS twin_player_id,
    b.name      AS twin_name,
    VECTOR_COSINE_SIMILARITY(a.style_vec, b.style_vec) AS sim
  FROM s a
  JOIN s b ON b.player_id <> a.player_id
)
SELECT
  player_id,
  name,
  twin_player_id,
  twin_name,
  ROUND(sim, 4)                AS similarity,
  ROUND(50 * (sim + 1), 1)     AS similarity_pct
FROM pairs
QUALIFY ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY sim DESC NULLS LAST, twin_player_id) = 1;

-- -----------------------------------------------------------------------------
-- HIGHLIGHTS: live feed. Stored data, so IF NOT EXISTS (never dropped).
-- Written only by task T_HIGHLIGHTS.
-- kind in 'speed_record' | 'reaction_record' | 'personal_best_speed'
--       | 'punch_milestone' | 'suspicious_speed'
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS MOTION_DB.PUBLIC.HIGHLIGHTS (
  highlight_id  STRING        DEFAULT UUID_STRING(),
  created_at    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  kind          STRING,
  player_id     STRING,
  name          STRING,
  session_id    STRING,
  value         FLOAT,
  unit          STRING,
  message       STRING
)
COMMENT = 'Live highlights feed (records, milestones, anti-cheat flags), written by task T_HIGHLIGHTS';

-- -----------------------------------------------------------------------------
-- MOTION_EVENTS_HL_STREAM: append-only stream of new MOTION_EVENTS rows.
-- MOTION_EVENTS already has CHANGE_TRACKING = TRUE (setup.sql).
-- IF NOT EXISTS: CREATE OR REPLACE would reset the offset and silently skip or
-- replay rows. Append-only is cheaper than a standard stream and is all we need
-- (events are only ever inserted). The offset advances only when a DML
-- statement that reads the stream commits, which is what the task does.
-- -----------------------------------------------------------------------------
CREATE STREAM IF NOT EXISTS MOTION_DB.PUBLIC.MOTION_EVENTS_HL_STREAM
  ON TABLE MOTION_DB.PUBLIC.MOTION_EVENTS
  APPEND_ONLY = TRUE
  COMMENT = 'New MOTION_EVENTS rows not yet processed by task T_HIGHLIGHTS';

-- -----------------------------------------------------------------------------
-- T_HIGHLIGHTS: every minute, but only when the stream has new rows.
--
-- Cost: the WHEN condition (SYSTEM$STREAM_HAS_DATA) is checked in the cloud
-- services layer without starting the warehouse. If nobody is playing, the run
-- is SKIPPED: no warehouse credits, only a nominal cloud services charge per
-- check. MOTION_WH resumes only for runs that have new events.
-- (docs.snowflake.com/en/sql-reference/sql/create-task, WHEN clause)
--
-- The body is ONE INSERT ... SELECT that reads the stream through a single CTE
-- (batch) and combines every highlight kind with UNION ALL. All references see
-- the same snapshot, and the stream offset advances once, when this statement
-- commits (even if it inserts zero rows). Two separate autocommitted statements
-- would lose the batch for the second one.
--
-- "Before this batch" (hist) = MOTION_EVENTS minus the batch rows (anti-join on
-- event_id). Using MOTION_EVENTS rather than earlier HIGHLIGHTS rows means the
-- first-ever batch is compared with all existing (for example seeded) data and
-- does not announce fake records.
--
-- Kinds (at most one row per kind per player per batch):
--   speed_record         fastest plausible punch in the batch beats every earlier one
--                        (one row per batch; also when there is no earlier punch at all)
--   reaction_record      lowest reaction_ms > 0 in the batch beats every earlier one
--   personal_best_speed  a player beats their OWN earlier best; needs an earlier punch,
--                        and is skipped when the same player just set the global record
--   punch_milestone      player's total punches cross 100 / 500 / 1000 / 5000
--                        (highest milestone crossed in this batch)
--   suspicious_speed     anti-cheat: punch speed_mps > 20 (physically implausible);
--                        such punches never count towards speed records
-- Message numbers are capped at 1,000,000 before formatting, so an absurd
-- client value can never make the cast fail (a failing INSERT would leave the
-- batch in the stream and fail again every minute).
-- Rows from the sql/verify.sql fixture (player_id 'verify-...') are ignored:
-- an append-only stream keeps inserted rows even after they are deleted.
-- -----------------------------------------------------------------------------
ALTER TASK IF EXISTS MOTION_DB.PUBLIC.T_HIGHLIGHTS SUSPEND;

CREATE OR REPLACE TASK MOTION_DB.PUBLIC.T_HIGHLIGHTS
  WAREHOUSE = MOTION_WH
  SCHEDULE = '1 MINUTE'
  TIMEZONE = 'UTC'
  COMMENT = 'Writes HIGHLIGHTS from new MOTION_EVENTS rows (records, milestones, suspicious speeds)'
  WHEN SYSTEM$STREAM_HAS_DATA('MOTION_DB.PUBLIC.MOTION_EVENTS_HL_STREAM')
AS
INSERT INTO MOTION_DB.PUBLIC.HIGHLIGHTS (kind, player_id, name, session_id, value, unit, message)
WITH batch AS (
  SELECT
    event_id, session_id, player_id, event_ts, speed_mps, reaction_ms,
    CASE WHEN LOWER(event_type) IN ('jab', 'cross', 'hook', 'uppercut') THEN 1 ELSE 0 END AS is_punch
  FROM MOTION_DB.PUBLIC.MOTION_EVENTS_HL_STREAM
  WHERE METADATA$ACTION = 'INSERT'
    AND player_id IS NOT NULL
    AND player_id NOT LIKE 'verify-%'   -- fixture rows from sql/verify.sql
    AND LOWER(COALESCE(sport, 'boxing')) = 'boxing'
),
hist AS (
  SELECT
    e.player_id, e.speed_mps, e.reaction_ms,
    CASE WHEN LOWER(e.event_type) IN ('jab', 'cross', 'hook', 'uppercut') THEN 1 ELSE 0 END AS is_punch
  FROM MOTION_DB.PUBLIC.MOTION_EVENTS e
  LEFT JOIN (SELECT DISTINCT event_id FROM batch WHERE event_id IS NOT NULL) b
    ON b.event_id = e.event_id
  WHERE b.event_id IS NULL
    AND e.player_id IS NOT NULL
    AND LOWER(COALESCE(e.sport, 'boxing')) = 'boxing'
),
hist_global AS (
  SELECT
    MAX(CASE WHEN is_punch = 1 AND speed_mps > 0 AND speed_mps <= 20 THEN speed_mps END) AS prev_max_speed,
    MIN(CASE WHEN reaction_ms >= 100 THEN reaction_ms END)                               AS prev_best_reaction
  FROM hist
),
hist_player AS (
  SELECT
    player_id,
    MAX(CASE WHEN is_punch = 1 AND speed_mps > 0 AND speed_mps <= 20 THEN speed_mps END) AS prev_max_speed,
    SUM(is_punch)                                                                        AS prev_punches
  FROM hist
  GROUP BY player_id
),
names AS (
  SELECT player_id, MAX(name) AS name
  FROM MOTION_DB.PUBLIC.PLAYERS
  GROUP BY player_id
),
top_speed AS (
  SELECT player_id, session_id, speed_mps AS value
  FROM batch
  WHERE is_punch = 1 AND speed_mps > 0 AND speed_mps <= 20
  QUALIFY ROW_NUMBER() OVER (ORDER BY speed_mps DESC, event_ts, event_id) = 1
),
speed_record AS (
  SELECT 'speed_record' AS kind, t.player_id, t.session_id, t.value::FLOAT AS value, 'm/s' AS unit
  FROM top_speed t
  CROSS JOIN hist_global g
  WHERE g.prev_max_speed IS NULL OR t.value > g.prev_max_speed
),
top_reaction AS (
  SELECT player_id, session_id, reaction_ms AS value
  FROM batch
  WHERE reaction_ms >= 100   -- below 100 ms is not humanly plausible (frame-timing artifact)
  QUALIFY ROW_NUMBER() OVER (ORDER BY reaction_ms ASC, event_ts, event_id) = 1
),
reaction_record AS (
  SELECT 'reaction_record' AS kind, t.player_id, t.session_id, t.value::FLOAT AS value, 'ms' AS unit
  FROM top_reaction t
  CROSS JOIN hist_global g
  WHERE g.prev_best_reaction IS NULL OR t.value < g.prev_best_reaction
),
player_top AS (
  SELECT player_id, session_id, speed_mps AS value
  FROM batch
  WHERE is_punch = 1 AND speed_mps > 0 AND speed_mps <= 20
  QUALIFY ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY speed_mps DESC, event_ts, event_id) = 1
),
personal_best AS (
  SELECT 'personal_best_speed' AS kind, p.player_id, p.session_id, p.value::FLOAT AS value, 'm/s' AS unit
  FROM player_top p
  JOIN hist_player h ON h.player_id = p.player_id
  LEFT JOIN speed_record r ON r.player_id = p.player_id
  WHERE h.prev_max_speed IS NOT NULL
    AND p.value > h.prev_max_speed
    AND r.player_id IS NULL
),
batch_player AS (
  SELECT player_id, session_id, new_punches
  FROM (
    SELECT
      player_id, session_id,
      SUM(is_punch) OVER (PARTITION BY player_id) AS new_punches,
      ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY event_ts DESC NULLS LAST, event_id DESC) AS rn
    FROM batch
  ) x
  WHERE rn = 1
),
milestone AS (
  SELECT 'punch_milestone' AS kind, b.player_id, b.session_id, MAX(v.m)::FLOAT AS value, 'punches' AS unit
  FROM batch_player b
  LEFT JOIN hist_player h ON h.player_id = b.player_id
  JOIN (SELECT * FROM (VALUES (100), (500), (1000), (5000)) AS mv (m)) v
    ON COALESCE(h.prev_punches, 0) < v.m
   AND COALESCE(h.prev_punches, 0) + b.new_punches >= v.m
  GROUP BY b.player_id, b.session_id
),
suspicious AS (
  SELECT 'suspicious_speed' AS kind, player_id, session_id, speed_mps::FLOAT AS value, 'm/s' AS unit
  FROM batch
  WHERE is_punch = 1 AND speed_mps > 20
  QUALIFY ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY speed_mps DESC, event_ts, event_id) = 1
),
hl AS (
  SELECT kind, player_id, session_id, value, unit FROM speed_record
  UNION ALL
  SELECT kind, player_id, session_id, value, unit FROM reaction_record
  UNION ALL
  SELECT kind, player_id, session_id, value, unit FROM personal_best
  UNION ALL
  SELECT kind, player_id, session_id, value, unit FROM milestone
  UNION ALL
  SELECT kind, player_id, session_id, value, unit FROM suspicious
)
SELECT
  h.kind,
  h.player_id,
  COALESCE(n.name, 'Unknown') AS name,
  h.session_id,
  h.value,
  h.unit,
  CASE h.kind
    WHEN 'speed_record' THEN
      'New fastest punch: ' || TO_VARCHAR(ROUND(LEAST(h.value, 1000000), 1)::NUMBER(12, 1)) || ' m/s by ' || COALESCE(n.name, 'Unknown')
    WHEN 'reaction_record' THEN
      'New fastest reaction: ' || TO_VARCHAR(ROUND(LEAST(h.value, 1000000), 0)::NUMBER(12, 0)) || ' ms by ' || COALESCE(n.name, 'Unknown')
    WHEN 'personal_best_speed' THEN
      'Personal best: ' || COALESCE(n.name, 'Unknown') || ' hit ' || TO_VARCHAR(ROUND(LEAST(h.value, 1000000), 1)::NUMBER(12, 1)) || ' m/s'
    WHEN 'punch_milestone' THEN
      COALESCE(n.name, 'Unknown') || ' reached ' || TO_VARCHAR(ROUND(LEAST(h.value, 1000000), 0)::NUMBER(12, 0)) || ' punches'
    WHEN 'suspicious_speed' THEN
      'Suspicious punch speed: ' || TO_VARCHAR(ROUND(LEAST(h.value, 1000000), 1)::NUMBER(12, 1)) || ' m/s by ' || COALESCE(n.name, 'Unknown')
        || ' (over 20 m/s, not counted for records)'
  END AS message
FROM hl h
LEFT JOIN names n ON n.player_id = h.player_id;

-- -----------------------------------------------------------------------------
-- V_HIGHLIGHTS_FEED: latest 50 highlights, newest first (same columns as HIGHLIGHTS).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW MOTION_DB.PUBLIC.V_HIGHLIGHTS_FEED
  COMMENT = 'Latest 50 HIGHLIGHTS rows, newest first'
AS
SELECT highlight_id, created_at, kind, player_id, name, session_id, value, unit, message
FROM MOTION_DB.PUBLIC.HIGHLIGHTS
ORDER BY created_at DESC, highlight_id DESC
LIMIT 50;

-- -----------------------------------------------------------------------------
-- Grants (explicit; setup.sql also has FUTURE grants for views / DTs / tables).
-- CREATE OR REPLACE drops grants on the old object, so these run every time.
-- All idempotent. Views run with the owner's rights, so SELECT on the view is
-- enough to read PLAYER_FORM / PRO_BENCHMARKS through it.
-- MONITOR on the DTs lets the roles read DYNAMIC_TABLE_REFRESH_HISTORY.
-- MONITOR on the task lets the server read TASK_HISTORY for /api/snowflake/status.
-- SELECT on the stream lets the server call SYSTEM$STREAM_HAS_DATA; a plain
-- SELECT never advances the stream offset (only DML that reads it does).
-- -----------------------------------------------------------------------------
GRANT SELECT, MONITOR ON DYNAMIC TABLE MOTION_DB.PUBLIC.SESSION_SUMMARY TO ROLE MOTION_APP_ROLE;
GRANT SELECT, MONITOR ON DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_PROGRESS TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON VIEW   MOTION_DB.PUBLIC.V_PLAYER_STYLE          TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON VIEW   MOTION_DB.PUBLIC.V_STYLE_TWINS           TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON VIEW   MOTION_DB.PUBLIC.V_HIGHLIGHTS_FEED       TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON TABLE  MOTION_DB.PUBLIC.HIGHLIGHTS              TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON STREAM MOTION_DB.PUBLIC.MOTION_EVENTS_HL_STREAM TO ROLE MOTION_APP_ROLE;
GRANT MONITOR ON TASK  MOTION_DB.PUBLIC.T_HIGHLIGHTS            TO ROLE MOTION_APP_ROLE;

GRANT SELECT, MONITOR ON DYNAMIC TABLE MOTION_DB.PUBLIC.SESSION_SUMMARY TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT, MONITOR ON DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_PROGRESS TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON VIEW   MOTION_DB.PUBLIC.V_PLAYER_STYLE          TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON VIEW   MOTION_DB.PUBLIC.V_STYLE_TWINS           TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON VIEW   MOTION_DB.PUBLIC.V_HIGHLIGHTS_FEED       TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON TABLE  MOTION_DB.PUBLIC.HIGHLIGHTS              TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON STREAM MOTION_DB.PUBLIC.MOTION_EVENTS_HL_STREAM TO ROLE MOTION_READONLY_ROLE;

-- Optional: let the app force a run (EXECUTE TASK) or a DT refresh after a round:
-- GRANT OPERATE ON TASK MOTION_DB.PUBLIC.T_HIGHLIGHTS TO ROLE MOTION_APP_ROLE;
-- GRANT OPERATE ON DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_PROGRESS TO ROLE MOTION_APP_ROLE;

-- -----------------------------------------------------------------------------
-- Start the task last (tasks are created suspended). ACCOUNTADMIN owns it and
-- has EXECUTE TASK on the account, so it can run.
-- -----------------------------------------------------------------------------
ALTER TASK MOTION_DB.PUBLIC.T_HIGHLIGHTS RESUME;
