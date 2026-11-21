-- =============================================================================
-- Motion Boxing on Snowflake: Cortex AI layer (Cortex Search + AI functions in a Stream + Task)
-- Names and columns: sql/PLUS_CONTRACT.md, section "cortex.sql".
--
-- Objects (all in MOTION_DB.PUBLIC):
--   COACH_DRILLS          table, 32 original webcam-friendly drills (seeded with MERGE)
--   COACH_DRILL_SEARCH    Cortex Search service over COACH_DRILLS, used to ground the coach card
--   PLAYER_SCOUTING       table, one row per player: AI_CLASSIFY fighting style + AI_COMPLETE scouting report
--   PLAYER_FORM_STREAM    stream that tells T_SCOUTING when new punches arrived (see note in section 3)
--   T_SCOUTING            task, every 5 minutes but only when the stream has data, MERGEs PLAYER_SCOUTING
--   Section 4 (comments only): worksheet examples of the structured coach card (AI_COMPLETE response_format)
--
-- Run order (as ACCOUNTADMIN): setup.sql -> analytics.sql -> pipelines.sql -> cortex.sql -> semantic.sql
--   cd scripts && npx tsx src/run-sql.ts ../sql/cortex.sql
-- Then check with sql/verify_cortex.sql.
--
-- Safe to re-run:
--   * tables use CREATE TABLE IF NOT EXISTS (data is kept), drills are upserted with MERGE
--   * the search service, task and grants are re-created / re-granted every run
--   * the stream uses IF NOT EXISTS so its position is kept
--
-- Cost notes:
--   * COACH_DRILL_SEARCH: TARGET_LAG = '1 day', 32 small rows. The warehouse is used only when the
--     drills change; serving is billed per GB-month of indexed data (tiny here). After the event you
--     can stop serving: ALTER CORTEX SEARCH SERVICE MOTION_DB.PUBLIC.COACH_DRILL_SEARCH SUSPEND SERVING;
--   * T_SCOUTING: the WHEN SYSTEM$STREAM_HAS_DATA check runs in cloud services without a warehouse,
--     so an idle game costs nothing. A run calls AI only for players whose punch count changed,
--     with at least 10 punches, at most 25 players per run (2 AI calls each).
--     SUSPEND_TASK_AFTER_NUM_FAILURES = 3 stops a broken task (for example an unavailable model)
--     from waking the warehouse every 5 minutes.
--   * Section 4 is commented out, so running this file makes no AI call by itself.
--
-- No double slash outside strings or $$ blocks: scripts/src/sf.ts splitSql treats it as a comment.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE MOTION_WH;
USE SCHEMA MOTION_DB.PUBLIC;

-- -----------------------------------------------------------------------------
-- 0. Model
-- One model name for the worksheet examples in this file. The task body in section 3 cannot
-- see session variables (a task runs in its own session), so it repeats the literal:
-- if you change the model, change it in T_SCOUTING too (search for mistral-large3).
--
-- mistral-large3, not mistral-large2: mistral-large2 and llama3.1-70b became "legacy" models on
-- 2026-08-12, and an account that had not used them before that date gets an error naming the model
-- (docs.snowflake.com/en/release-notes/bcr-bundles/un-bundled/bcr-august-model-deprecations).
-- Alternatives, depending on region: llama3.3-70b, claude-haiku-4-5, claude-sonnet-4-6.
-- If the model is not hosted in your region:
--   ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';
-- AI_CLASSIFY is a managed function (no model name) and is not affected by model deprecations.
-- -----------------------------------------------------------------------------
SET CORTEX_MODEL = 'mistral-large3';

-- -----------------------------------------------------------------------------
-- 1. COACH_DRILLS: original drills for one person boxing in front of a webcam in a small space.
-- focus in speed | reaction | accuracy | guard | symmetry | endurance | combos | footwork
-- level in beginner | intermediate | advanced. cues = 2 or 3 short cues separated by " | ".
-- search_text = title + focus + description + cues (the column Cortex Search indexes).
-- The same rows are in sql/data/coach_drills.json (server mock mode and docs).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS MOTION_DB.PUBLIC.COACH_DRILLS (
  drill_id     STRING,
  title        STRING,
  focus        STRING,
  level        STRING,
  description  STRING,
  cues         STRING,
  search_text  STRING
)
CHANGE_TRACKING = TRUE
COMMENT = 'Coach drill catalogue indexed by the COACH_DRILL_SEARCH Cortex Search service';

-- No-op if already on. Cortex Search needs change tracking on its source table.
ALTER TABLE MOTION_DB.PUBLIC.COACH_DRILLS SET CHANGE_TRACKING = TRUE;

