-- =============================================================================
-- Motion Boxing on Snowflake: Cortex Analyst (natural-language questions -> SQL)
-- Run order (as ACCOUNTADMIN): setup.sql -> analytics.sql -> pipelines.sql -> cortex.sql -> semantic.sql
-- Safe to re-run: IF NOT EXISTS for the stage, every GRANT is idempotent.
--
-- What this file does:
--   1. Creates the internal stage SEMANTIC_MODELS (directory table on, server-side encryption,
--      which Snowsight and Streamlit in Snowflake need to read files from it).
--   2. Grants READ on the stage (internal stages take READ/WRITE; USAGE is only for external stages).
--   3. Grants the Cortex database role and SELECT on every table the semantic model uses.
--   4. Shows how to upload sql/semantic_model/motion_boxing.yaml and confirm it is there.
-- The model itself is sql/semantic_model/motion_boxing.yaml; see sql/semantic_model/README.md.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE MOTION_WH;
USE SCHEMA MOTION_DB.PUBLIC;

-- -----------------------------------------------------------------------------
-- 1. Stage for semantic model YAML files.
--    ENCRYPTION cannot be changed after creation, so IF NOT EXISTS keeps an existing stage.
-- -----------------------------------------------------------------------------
CREATE STAGE IF NOT EXISTS MOTION_DB.PUBLIC.SEMANTIC_MODELS
  DIRECTORY = (ENABLE = TRUE)
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
  COMMENT = 'Cortex Analyst semantic models (motion_boxing.yaml)';

-- In case the stage already existed without a directory table (no-op otherwise).
ALTER STAGE MOTION_DB.PUBLIC.SEMANTIC_MODELS SET DIRECTORY = (ENABLE = TRUE);

-- -----------------------------------------------------------------------------
-- 2. Stage access. Any role that can READ the stage can load the semantic model,
--    so only the two app roles get it.
-- -----------------------------------------------------------------------------
GRANT READ ON STAGE MOTION_DB.PUBLIC.SEMANTIC_MODELS TO ROLE MOTION_APP_ROLE;
GRANT READ ON STAGE MOTION_DB.PUBLIC.SEMANTIC_MODELS TO ROLE MOTION_READONLY_ROLE;

-- -----------------------------------------------------------------------------
-- 3. Cortex Analyst access. SNOWFLAKE.CORTEX_USER covers Cortex Analyst (setup.sql already
--    grants it; repeated here so this file stands alone). Least-privilege alternative that
--    covers ONLY Cortex Analyst, if your account has it:
--      GRANT DATABASE ROLE SNOWFLAKE.CORTEX_ANALYST_USER TO ROLE MOTION_READONLY_ROLE;
-- -----------------------------------------------------------------------------
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE MOTION_APP_ROLE;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE MOTION_READONLY_ROLE;

-- Warehouse that runs the SQL Cortex Analyst generates (already granted in setup.sql).
GRANT USAGE ON WAREHOUSE MOTION_WH TO ROLE MOTION_APP_ROLE;
GRANT USAGE ON WAREHOUSE MOTION_WH TO ROLE MOTION_READONLY_ROLE;

-- SELECT on every base table of the semantic model. setup.sql / analytics.sql / pipelines.sql
-- already grant these; repeated so a missing grant shows up here. The last two need
-- pipelines.sql: if they fail, run pipelines.sql first, then re-run this file.
GRANT SELECT ON TABLE MOTION_DB.PUBLIC.PLAYERS        TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON TABLE MOTION_DB.PUBLIC.MOTION_EVENTS  TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON TABLE MOTION_DB.PUBLIC.PRO_BENCHMARKS TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON TABLE MOTION_DB.PUBLIC.PLAYERS        TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON TABLE MOTION_DB.PUBLIC.MOTION_EVENTS  TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON TABLE MOTION_DB.PUBLIC.PRO_BENCHMARKS TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_FORM     TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_FORM     TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON DYNAMIC TABLE MOTION_DB.PUBLIC.SESSION_SUMMARY TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON DYNAMIC TABLE MOTION_DB.PUBLIC.SESSION_SUMMARY TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_PROGRESS TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON DYNAMIC TABLE MOTION_DB.PUBLIC.PLAYER_PROGRESS TO ROLE MOTION_READONLY_ROLE;

-- -----------------------------------------------------------------------------
-- 4. Upload the model. PUT does not run in a Snowsight worksheet, so either:
--    a) Snowsight: Data > Databases > MOTION_DB > PUBLIC > Stages > SEMANTIC_MODELS > + Files,
--       pick sql/semantic_model/motion_boxing.yaml (keep the file name), or
--    b) SnowSQL / Snowflake CLI (snow sql -q "..."), run from the repo root:
-- PUT 'file://sql/semantic_model/motion_boxing.yaml' @MOTION_DB.PUBLIC.SEMANTIC_MODELS AUTO_COMPRESS = FALSE OVERWRITE = TRUE;
--    Re-upload after every YAML edit (OVERWRITE = TRUE replaces it; AUTO_COMPRESS = FALSE keeps .yaml, not .yaml.gz).
-- -----------------------------------------------------------------------------

-- Refresh the directory table so Snowsight lists newly PUT files (harmless if nothing changed).
ALTER STAGE MOTION_DB.PUBLIC.SEMANTIC_MODELS REFRESH;

-- Confirm: expect one row, motion_boxing.yaml (empty until the file is uploaded).
LIST @MOTION_DB.PUBLIC.SEMANTIC_MODELS;
