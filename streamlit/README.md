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
- **Wrong model:** if `mistral-large2` is not available in your region, pick another model in the sidebar or enable cross-region inference (see `sql/setup.sql`).