-- Upsert. Rows are only rewritten when a value really changed, so a re-run does not create
-- changes for the search service to pick up.
MERGE INTO MOTION_DB.PUBLIC.COACH_DRILLS t
USING (
  SELECT
    drill_id, title, focus, level, description, cues,
    title || '. Focus: ' || focus || '. ' || description || ' Cues: ' || cues || '.' AS search_text
  FROM (
    VALUES
      ('spd-01', 'Snap-Back Jabs', 'speed', 'beginner',
       'Stand in your stance facing the camera. Throw 20 jabs at about 70 percent power and pull each hand back faster than it went out. Rest 30 seconds. Do 3 sets.',
       'Return faster than you throw | Relax the shoulders | Exhale on every jab'),
      ('spd-02', 'Ten-Second Flurries', 'speed', 'intermediate',
       'Throw straight punches as fast as you can for 10 seconds, then hold a still guard for 20 seconds. Do 6 rounds. Reach full extension on every punch so speed never costs reach.',
       'Full extension every punch | Stay loose between bursts | Count your punches each round'),
      ('spd-03', 'Double-Jab Ladder', 'speed', 'intermediate',
       'Throw a double jab, then a triple, then four jabs, then work back down to one. That ladder is one set. Do 4 sets with 30 seconds rest and keep the rhythm crisp.',
       'Small fast steps of the lead hand | Chin down | Same speed on the last jab as the first'),
      ('spd-04', 'Balloon Hands', 'speed', 'advanced',
       'Shadowbox 3 rounds of 1 minute with very light hands, as if tapping a balloon, chasing your fastest hand speed of the day. Go all out for the last 15 seconds of each round. Rest 45 seconds.',
       'Light hands are fast hands | Turn the hips, not just the arms | Sharp breath out'),
      ('rct-01', 'Clap Cue Jabs', 'reaction', 'beginner',
       'Ask a friend to clap at random moments, or use a random beep timer. On each signal fire one jab as fast as you can and return to guard. Do 3 sets of 15 signals.',
       'React, do not guess | Stay relaxed while you wait | Guard back before the next cue'),
      ('rct-02', 'Left or Right Calls', 'reaction', 'intermediate',
       'A partner calls left or right at random. Throw a lead hook on left and a rear cross on right. Do 3 rounds of 1 minute and aim to answer each call within half a second.',
       'Eyes on the screen | Weight centred | Do not drop the other hand'),
      ('rct-03', 'Block Then Fire', 'reaction', 'intermediate',
       'On a random signal, raise a high double block, then answer straight away with a jab-cross. Do 4 sets of 10 signals with 30 seconds rest between sets.',
       'Block first, then punch | Short punches, fast return | Keep elbows tight'),
      ('rct-04', 'Prompt Pyramid', 'reaction', 'advanced',
       'Play 30-second game rounds where you punch only on prompts. Round 1 answer with one punch, round 2 with two, round 3 with three, then back down to one. Rest 30 seconds between rounds.',
       'First punch is the fastest | Stay balanced after each answer | Breathe between prompts'),
      ('acc-01', 'Sticky Note Target', 'accuracy', 'beginner',
       'Put a sticky note at chin height on the wall in front of you. Throw slow jabs and crosses that stop just short of it. Do 2 sets of 20 per hand.',
       'Look at the target, not the hand | Punch in a straight line | Stop short, do not hit the wall'),
      ('acc-02', 'Slow Motion Round', 'accuracy', 'beginner',
       'Shadowbox one 2-minute round at quarter speed, picturing every punch landing on the same spot. Then do one round at half speed with the same precision.',
       'Same target every time | Full extension | Smooth, not rushed'),
      ('acc-03', 'Call the Target', 'accuracy', 'intermediate',
       'Picture three targets in front of you: head, chest and body. Call a target out loud, then hit it with a straight punch. Do 3 rounds of 1 minute and change target on every punch.',
       'Call it, then throw it | Bend the knees for body shots | Return to guard each time'),
      ('acc-04', 'Tired Precision', 'accuracy', 'advanced',
       'Throw fast punches for 20 seconds, then immediately throw 5 slow, perfect jabs at one spot. Repeat 6 times. Clean punches at the end of a round are the ones that count.',
       'Slow down to be precise | Exhale and reset | Same spot every jab'),
      ('grd-01', 'Glued Rear Hand', 'guard', 'beginner',
       'Throw 3 sets of 15 jabs while the rear glove stays touching your cheek. After each set, check the camera view to see whether the rear hand drifted.',
       'Rear hand on the cheek | Elbow covers the ribs | Chin behind the shoulder'),
      ('grd-02', 'Tap and Return', 'guard', 'intermediate',
       'After every punch, touch your forehead with the punching hand before you throw the next one. Do 3 rounds of 1 minute of jab, cross and hook. This builds the habit of coming home to guard.',
       'Every punch comes home | Forehead tap, then go again | Keep the other hand still'),
      ('grd-03', 'Chin Tuck Rounds', 'guard', 'beginner',
       'Hold a rolled-up sock between your chin and chest and shadowbox 2 rounds of 1 minute without dropping it. Keep the elbows in and the eyes up.',
       'Chin down, eyes up | Elbows in | Small, tight punches'),
      ('grd-04', 'Guard Check Penalty', 'guard', 'advanced',
       'Shadowbox 3 rounds of 90 seconds. Every time you notice your guard drop, stop and do 3 squats, then carry on. Aim for zero squats by the third round.',
       'Hands up when tired | Punch and recover | Watch the guard percentage in the game'),
      ('sym-01', 'Mirror Stance Rounds', 'symmetry', 'beginner',
       'Box 2 rounds of 1 minute in your normal stance, then 2 rounds in the opposite stance. Try to match your strong-side punch count with your weak side.',
       'Same rhythm both sides | Count your punches | Relax the weak shoulder'),
      ('sym-02', 'Weak Hand Leads', 'symmetry', 'intermediate',
       'Start every combination with your weaker hand. Do 3 rounds of 1 minute of weak-hand jab, hook and uppercut, then finish each round with 10 crosses from the strong hand.',
       'Weak hand goes first | Full turn on the hook | Do not rush the strong hand'),
      ('sym-03', 'Strict Alternation', 'symmetry', 'intermediate',
       'Alternate hands strictly, left then right, for 4 sets of 30 punches. Keep both hands at the same speed, and slow the strong hand down if you need to.',
       'Left, right, left, right | Match the speed | Even breathing'),
      ('sym-04', 'Switch Stance Combos', 'symmetry', 'advanced',
       'Throw a jab-cross-hook, switch stance with a small hop, then throw the same combination from the other side. Do 4 rounds of 45 seconds with 30 seconds rest.',
       'Quick, small switch | Guard stays up during the hop | Same power both sides'),
      ('end-01', 'Steady Pace Round', 'endurance', 'beginner',
       'Shadowbox for 3 minutes at a pace you can keep the whole time, about one punch per second. Rest 1 minute, then repeat once. The goal is an even pace, not top speed.',
       'Even pace from start to end | Breathe through the nose | Loose shoulders'),
      ('end-02', 'Work Rest Ladder', 'endurance', 'intermediate',
       'Punch for 30 seconds and rest 30, then 40 on and 20 off, then 50 on and 10 off. Repeat the ladder twice. Keep the last punches as sharp as the first.',
       'Sharp to the final second | Short rests, quick reset | Stay on your toes'),
      ('end-03', 'Fourth Quarter Finisher', 'endurance', 'intermediate',
       'Play a normal game round, then straight away throw 30 seconds of straight punches at full speed. Do this 3 times in a session to train speed when you are tired.',
       'Push through the last 30 seconds | Hands back to guard | Exhale on every punch'),
      ('end-04', 'Championship Rounds', 'endurance', 'advanced',
       'Do 6 rounds of 2 minutes with 45 seconds rest, mixing jabs, crosses and hooks. Track the speed drop in the game and try to keep it under 10 percent.',
       'Pace the early rounds | Same speed in round 6 | Drink water between rounds'),
      ('cmb-01', 'One-Two Foundations', 'combos', 'beginner',
       'Throw 4 sets of 15 jab-cross combinations. Pause in guard for one second after each one. Focus on turning the rear foot as the cross goes out.',
       'Jab sets up the cross | Turn the rear foot | Pause in guard'),
      ('cmb-02', 'Jab Cross Hook', 'combos', 'intermediate',
       'Do 3 rounds of 1 minute of jab, cross and lead hook. Turn the lead foot in on the hook and return to guard after every combination. Rest 30 seconds between rounds.',
       'Hook elbow at shoulder height | Pivot the lead foot | Guard home after the hook'),
      ('cmb-03', 'Body Then Head', 'combos', 'intermediate',
       'Throw a cross to the body, then a lead hook to the head. Bend the knees for the body shot instead of leaning. Do 4 sets of 10 combinations on each side.',
       'Bend the knees, not the back | Body first, head second | Back to guard'),
      ('cmb-04', 'Five Punch Flow', 'combos', 'advanced',
       'Throw jab, cross, lead hook, rear uppercut, cross. Repeat it 8 times in a row at speed, rest 30 seconds, and do 4 sets. Keep the guard tight between punches.',
       'Flow, do not pause | Short uppercut | Finish with the guard up'),
      ('ftw-01', 'Small Box Steps', 'footwork', 'beginner',
       'Picture a small square on the floor, one step wide. Step forward, right, back and left in stance, throwing a jab after each step. Do 3 rounds of 1 minute and stay inside the camera frame.',
       'Never cross your feet | Small steps | Jab after landing'),
      ('ftw-02', 'Pivot and Punch', 'footwork', 'intermediate',
       'Throw a jab-cross, pivot a quarter turn on the lead foot, and repeat until you have turned a full circle. Do 4 sets. Keep your whole body in the camera frame.',
       'Pivot on the ball of the foot | Guard up while turning | Punch only when set'),
      ('ftw-03', 'In and Out', 'footwork', 'intermediate',
       'Step in with a jab, then step back out of range. Do 3 rounds of 1 minute with small steps, never crossing your feet, and stay in the webcam view.',
       'Front foot first going in | Back foot first going out | Hands up on the exit'),
      ('ftw-04', 'Bounce Rounds', 'footwork', 'advanced',
       'Stay light on the balls of your feet for 3 rounds of 90 seconds, bouncing in stance and throwing combinations of two to four punches on the move. Rest 30 seconds between rounds.',
       'Light, springy feet | Punch while moving | Keep the bounce small')
  ) AS v (drill_id, title, focus, level, description, cues)
) s
ON t.drill_id = s.drill_id
WHEN MATCHED AND (
     t.title       IS DISTINCT FROM s.title
  OR t.focus       IS DISTINCT FROM s.focus
  OR t.level       IS DISTINCT FROM s.level
  OR t.description IS DISTINCT FROM s.description
  OR t.cues        IS DISTINCT FROM s.cues
  OR t.search_text IS DISTINCT FROM s.search_text
) THEN UPDATE SET
  title = s.title, focus = s.focus, level = s.level,
  description = s.description, cues = s.cues, search_text = s.search_text
