-- =============================================================================
-- Motion Boxing on Snowflake: smoke checks. Run after setup.sql + analytics.sql.
-- Run section by section in Snowsight. Most checks return rows labelled
-- 'OK' / 'FAIL'; anything returning FAIL (or erroring) needs a look.
-- Section 4 inserts a small 'verify-*' fixture and section 6 deletes it again.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE MOTION_WH;
USE SCHEMA MOTION_DB.PUBLIC;

-- -----------------------------------------------------------------------------
-- 1. Objects exist with the expected settings
-- -----------------------------------------------------------------------------
SHOW WAREHOUSES LIKE 'MOTION_WH';          -- size X-Small, auto_suspend 300, auto_resume true
SHOW TABLES IN SCHEMA MOTION_DB.PUBLIC;    -- PLAYERS, SESSIONS, MOTION_EVENTS, PRO_BENCHMARKS (+ PLAYER_FORM)
SHOW VIEWS IN SCHEMA MOTION_DB.PUBLIC;     -- 5 x V_*
SHOW DYNAMIC TABLES LIKE 'PLAYER_FORM' IN SCHEMA MOTION_DB.PUBLIC;
-- expect: target_lag '1 minute', warehouse MOTION_WH, refresh_mode FULL, scheduling_state ACTIVE

SELECT table_name,
       CASE WHEN COUNT(*) > 0 THEN 'OK' ELSE 'FAIL' END AS status,
       COUNT(*) AS columns
FROM MOTION_DB.INFORMATION_SCHEMA.COLUMNS
WHERE table_schema = 'PUBLIC'
  AND table_name IN ('PLAYERS', 'SESSIONS', 'MOTION_EVENTS', 'PRO_BENCHMARKS', 'PLAYER_FORM',
                     'V_LEADERBOARD', 'V_GLOBAL_STATS', 'V_SESSION_STATS',
                     'V_SPEED_OVER_TIME', 'V_FATIGUE_CURVE')
GROUP BY table_name
ORDER BY table_name;                       -- expect 10 rows

-- -----------------------------------------------------------------------------
-- 2. Benchmarks: six boxing metrics, strictly ascending percentiles
-- -----------------------------------------------------------------------------
SELECT metric, p25, p50, p75, p90, pro_avg, higher_is_better,
       CASE WHEN p25 < p50 AND p50 < p75 AND p75 < p90 THEN 'OK' ELSE 'FAIL' END AS status
FROM PRO_BENCHMARKS
WHERE sport = 'boxing'
ORDER BY metric;                           -- expect 6 rows, all OK

SELECT CASE WHEN COUNT(*) = 6 THEN 'OK' ELSE 'FAIL' END AS six_metrics_status, COUNT(*) AS n
FROM PRO_BENCHMARKS WHERE sport = 'boxing';

-- -----------------------------------------------------------------------------
-- 3. Grants for the app role
-- -----------------------------------------------------------------------------
SHOW GRANTS TO ROLE MOTION_APP_ROLE;
-- expect: USAGE+OPERATE on MOTION_WH; USAGE on MOTION_DB and MOTION_DB.PUBLIC;
-- SELECT/INSERT/UPDATE/DELETE on PLAYERS, SESSIONS, MOTION_EVENTS; SELECT on PRO_BENCHMARKS;
-- SELECT on 5 views; SELECT+MONITOR on PLAYER_FORM; database role SNOWFLAKE.CORTEX_USER
SHOW FUTURE GRANTS IN SCHEMA MOTION_DB.PUBLIC;

-- -----------------------------------------------------------------------------
-- 4. Fixture: one player, one 16-punch round that slows down, then refresh.
--    Uses fixed ids prefixed 'verify-' so it can be removed in section 6.
-- -----------------------------------------------------------------------------
INSERT INTO PLAYERS (player_id, name) VALUES ('verify-player-1', 'Verify Bot');

INSERT INTO SESSIONS (session_id, player_id, sport, started_at)
VALUES ('verify-session-1', 'verify-player-1', 'boxing', '2026-01-01 10:00:00'::TIMESTAMP_NTZ);

-- 16 punches, 5 s apart, speed 9.0 -> 6.0 m/s, alternating L/R, cycling punch types,
-- guard down every 4th punch; plus 2 blocks.
INSERT INTO MOTION_EVENTS
  (session_id, player_id, sport, event_ts, event_type, hand, speed_mps, accuracy, reaction_ms, guard_up, points)
SELECT
  'verify-session-1', 'verify-player-1', 'boxing',
  DATEADD('second', i * 5, '2026-01-01 10:00:00'::TIMESTAMP_NTZ),
  DECODE(MOD(i, 4), 0, 'jab', 1, 'cross', 2, 'hook', 'uppercut'),
  IFF(MOD(i, 2) = 0, 'L', 'R'),
  9.0 - i * 0.2,
  0.8,
  220 + i * 5,
  MOD(i, 4) <> 3,
  10
FROM (SELECT ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1 AS i FROM TABLE(GENERATOR(ROWCOUNT => 16)));

INSERT INTO MOTION_EVENTS
  (session_id, player_id, sport, event_ts, event_type, hand, speed_mps, accuracy, reaction_ms, guard_up, points)
SELECT 'verify-session-1', 'verify-player-1', 'boxing',
       '2026-01-01 10:01:30'::TIMESTAMP_NTZ, 'block', 'L', 0, NULL, 300, NULL, 5;

-- VARIANT columns cannot be bound inside VALUES; use INSERT ... SELECT PARSE_JSON(...)
-- (server note). Quick check that the pattern works:
INSERT INTO MOTION_EVENTS
  (session_id, player_id, sport, event_ts, event_type, hand, speed_mps, accuracy, reaction_ms, guard_up, points, payload)
