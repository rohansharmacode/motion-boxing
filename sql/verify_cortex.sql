-- =============================================================================
-- Motion Boxing on Snowflake: checks for sql/cortex.sql (read-only)
-- Run after cortex.sql:  cd scripts && npx tsx src/run-sql.ts ../sql/verify_cortex.sql
-- or paste into a Snowsight worksheet. Nothing here creates, changes or deletes objects.
-- Sections 5 and 6 make three tiny AI calls (a few hundred tokens in total).
-- Each check says what a good result looks like and the most likely error with its fix.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE MOTION_WH;
USE SCHEMA MOTION_DB.PUBLIC;

-- Same model as cortex.sql (and as CORTEX_MODEL in server/.env).
SET CORTEX_MODEL = 'mistral-large3';

-- -----------------------------------------------------------------------------
-- 1. Drill catalogue
-- Good: drills = 32, focuses = 8, levels = 3, missing_search_text = 0.
-- Error "Object 'COACH_DRILLS' does not exist": cortex.sql has not run (or ran as another role).
-- -----------------------------------------------------------------------------
SELECT COUNT(*)                       AS drills,
       COUNT(DISTINCT focus)          AS focuses,
       COUNT(DISTINCT level)          AS levels,
       COUNT_IF(search_text IS NULL)  AS missing_search_text
FROM MOTION_DB.PUBLIC.COACH_DRILLS;

-- -----------------------------------------------------------------------------
-- 2. Cortex Search service
-- Good: one row named COACH_DRILL_SEARCH; DESCRIBE shows the search column SEARCH_TEXT,
-- attributes FOCUS, LEVEL, and indexing / serving states that are ACTIVE (not FAILED).
-- Error "Unsupported feature" or "Unknown ... CORTEX SEARCH": the account region does not offer
-- Cortex Search; the server then falls back to the local drill list (source 'mock').
-- An indexing error usually means MOTION_WH was suspended without AUTO_RESUME or the
-- creating role lacked SNOWFLAKE.CORTEX_USER: re-run setup.sql, then cortex.sql.
-- -----------------------------------------------------------------------------
SHOW CORTEX SEARCH SERVICES IN SCHEMA MOTION_DB.PUBLIC;
DESCRIBE CORTEX SEARCH SERVICE MOTION_DB.PUBLIC.COACH_DRILL_SEARCH;

-- -----------------------------------------------------------------------------
-- 3. SEARCH_PREVIEW: "keep my guard up", focus = guard
-- Good (raw): {"results": [{"drill_id": "grd-..", "title": ..., "focus": "guard", ...}, ...], "request_id": "..."}
-- with up to 3 results, all with focus guard. The second query shows the same as rows.
-- Error "Your service has not yet been loaded into our serving system": wait a few minutes and retry.
-- Error "does not exist or not authorized": re-run cortex.sql (its GRANT USAGE lines), or you are
-- on a role without USAGE on the service.
-- Error about non-constant arguments: the JSON must be a literal (as here), never a column or bind.
-- -----------------------------------------------------------------------------
SELECT SNOWFLAKE.CORTEX.SEARCH_PREVIEW(
  'MOTION_DB.PUBLIC.COACH_DRILL_SEARCH',
  $${"query": "keep my guard up", "columns": ["drill_id","title","focus","level","description","cues"], "filter": {"@eq": {"focus": "guard"}}, "limit": 3}$$
) AS response;

SELECT r.value:drill_id::STRING AS drill_id,
       r.value:title::STRING    AS title,
       r.value:focus::STRING    AS focus,
       r.value:level::STRING    AS level,
       r.value:cues::STRING     AS cues
FROM TABLE(FLATTEN(INPUT => PARSE_JSON(TO_VARCHAR(SNOWFLAKE.CORTEX.SEARCH_PREVIEW(
  'MOTION_DB.PUBLIC.COACH_DRILL_SEARCH',
  $${"query": "keep my guard up", "columns": ["drill_id","title","focus","level","description","cues"], "filter": {"@eq": {"focus": "guard"}}, "limit": 3}$$
)))['results'])) r;

-- -----------------------------------------------------------------------------
-- 4. Stream + task + scouting rows
-- Stream good: one row, source_type Table, mode APPEND_ONLY, stale false.
-- HAS_DATA: TRUE right after cortex.sql (initial rows) or after new punches; FALSE after a run.
-- Task good: state = started, schedule 5 MINUTE, condition SYSTEM$STREAM_HAS_DATA(...).
-- If state = suspended after failures: read TASK_HISTORY below, fix, then
--   ALTER TASK MOTION_DB.PUBLIC.T_SCOUTING RESUME;
-- -----------------------------------------------------------------------------
SHOW STREAMS LIKE 'PLAYER_FORM_STREAM' IN SCHEMA MOTION_DB.PUBLIC;
SELECT SYSTEM$STREAM_HAS_DATA('MOTION_DB.PUBLIC.PLAYER_FORM_STREAM') AS has_data;
SHOW TASKS LIKE 'T_SCOUTING' IN SCHEMA MOTION_DB.PUBLIC;