WHEN NOT MATCHED THEN INSERT (drill_id, title, focus, level, description, cues, search_text)
  VALUES (s.drill_id, s.title, s.focus, s.level, s.description, s.cues, s.search_text);

-- -----------------------------------------------------------------------------
-- 2. COACH_DRILL_SEARCH: hybrid (keyword + semantic) search over search_text, filterable by
-- focus and level. Default embedding model (snowflake-arctic-embed-m-v1.5), which has the widest
-- region coverage. The index is built when this statement runs (INITIALIZE = ON_CREATE default).
-- CREATE OR REPLACE drops the USAGE grants, which section 5 re-applies.
-- Querying needs USAGE on the database, schema and service (section 5).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE CORTEX SEARCH SERVICE MOTION_DB.PUBLIC.COACH_DRILL_SEARCH
  ON search_text
  ATTRIBUTES focus, level
  WAREHOUSE = MOTION_WH
  TARGET_LAG = '1 day'
  COMMENT = 'Coach drills for grounding the AI coach card (columns: drill_id, title, focus, level, description, cues)'
AS (
  SELECT search_text, drill_id, title, focus, level, description, cues
  FROM MOTION_DB.PUBLIC.COACH_DRILLS
);

-- Example query (worksheet). Both arguments must be constants, so the request JSON is a
-- dollar-quoted literal, not a bind or a column. The reference page says SEARCH_PREVIEW returns
-- an OBJECT, the quickstart wraps it in PARSE_JSON as if it were text; PARSE_JSON(TO_VARCHAR(...))
-- works for both. Shape: {"results": [{"drill_id": ..., "title": ..., ...}], "request_id": "..."}
--
-- SELECT r.value:drill_id::STRING AS drill_id, r.value:title::STRING AS title,
--        r.value:level::STRING AS level, r.value:cues::STRING AS cues
-- FROM TABLE(FLATTEN(INPUT => PARSE_JSON(TO_VARCHAR(SNOWFLAKE.CORTEX.SEARCH_PREVIEW(
--   'MOTION_DB.PUBLIC.COACH_DRILL_SEARCH',
--   $${"query": "my hands drop when I get tired", "columns": ["drill_id","title","focus","level","description","cues"], "filter": {"@eq": {"focus": "guard"}}, "limit": 3}$$
-- )))['results'])) r;