SELECT 'verify-session-1', 'verify-player-1', 'boxing',
       '2026-01-01 10:01:35'::TIMESTAMP_NTZ, 'block', 'R', 0, NULL, NULL, NULL, 5,
       PARSE_JSON('{"source":"verify.sql"}');

-- Force the dynamic table to pick up the fixture now instead of waiting ~1 minute.
ALTER DYNAMIC TABLE PLAYER_FORM REFRESH;

SELECT name, state, refresh_action, refresh_trigger, state_message,
       refresh_start_time, refresh_end_time
FROM TABLE(MOTION_DB.INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(
       NAME => 'MOTION_DB.PUBLIC.PLAYER_FORM'))
ORDER BY refresh_start_time DESC
LIMIT 5;                                   -- expect latest state SUCCEEDED

-- -----------------------------------------------------------------------------
-- 5. Analytics checks against the fixture
-- -----------------------------------------------------------------------------
-- Expected: punches 16, sessions 1, avg_speed 7.5, max_speed 9.0, fatigue_drop_pct ~27.6,
-- symmetry_pct ~98.7 (8L/8R, L avg 7.6 vs R 7.4 m/s), guard_pct 75, mix 22.2 x4 + block 11.1, form_score in 0..100.
SELECT *,
       CASE WHEN punches = 16
             AND fatigue_drop_pct > 0
             AND symmetry_pct BETWEEN 98 AND 99.5
             AND guard_pct = 75
             AND form_score BETWEEN 0 AND 100
             AND ABS(mix_jab_pct + mix_cross_pct + mix_hook_pct + mix_uppercut_pct + mix_block_pct - 100) < 1
            THEN 'OK' ELSE 'FAIL' END AS status
FROM PLAYER_FORM
WHERE player_id = 'verify-player-1';

-- No player anywhere may have form_score outside 0..100 or NULL.
SELECT CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'FAIL' END AS form_score_range_status,
       COUNT(*) AS bad_rows
FROM PLAYER_FORM
WHERE form_score IS NULL OR form_score < 0 OR form_score > 100;

-- One row per player.
SELECT CASE WHEN COUNT(*) = COUNT(DISTINCT player_id) THEN 'OK' ELSE 'FAIL' END AS one_row_per_player
FROM PLAYER_FORM;

-- Session stats: score = 16*10 + 2*5 = 170, total_punches 16, max_speed 9.0, best_reaction_ms 220.
SELECT *,
       CASE WHEN score = 170 AND total_punches = 16 AND max_speed = 9.0 AND best_reaction_ms = 220
                 AND accuracy = 0.8 AND total_blocks = 2
            THEN 'OK' ELSE 'FAIL' END AS status
FROM V_SESSION_STATS
WHERE session_id = 'verify-session-1';

-- Fatigue curve: 4 quartiles, speed falling Q1 -> Q4 (8.7, 7.9, 7.1, 6.3).
SELECT * FROM V_FATIGUE_CURVE WHERE player_id = 'verify-player-1' ORDER BY quartile;

-- Speed over time: 10 s buckets 0..7, 2 punches each.
SELECT * FROM V_SPEED_OVER_TIME WHERE session_id = 'verify-session-1' ORDER BY bucket;

-- Leaderboard: at most 10 rows, ranks 1..n, best_score non-increasing.
SELECT * FROM V_LEADERBOARD ORDER BY rank;
SELECT CASE WHEN COUNT(*) <= 10
             AND MIN(rank) = 1 AND MAX(rank) = COUNT(*)
             AND COUNT_IF(best_score > prev_score) = 0
            THEN 'OK' ELSE 'FAIL' END AS leaderboard_status
FROM (SELECT rank, best_score, LAG(best_score) OVER (ORDER BY rank) AS prev_score FROM V_LEADERBOARD);

SELECT * FROM V_GLOBAL_STATS;              -- one row, totals >= fixture

-- -----------------------------------------------------------------------------
-- 5b. Same checks as the APP ROLE (needs: GRANT ROLE MOTION_APP_ROLE TO USER <you>)
-- -----------------------------------------------------------------------------
-- USE ROLE MOTION_APP_ROLE;
-- USE WAREHOUSE MOTION_WH;
-- SELECT COUNT(*) FROM PLAYER_FORM;
-- SELECT * FROM V_LEADERBOARD ORDER BY rank;
-- SELECT * FROM V_SESSION_STATS WHERE session_id = 'verify-session-1';
-- SELECT * FROM PRO_BENCHMARKS;
-- UPDATE SESSIONS SET ended_at = CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,
--        ai_coach_json = PARSE_JSON('{"tips":["a","b","c"],"drill":"d","badge":"b","summary":"s"}')
--  WHERE session_id = 'verify-session-1';
-- -- Cortex access (use the same model the server uses):
-- SELECT SNOWFLAKE.CORTEX.COMPLETE('mistral-large2', 'Reply with the single word OK.') AS cortex_reply;
-- -- Must FAIL (least privilege): app role cannot drop or create objects.
-- DROP TABLE PLAYERS;
-- USE ROLE ACCOUNTADMIN;

-- -----------------------------------------------------------------------------
-- 6. Clean up the fixture
-- -----------------------------------------------------------------------------
DELETE FROM MOTION_EVENTS WHERE session_id = 'verify-session-1';
DELETE FROM SESSIONS      WHERE session_id = 'verify-session-1';
DELETE FROM PLAYERS       WHERE player_id  = 'verify-player-1';
ALTER DYNAMIC TABLE PLAYER_FORM REFRESH;
SELECT CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'FAIL' END AS fixture_removed
FROM PLAYER_FORM WHERE player_id = 'verify-player-1';
