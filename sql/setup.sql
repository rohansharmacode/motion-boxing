-- =============================================================================
-- Motion Boxing on Snowflake: base setup
-- Source of truth for names/columns: sql/CONTRACT.md
--
-- Run in a Snowsight worksheet as ACCOUNTADMIN ("Run All"). Safe to re-run:
--   * account objects / tables use IF NOT EXISTS (never drops data)
--   * PRO_BENCHMARKS is upserted with MERGE
--   * GRANTs are idempotent
-- Then run sql/analytics.sql, then sql/verify.sql.
-- =============================================================================

USE ROLE ACCOUNTADMIN;

-- -----------------------------------------------------------------------------
-- 1. Warehouse, database, schema
-- -----------------------------------------------------------------------------
CREATE WAREHOUSE IF NOT EXISTS MOTION_WH
  WITH WAREHOUSE_SIZE = 'XSMALL'
       AUTO_SUSPEND = 300
       AUTO_RESUME = TRUE
       INITIALLY_SUSPENDED = TRUE
  COMMENT = 'Motion Boxing: app queries + PLAYER_FORM dynamic table refreshes';

-- Re-assert settings in case the warehouse already existed with other values.
ALTER WAREHOUSE MOTION_WH SET
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 300
  AUTO_RESUME = TRUE;

CREATE DATABASE IF NOT EXISTS MOTION_DB COMMENT = 'Motion Boxing';
CREATE SCHEMA IF NOT EXISTS MOTION_DB.PUBLIC;

USE WAREHOUSE MOTION_WH;
USE SCHEMA MOTION_DB.PUBLIC;

-- -----------------------------------------------------------------------------
-- 2. Tables (CREATE ... IF NOT EXISTS: never replaces existing data)
--    PRIMARY KEY constraints are informational only in Snowflake (not enforced).
--    CHANGE_TRACKING = TRUE so the PLAYER_FORM dynamic table can track changes.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PLAYERS (
  player_id   STRING        DEFAULT UUID_STRING() PRIMARY KEY,
  name        STRING,
  created_at  TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
)
CHANGE_TRACKING = TRUE
COMMENT = 'One row per player';

CREATE TABLE IF NOT EXISTS SESSIONS (
  session_id        STRING        DEFAULT UUID_STRING() PRIMARY KEY,
  player_id         STRING,
  sport             STRING,
  started_at        TIMESTAMP_NTZ,
  ended_at          TIMESTAMP_NTZ,
  score             NUMBER,
  total_punches     NUMBER,
  avg_speed         FLOAT,
  max_speed         FLOAT,
  avg_reaction_ms   FLOAT,
  best_reaction_ms  FLOAT,
  accuracy          FLOAT,      -- 0..1, same scale as MOTION_EVENTS.accuracy
  ai_coach_json     VARIANT     -- Cortex coach card {tips, drill, badge, summary}
)
CHANGE_TRACKING = TRUE
COMMENT = 'One row per round; summary columns are filled at /api/session/end';

CREATE TABLE IF NOT EXISTS MOTION_EVENTS (
  event_id     STRING        DEFAULT UUID_STRING(),
  session_id   STRING,
  player_id    STRING,
  sport        STRING,
  event_ts     TIMESTAMP_NTZ,
  event_type   STRING,       -- 'jab' | 'cross' | 'hook' | 'uppercut' | 'block' | 'slip' | 'duck' (slip/duck: stored, not punches)
  hand         STRING,       -- 'L' | 'R'
  speed_mps    FLOAT,        -- punch hand speed, m/s (blocks: 0)
  accuracy     FLOAT,        -- 0..1 (blocks: NULL)
  reaction_ms  FLOAT,        -- ms from prompt/opening to action, NULL if n/a
  guard_up     BOOLEAN,      -- was the OTHER hand's guard up when this punch was thrown
  points       NUMBER,       -- score awarded
  payload      VARIANT
)
CHANGE_TRACKING = TRUE
COMMENT = 'One row per detected punch/block';

