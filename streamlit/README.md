# Streamlit in Snowflake dashboard

`app.py` is the Motion Boxing coach dashboard. It shows global stats, a live leaderboard, a player picker, punch speed over time, punch-type mix, the fatigue curve (Q1 to Q4), left/right symmetry, form score with percentiles against `PRO_BENCHMARKS`, and an "Ask the Coach" box that calls `SNOWFLAKE.CORTEX.COMPLETE`. Table and view names come from `sql/CONTRACT.md`.

| File | Purpose |
| --- | --- |
| `app.py` | Streamlit UI, data access, Snowflake session handling |
| `logic.py` | Pure logic: data shaping, percentiles, prompt building, Cortex fallback, demo data. No Streamlit or Snowflake imports. |
| `environment.yml` | Packages for SiS (Snowflake conda channel only) |
| `tests/` | pytest unit tests for `logic.py` and AppTest smoke tests for `app.py` |

## Data source

The app picks the first data source that works:

1. **Streamlit in Snowflake:** `get_active_session()`.
2. **Local Snowpark session** built from env vars: `SNOWFLAKE_ACCOUNT` and `SNOWFLAKE_USER`, plus one of `SNOWFLAKE_PRIVATE_KEY_PATH` (with optional `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE`), `SNOWFLAKE_PASSWORD` or `SNOWFLAKE_AUTHENTICATOR`. These are optional and default to the contract names: `SNOWFLAKE_ROLE`, `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`. This needs `pip install snowflake-snowpark-python`.
3. **DEMO mode:** deterministic synthetic data. The app uses it when neither of the above is available, or when you set `MOTION_DEMO=1` or `SNOWFLAKE_MOCK=1`. Ask the Coach then returns a canned answer built from the stats.

## Run and test locally

```
python3 -m venv .venv && . .venv/bin/activate
pip install "streamlit==1.50.0" pandas altair pytest
MOTION_DEMO=1 streamlit run streamlit/app.py
python -m pytest streamlit/tests -q
```

## Deploy to Streamlit in Snowflake

Run `sql/setup.sql` and `sql/analytics.sql` first. The deploying role needs `CREATE STREAMLIT` on `MOTION_DB.PUBLIC`, `READ` on the stage, and `USAGE` on `MOTION_WH`. `setup.sql` has commented grants for `MOTION_APP_ROLE`, or you can deploy as `ACCOUNTADMIN`. SiS apps run with the **owner's** privileges. The owning role therefore needs `SELECT` on the tables, views and `PLAYER_FORM`, plus the `SNOWFLAKE.CORTEX_USER` database role. `MOTION_APP_ROLE` already has all of these.

### Option A: Snowsight upload (no CLI)

1. Go to Snowsight > Projects > Streamlit > **+ Streamlit App**. Choose database `MOTION_DB`, schema `PUBLIC` and warehouse `MOTION_WH`.
2. Replace the generated main file with the contents of `app.py`.
3. Use the file pane to add `logic.py` and `environment.yml` next to it. Alternatively, open the **Packages** menu and add `pandas` and `altair`, and pick a Streamlit version of 1.37 or later so auto-refresh works.
4. Click **Run**.

### Option B: stage + `CREATE STREAMLIT`

```sql
USE ROLE ACCOUNTADMIN;  -- or a role with CREATE STREAMLIT on MOTION_DB.PUBLIC
CREATE STAGE IF NOT EXISTS MOTION_DB.PUBLIC.STREAMLIT_SRC DIRECTORY = (ENABLE = TRUE);

-- from SnowSQL / Snowflake CLI (`snow sql -q "..."`), at the repo root:
PUT file://streamlit/app.py         @MOTION_DB.PUBLIC.STREAMLIT_SRC/motion AUTO_COMPRESS = FALSE OVERWRITE = TRUE;
PUT file://streamlit/logic.py       @MOTION_DB.PUBLIC.STREAMLIT_SRC/motion AUTO_COMPRESS = FALSE OVERWRITE = TRUE;
PUT file://streamlit/environment.yml @MOTION_DB.PUBLIC.STREAMLIT_SRC/motion AUTO_COMPRESS = FALSE OVERWRITE = TRUE;

CREATE OR REPLACE STREAMLIT MOTION_DB.PUBLIC.MOTION_DASHBOARD
  FROM @MOTION_DB.PUBLIC.STREAMLIT_SRC/motion
  MAIN_FILE = 'app.py'
  QUERY_WAREHOUSE = MOTION_WH
  TITLE = 'Motion Boxing Coach';

-- the app is not live until a live version exists (or the owner opens it in Snowsight):
ALTER STREAMLIT MOTION_DB.PUBLIC.MOTION_DASHBOARD ADD LIVE VERSION FROM LAST;

-- optional: let other roles open it
GRANT USAGE ON STREAMLIT MOTION_DB.PUBLIC.MOTION_DASHBOARD TO ROLE MOTION_APP_ROLE;
```

`FROM` copies files only when the app is created. After code changes, run the `PUT` commands again and then re-run `CREATE OR REPLACE STREAMLIT`. You can also edit the files in Snowsight.

## Notes

