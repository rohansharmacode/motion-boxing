-- =============================================================================
-- Motion Boxing on Snowflake: read-only checks for sql/pipelines.sql.
-- Run after pipelines.sql, as ACCOUNTADMIN:
--   cd scripts && npx tsx src/run-sql.ts ../sql/verify_pipelines.sql
-- or section by section in a Snowsight worksheet. Nothing here writes data.
-- Checks that return a status column say 'OK' or 'FAIL'.
-- Right after the first run the DTs may still be initialising and the task may
-- not have run yet: wait 1 to 2 minutes (and play a round) before judging.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE MOTION_WH;
USE SCHEMA MOTION_DB.PUBLIC;

-- -----------------------------------------------------------------------------
-- 1. Dynamic tables
-- -----------------------------------------------------------------------------
SHOW DYNAMIC TABLES IN SCHEMA MOTION_DB.PUBLIC;
-- good: SESSION_SUMMARY (target_lag DOWNSTREAM) and PLAYER_PROGRESS (target_lag
-- 1 minute), both warehouse MOTION_WH, refresh_mode FULL, scheduling_state ACTIVE
-- (PLAYER_FORM from analytics.sql is listed too).

SELECT player_id, session_id, session_start_ts, session_index, score, punches,
       avg_speed, max_speed, avg_reaction_ms, accuracy_pct, guard_pct
FROM MOTION_DB.PUBLIC.SESSION_SUMMARY
ORDER BY player_id, session_index
LIMIT 20;
-- good: one row per (player, session); session_index 1, 2, 3 ... per player;
-- accuracy_pct and guard_pct between 0 and 100.

SELECT CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'FAIL' END AS session_index_status,
       COUNT(*) AS players_with_gaps
FROM (
  SELECT player_id
  FROM MOTION_DB.PUBLIC.SESSION_SUMMARY
  GROUP BY player_id
  HAVING MIN(session_index) <> 1 OR MAX(session_index) <> COUNT(*)
     OR COUNT(*) <> COUNT(DISTINCT session_id)
) x;
-- good: OK (session_index is 1..n with no gaps, one row per session).

SELECT player_id, sessions, first_session_ts, last_session_ts, best_score, last_score,
       speed_trend_mps_per_session, score_trend_per_session,
       accuracy_trend_pct_per_session, reaction_trend_ms_per_session, improving
FROM MOTION_DB.PUBLIC.PLAYER_PROGRESS
ORDER BY sessions DESC, player_id
LIMIT 20;
-- good: one row per player; trends NULL only where sessions = 1;
-- improving TRUE exactly where score_trend_per_session > 0.

SELECT CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'FAIL' END AS progress_status, COUNT(*) AS bad_rows
FROM MOTION_DB.PUBLIC.PLAYER_PROGRESS
WHERE (sessions < 2 AND score_trend_per_session IS NOT NULL)
   OR (sessions >= 2 AND score_trend_per_session IS NULL)
   OR (improving <> COALESCE(score_trend_per_session > 0, FALSE) AND score_trend_per_session <> 0)
   OR best_score < last_score;
-- good: OK.

SELECT name, state, refresh_action, refresh_trigger, data_timestamp,
       refresh_start_time, refresh_end_time, state_message
FROM TABLE(MOTION_DB.INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(
  NAME => 'MOTION_DB.PUBLIC.SESSION_SUMMARY'))
ORDER BY refresh_start_time DESC
LIMIT 10;
-- good: state SUCCEEDED (an INITIAL row first, then FULL / NO_DATA rows),
-- no FAILED rows. SESSION_SUMMARY refreshes only when PLAYER_PROGRESS does.

SELECT name, state, refresh_action, refresh_trigger, data_timestamp,
       refresh_start_time, refresh_end_time, state_message
FROM TABLE(MOTION_DB.INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(
  NAME => 'MOTION_DB.PUBLIC.PLAYER_PROGRESS'))
ORDER BY refresh_start_time DESC
LIMIT 10;
-- good: state SUCCEEDED, roughly one row per minute while events arrive
-- (NO_DATA when nothing changed). FAILED rows: read state_message.

-- -----------------------------------------------------------------------------
-- 2. Style vectors
-- -----------------------------------------------------------------------------
SELECT player_id, name, c_speed, c_reaction, c_accuracy, c_guard, c_symmetry, c_endurance,
       pro_similarity_pct
FROM MOTION_DB.PUBLIC.V_PLAYER_STYLE
ORDER BY pro_similarity_pct DESC NULLS LAST, player_id
LIMIT 20;
-- good: one row per player with punches > 0; components 0..100;
-- pro_similarity_pct 0..100 (NULL only if all six components are exactly 50).