-- Task runs of the last 24 hours.
-- Good: SUCCEEDED rows (SKIPPED rows are fine: the stream was empty, so the run cost nothing).
-- No rows yet: the first run is at most 5 minutes away; force one with
--   EXECUTE TASK MOTION_DB.PUBLIC.T_SCOUTING;
-- FAILED with a model error (for example "model ... is not available" or "unknown model"):
--   ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';  or change mistral-large3 in
--   cortex.sql to a model your region has (llama3.3-70b, claude-haiku-4-5), re-run cortex.sql.
-- FAILED with "Unknown function AI_CLASSIFY": use the CLASSIFY_TEXT fallback noted in cortex.sql.
SELECT name, state, scheduled_time, completed_time, error_code, error_message
FROM TABLE(MOTION_DB.INFORMATION_SCHEMA.TASK_HISTORY(
  SCHEDULED_TIME_RANGE_START => DATEADD('hour', -24, CURRENT_TIMESTAMP()),
  RESULT_LIMIT => 50,
  TASK_NAME => 'T_SCOUTING'))
ORDER BY scheduled_time DESC;

-- Scouting cards.
-- Good: one row per player with >= 10 punches, fighting_style is one of Out-boxer, Swarmer, Slugger,
-- Boxer-puncher, Counter-puncher, scouting_report is 1-2 upbeat sentences that quote real numbers,
-- punches_at_scan matches PLAYER_FORM.punches (in_sync = TRUE) once the task has caught up.
-- A report starting "<name> shows a ... style with ..." is the template used when AI_COMPLETE
-- returned nothing: check the AI_COMPLETE smoke test below.
SELECT s.player_id, s.name, s.fighting_style, s.scouting_report,
       s.punches_at_scan, f.punches AS punches_now, (s.punches_at_scan = f.punches) AS in_sync,
       s.form_score_at_scan, s.updated_at
FROM MOTION_DB.PUBLIC.PLAYER_SCOUTING s
LEFT JOIN MOTION_DB.PUBLIC.PLAYER_FORM f ON f.player_id = s.player_id
ORDER BY s.updated_at DESC
LIMIT 20;

SELECT fighting_style, COUNT(*) AS players
FROM MOTION_DB.PUBLIC.PLAYER_SCOUTING
GROUP BY fighting_style
ORDER BY players DESC;

-- -----------------------------------------------------------------------------
-- 5. AI_CLASSIFY smoke test (one row)
-- Good: {"labels": ["Out-boxer"]} (an Out-boxer profile; another label is not an error).
-- Error "Unknown function AI_CLASSIFY": older account / region; try
--   SELECT SNOWFLAKE.CORTEX.CLASSIFY_TEXT('...', ['Out-boxer','Swarmer','Slugger','Boxer-puncher','Counter-puncher']);
-- Error about privileges: GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE <your role>;
-- -----------------------------------------------------------------------------
SELECT AI_CLASSIFY(
  'Boxer stats from a webcam boxing game. Average hand speed 7.8 m/s. Reaction time 240 ms. Accuracy 84 percent. Guard kept up on 88 percent of punches. Punch mix: jab 55 percent, cross 30 percent, hook 10 percent, uppercut 5 percent.',
  ['Out-boxer', 'Swarmer', 'Slugger', 'Boxer-puncher', 'Counter-puncher']
) AS classify_result;

-- -----------------------------------------------------------------------------
-- 6. AI_COMPLETE smoke tests
-- 6a plain text. Good: a short string such as "ready".
-- 6b structured output. Good: an OBJECT like {"focus": "guard"} (not a string).
-- Error "Model ... not available in your region" / "unavailable":
--   ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';  (ACCOUNTADMIN)
-- Error naming a legacy or unknown model: pick another model (llama3.3-70b, claude-haiku-4-5,
-- claude-sonnet-4-6), change SET CORTEX_MODEL above, cortex.sql and CORTEX_MODEL in server/.env.
-- Error "Unknown function AI_COMPLETE": use SNOWFLAKE.CORTEX.COMPLETE($CORTEX_MODEL, 'Reply with the single word: ready').
-- -----------------------------------------------------------------------------
SELECT AI_COMPLETE($CORTEX_MODEL, 'Reply with the single word: ready') AS reply;

SELECT AI_COMPLETE(
  model => $CORTEX_MODEL,
  prompt => 'A boxer keeps dropping their rear hand after every punch. Which single focus area should they train?',
  model_parameters => {'temperature': 0, 'max_tokens': 50},
  response_format => {
    'type': 'json',
    'schema': {
      'type': 'object',
      'properties': {
        'focus': {'type': 'string', 'enum': ['speed', 'reaction', 'accuracy', 'guard', 'symmetry', 'endurance', 'combos', 'footwork']}
      },
      'required': ['focus'],
      'additionalProperties': false
    }
  }
) AS structured_reply;

-- -----------------------------------------------------------------------------
-- 7. Optional: check the app role's grants (needs: GRANT ROLE MOTION_APP_ROLE TO USER <you>;)
-- Good: same results as sections 1, 3 and 4 above.
-- USE ROLE MOTION_APP_ROLE;
-- SELECT COUNT(*) FROM MOTION_DB.PUBLIC.COACH_DRILLS;
-- SELECT COUNT(*) FROM MOTION_DB.PUBLIC.PLAYER_SCOUTING;
-- SELECT SNOWFLAKE.CORTEX.SEARCH_PREVIEW('MOTION_DB.PUBLIC.COACH_DRILL_SEARCH', $${"query": "faster hands", "columns": ["drill_id","title"], "limit": 2}$$);
-- SHOW TASKS LIKE 'T_SCOUTING' IN SCHEMA MOTION_DB.PUBLIC;
-- -----------------------------------------------------------------------------