- **Bind parameters:** every value goes through Snowpark bind parameters (`session.sql(sql, params=[...])`), including player ids and the Cortex prompt. The Cortex model name is inlined only after an allow-list check (`logic.CORTEX_MODELS`).
- **Input limits:** questions are capped at 500 characters and prompts at 6000. Recent rounds are dropped first if the prompt is too long.
- **Cortex timeout and fallback:** the Cortex call times out after 25 s. If Cortex errors, times out or returns nothing, the app shows a canned answer built from the stats.
- **Caching:** query caches use short TTLs: 4 s for the leaderboard and global stats, 30 s for player data, 10 min for benchmarks. In SiS the cache is per session.
- **Auto-refresh:** this uses `st.fragment(run_every=...)` with a 10 s default, which you can change in the sidebar. On Streamlit 1.33 to 1.36 the app uses `st.experimental_fragment`. Older versions get a Refresh button instead. Auto-refresh keeps `MOTION_WH` busy while the page is open, so untick it in the sidebar when you are not demoing.
- **Wrong model:** if `mistral-large3` (the default; `mistral-large2` is legacy since 2026-08-12) is not available in your region, pick another model in the sidebar or enable cross-region inference (see `sql/setup.sql`).

## Snowflake Lab page (`pages/1_Snowflake_Lab.py`)

A second page, listed in the sidebar, for judges: each section shows one Snowflake feature working on the game data. Pure logic and the DEMO data for it live in `plus_logic.py`, and its tests are in `tests/test_plus_logic.py`. Object names come from `sql/PLUS_CONTRACT.md`.

| Section | Snowflake feature | Needs |
| --- | --- | --- |
| 1. Ask your stats | Cortex Analyst (REST API via `_snowflake.send_snow_api_request`) | `sql/semantic.sql`, plus `sql/semantic_model/motion_boxing.yaml` uploaded to `@MOTION_DB.PUBLIC.SEMANTIC_MODELS` |
| 2. Live highlights feed | Streams + Tasks (`MOTION_EVENTS_HL_STREAM`, `T_HIGHLIGHTS`) | `sql/pipelines.sql` |
| 3. Style twin and scouting | `VECTOR(FLOAT, 6)`, `VECTOR_COSINE_SIMILARITY`, `AI_CLASSIFY` | `sql/pipelines.sql` (`V_PLAYER_STYLE`, `V_STYLE_TWINS`), `sql/cortex.sql` (`PLAYER_SCOUTING`) |
| 4. Progress across sessions | Dynamic Table chain (`SESSION_SUMMARY` -> `PLAYER_PROGRESS`) | `sql/pipelines.sql` |
| 5. Punch heatmap | Window functions over `MOTION_EVENTS` | `sql/setup.sql` |
| 6. Time machine | Time Travel, `AT(OFFSET => ...)` | `sql/setup.sql`; up to 60 minutes back, within the table's retention |
| 7. Crowd coach | `AI_AGG`, with a fallback to `SNOWFLAKE.CORTEX.COMPLETE` | `SESSIONS.ai_coach_json` rows and the `SNOWFLAKE.CORTEX_USER` role. This section runs only when you click its button, because it spends credits. |
| 8. Under the hood | `DYNAMIC_TABLE_REFRESH_HISTORY`, `TASK_HISTORY`, Cortex Search (`SEARCH_PREVIEW`), warehouse settings | `sql/pipelines.sql` and `sql/cortex.sql`. The owner role needs `MONITOR` on the tasks (granted by those files). |

If an object or privilege is missing, the section shows a short note naming the SQL file to run, and the rest of the page keeps working. In DEMO mode (`MOTION_DEMO=1`, or no Snowflake connection) every section uses deterministic synthetic data. Cortex Analyst gives canned answers there for 3 verified questions from the semantic model. It does the same outside SiS, because the `_snowflake` module only exists inside Streamlit in Snowflake.

Run order (as `ACCOUNTADMIN`): `setup.sql`, `analytics.sql`, `pipelines.sql`, `cortex.sql`, `semantic.sql`.

**Deploy:** `cd scripts && npm run streamlit:deploy` uploads `app.py`, `logic.py`, `plus_logic.py` and `environment.yml` to `@MOTION_DB.PUBLIC.STREAMLIT_SRC/motion`, and uploads `pages/*.py` to its `pages/` subfolder. It also tries to upload the semantic model YAML; if the `SEMANTIC_MODELS` stage does not exist yet, it prints a note and continues. To deploy by hand, add these steps to option B:

```sql
PUT file://streamlit/plus_logic.py               @MOTION_DB.PUBLIC.STREAMLIT_SRC/motion       AUTO_COMPRESS = FALSE OVERWRITE = TRUE;
PUT file://streamlit/pages/1_Snowflake_Lab.py    @MOTION_DB.PUBLIC.STREAMLIT_SRC/motion/pages AUTO_COMPRESS = FALSE OVERWRITE = TRUE;
PUT file://sql/semantic_model/motion_boxing.yaml @MOTION_DB.PUBLIC.SEMANTIC_MODELS            AUTO_COMPRESS = FALSE OVERWRITE = TRUE;
```

Then re-run `CREATE OR REPLACE STREAMLIT`. In Snowsight, add `plus_logic.py` next to `app.py`, and add the page file in a `pages` folder.

**Safety:** every user value is a bind parameter, with one exception. The Cortex Search query must be a constant argument of `SEARCH_PREVIEW`, so the page builds the JSON in Python and embeds it as an escaped single-quoted literal (`plus_logic.sql_string_literal`). The page runs SQL generated by Cortex Analyst only when it is a single `SELECT` or `WITH` statement. The time-machine offset is bound. If the account rejects a bind inside `AT(...)`, the page falls back to a validated integer of 0 to 3600 seconds.