-- -----------------------------------------------------------------------------
-- 3. Scouting: PLAYER_SCOUTING + PLAYER_FORM_STREAM + T_SCOUTING
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS MOTION_DB.PUBLIC.PLAYER_SCOUTING (
  player_id           STRING,
  name                STRING,
  fighting_style      STRING,         -- AI_CLASSIFY label: Out-boxer | Swarmer | Slugger | Boxer-puncher | Counter-puncher
  scouting_report     STRING,         -- AI_COMPLETE, 1-2 sentences
  punches_at_scan     NUMBER,         -- PLAYER_FORM.punches when this row was written
  form_score_at_scan  FLOAT,          -- PLAYER_FORM.form_score when this row was written
  updated_at          TIMESTAMP_NTZ
)
COMMENT = 'AI scouting card per player, written only by task T_SCOUTING';

-- PLAYER_FORM_STREAM (deviation from the contract, same name):
-- the contract asks for a stream ON DYNAMIC TABLE PLAYER_FORM, but Snowflake supports streams on
-- dynamic tables only with incremental refresh ("Dynamic tables that use a full refresh don't support
-- streams", docs.snowflake.com/en/user-guide/dynamic-tables/streams-on-dts), and PLAYER_FORM is
-- REFRESH_MODE = FULL on purpose (analytics.sql). So the stream watches MOTION_EVENTS, the table that
-- feeds PLAYER_FORM, and T_SCOUTING refreshes PLAYER_FORM before it reads it.
-- If PLAYER_FORM ever moves to incremental refresh you can use
--   CREATE OR REPLACE STREAM MOTION_DB.PUBLIC.PLAYER_FORM_STREAM ON DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_FORM;
-- instead (only the standard stream type is supported on dynamic tables, no APPEND_ONLY).
-- APPEND_ONLY: events are only ever inserted. SHOW_INITIAL_ROWS = TRUE: the existing (seeded) events
-- count as new the first time, so the first scheduled run scouts players that already exist.
-- A separate stream from pipelines.sql MOTION_EVENTS_HL_STREAM: each consumer needs its own offset.
CREATE STREAM IF NOT EXISTS MOTION_DB.PUBLIC.PLAYER_FORM_STREAM
  ON TABLE MOTION_DB.PUBLIC.MOTION_EVENTS
  APPEND_ONLY = TRUE
  SHOW_INITIAL_ROWS = TRUE
  COMMENT = 'New MOTION_EVENTS rows not yet seen by task T_SCOUTING';

-- T_SCOUTING
-- The body is a Snowflake Scripting block, wrapped in EXECUTE IMMEDIATE $$ ... $$ so the SQL
-- runner (and Snowsight) send it as one statement:
--   1. ALTER DYNAMIC TABLE PLAYER_FORM REFRESH, so the stats include the punches that woke the task.
--      If that refresh fails (for example a scheduled refresh is already running), the error is
--      caught and the MERGE uses the last refresh; any player it misses is caught on a later run
--      because the MERGE compares punch counts, not stream rows.
--   2. One MERGE into PLAYER_SCOUTING. It reads the stream (COUNT only), which is what advances the
--      stream offset when the MERGE commits, even when it changes no rows.
--      Candidates: PLAYER_FORM players with >= 10 punches whose punch count differs from
--      punches_at_scan (or with no row yet), biggest change first, at most 25 per run.
--      AI_CLASSIFY picks one of the 5 classic styles from an English description of the stats.
--      AI_COMPLETE writes a 1-2 sentence report using only those numbers.
--      If AI_CLASSIFY returns NULL or an unknown label, a simple rule picks the style.
--      If AI_COMPLETE returns NULL or empty text, a template sentence is stored instead.
--      AI functions are ordinary SQL functions and run inside a task MERGE like any other function;
--      the task runs as its owner (ACCOUNTADMIN here), which has SNOWFLAKE.CORTEX_USER through PUBLIC
--      unless your account revoked it.
--   Fallbacks if your account lacks a function:
--      AI_CLASSIFY  -> SNOWFLAKE.CORTEX.CLASSIFY_TEXT(profile_text, ['Out-boxer','Swarmer','Slugger','Boxer-puncher','Counter-puncher'])
--                      returns {"label": "..."}, so read ['label'] instead of ['labels'][0].
--      AI_COMPLETE  -> SNOWFLAKE.CORTEX.TRY_COMPLETE('mistral-large3', prompt) (returns NULL instead of failing).
-- Inside the block, semi-structured values are read with ['key'] brackets, not the colon path,
-- because Snowflake Scripting uses a leading colon for variables.
ALTER TASK IF EXISTS MOTION_DB.PUBLIC.T_SCOUTING SUSPEND;

CREATE OR REPLACE TASK MOTION_DB.PUBLIC.T_SCOUTING
  WAREHOUSE = MOTION_WH
  SCHEDULE = '5 MINUTE'
  USER_TASK_TIMEOUT_MS = 600000
  SUSPEND_TASK_AFTER_NUM_FAILURES = 3
  COMMENT = 'AI scouting: AI_CLASSIFY fighting style + AI_COMPLETE report for players whose punches changed'
  WHEN SYSTEM$STREAM_HAS_DATA('MOTION_DB.PUBLIC.PLAYER_FORM_STREAM')
AS
EXECUTE IMMEDIATE
$$
DECLARE
  refresh_note STRING DEFAULT 'PLAYER_FORM refreshed';
BEGIN
  BEGIN
    ALTER DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_FORM REFRESH;
  EXCEPTION
    WHEN OTHER THEN
      refresh_note := 'PLAYER_FORM refresh skipped: ' || SQLERRM;
  END;

  MERGE INTO MOTION_DB.PUBLIC.PLAYER_SCOUTING t
  USING (
    WITH stream_batch AS (
      SELECT COUNT(*) AS new_events FROM MOTION_DB.PUBLIC.PLAYER_FORM_STREAM
    ),
    candidates AS (
      SELECT
        f.player_id, LEFT(COALESCE(f.name, 'Unknown'), 40) AS name, f.sessions, f.punches,
        f.avg_speed, f.max_speed, f.avg_reaction_ms, f.accuracy_pct, f.guard_pct,
        f.symmetry_pct, f.fatigue_drop_pct,
        f.mix_jab_pct, f.mix_cross_pct, f.mix_hook_pct, f.mix_uppercut_pct, f.mix_block_pct,
        f.form_score
      FROM MOTION_DB.PUBLIC.PLAYER_FORM f
      CROSS JOIN stream_batch b
      LEFT JOIN MOTION_DB.PUBLIC.PLAYER_SCOUTING s ON s.player_id = f.player_id
      WHERE f.player_id IS NOT NULL
        AND f.punches >= 10
        AND (s.player_id IS NULL OR s.punches_at_scan IS NULL OR s.punches_at_scan <> f.punches)
        AND b.new_events >= 0
      ORDER BY ABS(f.punches - COALESCE(s.punches_at_scan, 0)) DESC, f.player_id
      LIMIT 25
    ),
    profiles AS (
      SELECT
        c.*,
        'Boxer stats from a webcam boxing game. '
        || 'Punches thrown: ' || TO_VARCHAR(c.punches) || ' over ' || TO_VARCHAR(COALESCE(c.sessions, 0)) || ' sessions. '
        || 'Average hand speed: ' || COALESCE(TO_VARCHAR(ROUND(c.avg_speed, 1)) || ' m/s', 'not measured')
        || ', fastest punch: ' || COALESCE(TO_VARCHAR(ROUND(c.max_speed, 1)) || ' m/s', 'not measured') || '. '
        || 'Average reaction time: ' || COALESCE(TO_VARCHAR(ROUND(c.avg_reaction_ms)) || ' ms', 'not measured') || ' (lower is faster). '
        || 'Accuracy: ' || COALESCE(TO_VARCHAR(ROUND(c.accuracy_pct)) || ' percent', 'not measured') || '. '
        || 'Guard kept up on ' || COALESCE(TO_VARCHAR(ROUND(c.guard_pct)) || ' percent', 'an unmeasured share') || ' of punches. '
        || 'Left and right hand balance: ' || COALESCE(TO_VARCHAR(ROUND(c.symmetry_pct)) || ' percent', 'not measured') || ' (100 is perfectly even). '
        || 'Speed drop from the first to the last quarter of a round: ' || COALESCE(TO_VARCHAR(ROUND(c.fatigue_drop_pct)) || ' percent', 'not measured') || ' (lower is better). '
        || 'Punch mix: jab ' || TO_VARCHAR(ROUND(COALESCE(c.mix_jab_pct, 0)))
        || ' percent, cross ' || TO_VARCHAR(ROUND(COALESCE(c.mix_cross_pct, 0)))
        || ' percent, hook ' || TO_VARCHAR(ROUND(COALESCE(c.mix_hook_pct, 0)))
        || ' percent, uppercut ' || TO_VARCHAR(ROUND(COALESCE(c.mix_uppercut_pct, 0)))
        || ' percent, blocks ' || TO_VARCHAR(ROUND(COALESCE(c.mix_block_pct, 0))) || ' percent. '
        || 'Overall form score: ' || TO_VARCHAR(ROUND(COALESCE(c.form_score, 0))) || ' out of 100.' AS profile_text,
        CASE
          WHEN COALESCE(c.mix_block_pct, 0) >= 20 AND COALESCE(c.avg_reaction_ms, 9999) <= 300 THEN 'Counter-puncher'
          WHEN COALESCE(c.mix_hook_pct, 0) + COALESCE(c.mix_uppercut_pct, 0) >= 45 THEN 'Slugger'
          WHEN COALESCE(c.mix_jab_pct, 0) >= 40 AND COALESCE(c.guard_pct, 0) >= 60 THEN 'Out-boxer'
          WHEN c.punches / NULLIF(c.sessions, 0) >= 80 THEN 'Swarmer'
          ELSE 'Boxer-puncher'
        END AS rule_style
      FROM candidates c
    ),
    classified AS (
      SELECT
        p.*,
        TO_VARCHAR(AI_CLASSIFY(
          p.profile_text,
          [
            {'label': 'Out-boxer',       'description': 'Keeps distance with fast, accurate straight punches, many jabs, a high guard and good footwork rather than raw power.'},
            {'label': 'Swarmer',         'description': 'Constant pressure: very high punch volume and pace, many hooks and short combinations, keeps working even when tired.'},
            {'label': 'Slugger',         'description': 'Power over finesse: heavy hooks and uppercuts, fewer but harder shots, lower accuracy and a looser guard.'},
            {'label': 'Boxer-puncher',   'description': 'All-rounder: good speed, accuracy and power together, a balanced punch mix and a solid guard.'},
            {'label': 'Counter-puncher', 'description': 'Patient and defensive: very fast reactions, many blocks and a tight guard, waits for openings and then punches back.'}
          ],
          {'task_description': 'Classify the fighting style of an amateur boxer from their webcam boxing game statistics. Higher speed, accuracy, guard and balance are better. Lower reaction time and speed drop are better. Pick the single closest classic boxing style.'}
        )) AS classify_raw
      FROM profiles p
    ),
    styled AS (
      SELECT
        c.*,
        CASE
          WHEN TRY_PARSE_JSON(c.classify_raw)['labels'][0]::STRING
               IN ('Out-boxer', 'Swarmer', 'Slugger', 'Boxer-puncher', 'Counter-puncher')
            THEN TRY_PARSE_JSON(c.classify_raw)['labels'][0]::STRING
          ELSE c.rule_style
        END AS fighting_style
      FROM classified c
    ),
    reported AS (
      SELECT
        s.*,
        AI_COMPLETE(
          model => 'mistral-large3',
          prompt => 'You are an upbeat boxing scout for a webcam boxing game. '
            || 'Write a scouting report for the player ' || s.name || ', whose fighting style is ' || s.fighting_style || '. '
            || 'Rules: 1 or 2 sentences, at most 40 words, plain text only (no markdown, no lists, no quotes, no emoji). '
            || 'Name one strength and one thing to work on. Use only the numbers given below and do not invent any other statistic. '
            || 'Reaction time and speed drop are better when lower. '
            || 'Stats: ' || s.profile_text,
          model_parameters => {'temperature': 0.3, 'max_tokens': 120}
        ) AS report_raw
      FROM styled s
    )
    SELECT
      player_id,
      name,
      fighting_style,
      COALESCE(
        NULLIF(LEFT(TRIM(REPLACE(REPLACE(REPLACE(REPLACE(TO_VARCHAR(report_raw), '"', ''), '*', ''), CHAR(10), ' '), CHAR(13), ' ')), 320), ''),
        name || ' shows a ' || fighting_style || ' style with ' || TO_VARCHAR(punches)
          || ' punches logged and a form score of ' || TO_VARCHAR(ROUND(COALESCE(form_score, 0))) || ' out of 100. Keep it up!'
      ) AS scouting_report,
      punches AS punches_at_scan,
      form_score AS form_score_at_scan
    FROM reported
  ) src
  ON t.player_id = src.player_id
  WHEN MATCHED THEN UPDATE SET
    name = src.name,
    fighting_style = src.fighting_style,
    scouting_report = src.scouting_report,
    punches_at_scan = src.punches_at_scan,
    form_score_at_scan = src.form_score_at_scan,
    updated_at = SYSDATE()
  WHEN NOT MATCHED THEN INSERT
    (player_id, name, fighting_style, scouting_report, punches_at_scan, form_score_at_scan, updated_at)
    VALUES (src.player_id, src.name, src.fighting_style, src.scouting_report,
            src.punches_at_scan, src.form_score_at_scan, SYSDATE());

  RETURN 'T_SCOUTING merged ' || TO_VARCHAR(SQLROWCOUNT) || ' rows, ' || refresh_note;
END;
$$;

-- Manual first run (optional; otherwise the first scheduled run happens within 5 minutes):
-- EXECUTE TASK MOTION_DB.PUBLIC.T_SCOUTING;

-- -----------------------------------------------------------------------------
-- 4. Structured coach card (worksheet examples, commented out so this file makes no AI call).
-- The server sends the same schema as COACH_CARD_SCHEMA (server/src/coachStructured.ts):
--   {tips: string[3], drill: {name, description}, badge: {name, description}, headline: string,
--    summary: string, focus: one of the 8 focus values}
-- Notes from docs.snowflake.com/en/sql-reference/functions/ai_complete-structured-outputs:
--   * minItems / maxItems are NOT supported (error), so "exactly 3 tips" is in the description + prompt.
--   * enum is supported. additionalProperties = false and a full required list are only needed for
--     OpenAI models but are harmless for others, so they are included.
--   * AI_COMPLETE with response_format returns an OBJECT (not a string); with show_details => TRUE
--     it is wrapped as {"structured_output": [{"raw_message": {...}, "type": "json"}], ...}.
--   * The COMPLETE fallback below returns a STRING with the JSON (parse it; it may also arrive as
--     {"structured_output": [{"raw_message": {...}}]}).
-- -----------------------------------------------------------------------------
/*
SELECT AI_COMPLETE(
  model => $CORTEX_MODEL,
  prompt => 'You are an upbeat, expert boxing coach reviewing one round of a webcam boxing game. '
    || 'Use ONLY these numbers. Reaction time and speed drop: lower is better. '
    || 'ROUND STATS: {"score": 412, "total_punches": 58, "avg_speed_mps": 5.9, "max_speed_mps": 8.2, '
    || '"avg_reaction_ms": 312, "accuracy_0_to_1": 0.71, "guard_up_pct": 54, "left_right_symmetry_pct": 77, '
    || '"speed_drop_first_to_last_quarter_pct": 14, "punch_mix_counts": {"jab": 24, "cross": 18, "hook": 11, "uppercut": 5}} '
    || 'SUGGESTED DRILLS (pick one if it fits): grd-02 Tap and Return, grd-01 Glued Rear Hand. '
    || 'Give exactly 3 tips (max 25 words each, weakest area first), one drill with reps or time, '
    || 'a fun 1-3 word badge, a headline (max 8 words), a 1-2 sentence summary that mentions the score, '
    || 'and the single focus area that matters most.',
  model_parameters => {'temperature': 0.3, 'max_tokens': 700},
  response_format => {
    'type': 'json',
    'schema': {
      'type': 'object',
      'properties': {
        'tips': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Exactly 3 short, actionable tips'},
        'drill': {
          'type': 'object',
          'properties': {'name': {'type': 'string'}, 'description': {'type': 'string'}},
          'required': ['name', 'description'],
          'additionalProperties': false
        },
        'badge': {
          'type': 'object',
          'properties': {'name': {'type': 'string'}, 'description': {'type': 'string'}},
          'required': ['name', 'description'],
          'additionalProperties': false
        },
        'headline': {'type': 'string'},
        'summary': {'type': 'string'},
        'focus': {'type': 'string', 'enum': ['speed', 'reaction', 'accuracy', 'guard', 'symmetry', 'endurance', 'combos', 'footwork']}
      },
      'required': ['tips', 'drill', 'badge', 'headline', 'summary', 'focus'],
      'additionalProperties': false
    }
  }
) AS coach_card;

-- Read fields from the OBJECT:
-- SELECT c:headline::STRING, c:tips[0]::STRING, c:drill:name::STRING, c:focus::STRING
-- FROM (SELECT AI_COMPLETE(...same call as above...) AS c);

-- Fallback if AI_COMPLETE is not available: SNOWFLAKE.CORTEX.COMPLETE with an options object.
-- Passing options (even {}) switches the prompt to the messages-array form.
SELECT SNOWFLAKE.CORTEX.COMPLETE(
  $CORTEX_MODEL,
  [{'role': 'user', 'content': 'You are an upbeat boxing coach. Use ONLY these numbers: score 412, 58 punches, avg speed 5.9 m/s, reaction 312 ms, accuracy 71 percent, guard up 54 percent, symmetry 77 percent, speed drop 14 percent. Give exactly 3 tips, a drill, a badge, a headline, a summary and the main focus. Respond in JSON.'}],
  {
    'temperature': 0.3,
    'max_tokens': 700,
    'response_format': {
      'type': 'json',
      'schema': {
        'type': 'object',
        'properties': {
          'tips': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Exactly 3 short, actionable tips'},
          'drill': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'description': {'type': 'string'}}, 'required': ['name', 'description'], 'additionalProperties': false},
          'badge': {'type': 'object', 'properties': {'name': {'type': 'string'}, 'description': {'type': 'string'}}, 'required': ['name', 'description'], 'additionalProperties': false},
          'headline': {'type': 'string'},
          'summary': {'type': 'string'},
          'focus': {'type': 'string', 'enum': ['speed', 'reaction', 'accuracy', 'guard', 'symmetry', 'endurance', 'combos', 'footwork']}
        },
        'required': ['tips', 'drill', 'badge', 'headline', 'summary', 'focus'],
        'additionalProperties': false
      }
    }
  }
) AS coach_card_text;
*/

-- -----------------------------------------------------------------------------
-- 5. Grants (CREATE OR REPLACE drops grants, so every grant for these objects lives here).
-- setup.sql already gives both roles USAGE on MOTION_DB / PUBLIC / MOTION_WH and SNOWFLAKE.CORTEX_USER.
-- -----------------------------------------------------------------------------
GRANT USAGE ON CORTEX SEARCH SERVICE MOTION_DB.PUBLIC.COACH_DRILL_SEARCH TO ROLE MOTION_APP_ROLE;
GRANT USAGE ON CORTEX SEARCH SERVICE MOTION_DB.PUBLIC.COACH_DRILL_SEARCH TO ROLE MOTION_READONLY_ROLE;

GRANT SELECT ON TABLE MOTION_DB.PUBLIC.COACH_DRILLS    TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON TABLE MOTION_DB.PUBLIC.COACH_DRILLS    TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON TABLE MOTION_DB.PUBLIC.PLAYER_SCOUTING TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON TABLE MOTION_DB.PUBLIC.PLAYER_SCOUTING TO ROLE MOTION_READONLY_ROLE;

-- MONITOR lets the app read the task's state and TASK_HISTORY (for /api/snowflake/status).
GRANT MONITOR ON TASK MOTION_DB.PUBLIC.T_SCOUTING TO ROLE MOTION_APP_ROLE;

-- -----------------------------------------------------------------------------
-- 6. Start the task (tasks are created suspended). Last, so the grants exist before the first run.
-- -----------------------------------------------------------------------------
ALTER TASK MOTION_DB.PUBLIC.T_SCOUTING RESUME;