CREATE TABLE IF NOT EXISTS PRO_BENCHMARKS (
  sport             STRING,
  metric            STRING,
  p25               FLOAT,
  p50               FLOAT,
  p75               FLOAT,
  p90               FLOAT,
  pro_avg           FLOAT,
  higher_is_better  BOOLEAN
)
COMMENT = 'Reference distribution per metric. p25<p50<p75<p90 always ascending; higher_is_better says which way is good';

-- Tables that pre-date this script: make sure change tracking is on (no-op if already on).
ALTER TABLE PLAYERS       SET CHANGE_TRACKING = TRUE;
ALTER TABLE SESSIONS      SET CHANGE_TRACKING = TRUE;
ALTER TABLE MOTION_EVENTS SET CHANGE_TRACKING = TRUE;

-- -----------------------------------------------------------------------------
-- 3. Seed PRO_BENCHMARKS (boxing). Hand-picked, plausible values; NOT from a
--    published dataset. Values are the population distribution of the raw metric,
--    always ascending. For lower-is-better metrics (reaction_ms, fatigue_drop_pct)
--    the percentile is flipped: e.g. reaction 210 ms -> 25 -> 100-25 = 75th pct.
--      punch_speed_mps   hand speed at impact estimate, m/s     (higher better)
--      reaction_ms       prompt -> punch latency, ms            (lower better)
--      accuracy_pct      0..100                                  (higher better)
--      guard_pct         % of punches with the other guard up    (higher better)
--      symmetry_pct      100 = perfectly symmetric L/R           (higher better)
--      fatigue_drop_pct  Q1->Q4 avg speed drop within a round, % (lower better)
-- -----------------------------------------------------------------------------
MERGE INTO PRO_BENCHMARKS t
USING (
  SELECT * FROM (
    VALUES
      ('boxing', 'punch_speed_mps',    5.5,   7.0,   8.5,  10.0,   9.5, TRUE),
      ('boxing', 'reaction_ms',      210.0, 250.0, 300.0, 360.0, 190.0, FALSE),
      ('boxing', 'accuracy_pct',      55.0,  65.0,  75.0,  83.0,  85.0, TRUE),
      ('boxing', 'guard_pct',         50.0,  65.0,  78.0,  88.0,  92.0, TRUE),
      ('boxing', 'symmetry_pct',      70.0,  80.0,  88.0,  93.0,  92.0, TRUE),
      ('boxing', 'fatigue_drop_pct',   3.0,   8.0,  14.0,  20.0,   4.0, FALSE)
  ) AS v (sport, metric, p25, p50, p75, p90, pro_avg, higher_is_better)
) s
ON t.sport = s.sport AND t.metric = s.metric
WHEN MATCHED THEN UPDATE SET
  p25 = s.p25, p50 = s.p50, p75 = s.p75, p90 = s.p90,
  pro_avg = s.pro_avg, higher_is_better = s.higher_is_better
WHEN NOT MATCHED THEN INSERT (sport, metric, p25, p50, p75, p90, pro_avg, higher_is_better)
  VALUES (s.sport, s.metric, s.p25, s.p50, s.p75, s.p90, s.pro_avg, s.higher_is_better);

-- -----------------------------------------------------------------------------
-- 4. Role + least-privilege grants
--    The app role can read/write gameplay tables, read benchmarks / views /
--    the dynamic table, use + operate the warehouse, and call Cortex.
--    It cannot create, drop or alter objects.
-- -----------------------------------------------------------------------------
CREATE ROLE IF NOT EXISTS MOTION_APP_ROLE COMMENT = 'Motion Boxing app (server + Streamlit)';
GRANT ROLE MOTION_APP_ROLE TO ROLE SYSADMIN;   -- keep it in the standard role hierarchy

-- Warehouse: USAGE to run queries, OPERATE to resume/suspend explicitly.
GRANT USAGE, OPERATE ON WAREHOUSE MOTION_WH TO ROLE MOTION_APP_ROLE;