SELECT CASE WHEN COUNT(*) = 0 OR MIN(self_sim) > 0.999 THEN 'OK' ELSE 'FAIL' END AS vector_status,
       COUNT(*) AS players, MIN(self_sim) AS min_self_similarity
FROM (
  SELECT VECTOR_COSINE_SIMILARITY(style_vec, style_vec) AS self_sim
  FROM MOTION_DB.PUBLIC.V_PLAYER_STYLE
  WHERE NOT (c_speed = 50 AND c_reaction = 50 AND c_accuracy = 50
             AND c_guard = 50 AND c_symmetry = 50 AND c_endurance = 50)
) x;
-- good: OK (each style_vec is a valid VECTOR(FLOAT, 6); similarity with itself = 1).

SELECT player_id, name, twin_player_id, twin_name, similarity, similarity_pct
FROM MOTION_DB.PUBLIC.V_STYLE_TWINS
ORDER BY similarity DESC, player_id
LIMIT 20;
-- good: at most one row per player, twin_player_id never equals player_id,
-- similarity between -1 and 1, similarity_pct between 0 and 100.

SELECT CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'FAIL' END AS twins_status, COUNT(*) AS bad_rows
FROM (
  SELECT player_id, COUNT(*) AS n, MAX(IFF(twin_player_id = player_id, 1, 0)) AS self_twin
  FROM MOTION_DB.PUBLIC.V_STYLE_TWINS
  GROUP BY player_id
  HAVING COUNT(*) > 1 OR MAX(IFF(twin_player_id = player_id, 1, 0)) = 1
) x;
-- good: OK.

-- -----------------------------------------------------------------------------
-- 3. Stream + task + highlights
-- -----------------------------------------------------------------------------
SHOW STREAMS LIKE 'MOTION_EVENTS_HL_STREAM' IN SCHEMA MOTION_DB.PUBLIC;
-- good: one row, mode APPEND_ONLY, stale false, table_name MOTION_EVENTS.

SELECT SYSTEM$STREAM_HAS_DATA('MOTION_DB.PUBLIC.MOTION_EVENTS_HL_STREAM') AS stream_has_data;
-- good: FALSE when the task has caught up; TRUE for up to about a minute after
-- new events arrive. TRUE for several minutes means the task is not running.

SHOW TASKS LIKE 'T_HIGHLIGHTS' IN SCHEMA MOTION_DB.PUBLIC;
-- good: state started, schedule 1 MINUTE, warehouse MOTION_WH,
-- condition SYSTEM$STREAM_HAS_DATA(...).

SELECT name, state, scheduled_time, completed_time, error_code, error_message
FROM TABLE(MOTION_DB.INFORMATION_SCHEMA.TASK_HISTORY(
  TASK_NAME => 'T_HIGHLIGHTS',
  RESULT_LIMIT => 20))
ORDER BY scheduled_time DESC;
-- good: mostly SKIPPED rows while nobody plays (WHEN was false, no warehouse
-- used), SUCCEEDED rows after new events, no FAILED rows. One SCHEDULED row
-- for the next run is normal.

SHOW GRANTS ON TASK MOTION_DB.PUBLIC.T_HIGHLIGHTS;
-- good: OWNERSHIP to ACCOUNTADMIN, MONITOR to MOTION_APP_ROLE.

SELECT highlight_id, created_at, kind, player_id, name, session_id, value, unit, message
FROM MOTION_DB.PUBLIC.V_HIGHLIGHTS_FEED
ORDER BY created_at DESC, highlight_id DESC
LIMIT 20;
-- good: newest first; message like 'New fastest punch: 9.8 m/s by Sam'.
-- Empty is fine until someone plays after pipelines.sql was run (the stream
-- only sees events inserted after it was created).

SELECT kind, COUNT(*) AS n, MAX(created_at) AS latest
FROM MOTION_DB.PUBLIC.HIGHLIGHTS
GROUP BY kind
ORDER BY kind;
-- good: only the five kinds speed_record, reaction_record, personal_best_speed,
-- punch_milestone, suspicious_speed.

-- Manual run, for the demo or when you do not want to wait for the schedule
-- (for example right after `npm run seed`). The run is asynchronous: check
-- TASK_HISTORY above after a few seconds. Leave it commented for normal checks.
-- EXECUTE TASK MOTION_DB.PUBLIC.T_HIGHLIGHTS;

-- Force the dynamic table chain to refresh now instead of within a minute
-- (refreshing PLAYER_PROGRESS also refreshes SESSION_SUMMARY first):
-- ALTER DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_PROGRESS REFRESH;