-- Database / schema
GRANT USAGE ON DATABASE MOTION_DB TO ROLE MOTION_APP_ROLE;
GRANT USAGE ON SCHEMA MOTION_DB.PUBLIC TO ROLE MOTION_APP_ROLE;

-- Gameplay tables: DML (no TRUNCATE / ownership).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE MOTION_DB.PUBLIC.PLAYERS       TO ROLE MOTION_APP_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE MOTION_DB.PUBLIC.SESSIONS      TO ROLE MOTION_APP_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE MOTION_DB.PUBLIC.MOTION_EVENTS TO ROLE MOTION_APP_ROLE;
-- Benchmarks are reference data: read-only for the app.
GRANT SELECT ON TABLE MOTION_DB.PUBLIC.PRO_BENCHMARKS TO ROLE MOTION_APP_ROLE;

-- Objects created later by sql/analytics.sql (views + dynamic table).
-- analytics.sql also grants explicitly, so these are a safety net.
GRANT SELECT ON FUTURE VIEWS IN SCHEMA MOTION_DB.PUBLIC TO ROLE MOTION_APP_ROLE;
GRANT SELECT, MONITOR ON FUTURE DYNAMIC TABLES IN SCHEMA MOTION_DB.PUBLIC TO ROLE MOTION_APP_ROLE;

-- Cortex LLM functions (SNOWFLAKE.CORTEX.COMPLETE etc.).
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE MOTION_APP_ROLE;

-- Optional: if the chosen Cortex model is not hosted in your account's region,
-- allow cross-region inference (account-wide setting, ACCOUNTADMIN only):
-- ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';

-- Optional: let this role deploy the Streamlit in Snowflake app itself.
-- GRANT CREATE STREAMLIT ON SCHEMA MOTION_DB.PUBLIC TO ROLE MOTION_APP_ROLE;
-- GRANT CREATE STAGE     ON SCHEMA MOTION_DB.PUBLIC TO ROLE MOTION_APP_ROLE;

-- Optional: service user for the Express server (key-pair auth). Generate keys:
--   openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt
--   openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
-- then paste the public key body (no BEGIN/END lines) below and run:
-- CREATE USER IF NOT EXISTS MOTION_APP_USER
--   TYPE = SERVICE
--   DEFAULT_ROLE = MOTION_APP_ROLE
--   DEFAULT_WAREHOUSE = MOTION_WH
--   DEFAULT_NAMESPACE = MOTION_DB.PUBLIC
--   RSA_PUBLIC_KEY = 'MIIBIjANBgkq...';
-- GRANT ROLE MOTION_APP_ROLE TO USER MOTION_APP_USER;

-- Read-only role used ONLY by the server's POST /api/ask (text-to-SQL). Future grants cover the
-- views / dynamic table that sql/analytics.sql creates afterwards.
CREATE ROLE IF NOT EXISTS MOTION_READONLY_ROLE COMMENT = 'SELECT-only role for /api/ask';
GRANT USAGE ON WAREHOUSE MOTION_WH TO ROLE MOTION_READONLY_ROLE;
GRANT USAGE ON DATABASE MOTION_DB TO ROLE MOTION_READONLY_ROLE;
GRANT USAGE ON SCHEMA MOTION_DB.PUBLIC TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON ALL TABLES IN SCHEMA MOTION_DB.PUBLIC TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON FUTURE TABLES IN SCHEMA MOTION_DB.PUBLIC TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA MOTION_DB.PUBLIC TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON FUTURE DYNAMIC TABLES IN SCHEMA MOTION_DB.PUBLIC TO ROLE MOTION_READONLY_ROLE;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE MOTION_READONLY_ROLE;
GRANT ROLE MOTION_READONLY_ROLE TO ROLE SYSADMIN;
-- Also grant it to the service user (see above): GRANT ROLE MOTION_READONLY_ROLE TO USER MOTION_APP_USER;

-- To test the grants yourself in verify.sql (USE ROLE MOTION_APP_ROLE), grant the
-- role to your own user:
-- GRANT ROLE MOTION_APP_ROLE TO USER <your_user>;
