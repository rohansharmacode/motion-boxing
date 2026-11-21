# Snowflake Plus: shared contract for the new features

Source of truth for names shared by `sql/`, `server/`, `streamlit/` and `scripts/` for the
"Best Use of Snowflake" additions. The original contract (`sql/CONTRACT.md`) is unchanged.
All objects live in `MOTION_DB.PUBLIC`. Everything here is ADDITIVE: no existing table, view,
column, endpoint or response field is renamed or removed.

Run order (as ACCOUNTADMIN): `setup.sql` -> `analytics.sql` -> `pipelines.sql` -> `cortex.sql` -> `semantic.sql` -> `multisport.sql`.
Each new file is idempotent (CREATE OR REPLACE for derived objects, IF NOT EXISTS + MERGE for seeded data)
and ends with its own GRANTs to `MOTION_APP_ROLE` and `MOTION_READONLY_ROLE`.
If a new file fails, the original game keeps working: the server treats every object below as optional.

## Style vector convention
6 components, ALWAYS in this order: `speed, reaction, accuracy, guard, symmetry, endurance`.
Each component `c_*` is 0..100 using the SAME formulas as `PLAYER_FORM.form_score` in `analytics.sql`:
- c_speed = clamp(avg_speed / 10 * 100)
- c_reaction = clamp((500 - avg_reaction_ms) / 320 * 100)
- c_accuracy = clamp(accuracy_pct)
- c_guard = clamp(guard_pct)
- c_symmetry = clamp(symmetry_pct)
- c_endurance = clamp(100 - 2 * fatigue_drop_pct)
- NULL component -> 50 (neutral). clamp = LEAST(100, GREATEST(0, x)).
Vector element = c / 100 - 0.5 (centred, range -0.5..0.5), type `VECTOR(FLOAT, 6)`.
Similarity = `VECTOR_COSINE_SIMILARITY` (-1..1); shown to people as `similarity_pct = ROUND(50 * (sim + 1), 1)`.

## pipelines.sql (Dynamic Table chain, vectors, Streams + Tasks)
- `SESSION_SUMMARY` DYNAMIC TABLE, TARGET_LAG = DOWNSTREAM. One row per (player_id, session_id) with events:
  `player_id, session_id, session_start_ts, session_index /*1 = player's first session, by session_start_ts*/,
   score, punches, avg_speed, max_speed, avg_reaction_ms, accuracy_pct, guard_pct`.
- `PLAYER_PROGRESS` DYNAMIC TABLE on SESSION_SUMMARY, TARGET_LAG = '1 minute'. One row per player_id:
  `player_id, sessions, first_session_ts, last_session_ts, best_score, last_score,
   speed_trend_mps_per_session /*REGR_SLOPE(avg_speed, session_index), NULL if < 2 sessions*/,
   score_trend_per_session, accuracy_trend_pct_per_session, reaction_trend_ms_per_session,
   improving BOOLEAN /*score_trend > 0*/`.
- `V_PLAYER_STYLE` VIEW on PLAYER_FORM, players with punches > 0:
  `player_id, name, c_speed, c_reaction, c_accuracy, c_guard, c_symmetry, c_endurance, style_vec VECTOR(FLOAT,6),
   pro_similarity_pct /*vs the pro vector built from PRO_BENCHMARKS.pro_avg with the same formulas*/`.
- `V_STYLE_TWINS` VIEW: nearest OTHER player per player:
  `player_id, name, twin_player_id, twin_name, similarity, similarity_pct`.
- `HIGHLIGHTS` TABLE (written only by task T_HIGHLIGHTS):
  `highlight_id STRING DEFAULT UUID_STRING(), created_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
   kind STRING, player_id STRING, name STRING, session_id STRING, value FLOAT, unit STRING, message STRING`.
  kind in `'speed_record' | 'reaction_record' | 'personal_best_speed' | 'punch_milestone' | 'suspicious_speed'`.
- `MOTION_EVENTS_HL_STREAM` STREAM ON TABLE MOTION_EVENTS, APPEND_ONLY = TRUE.
- `T_HIGHLIGHTS` TASK, WAREHOUSE = MOTION_WH, SCHEDULE = '1 MINUTE',
  WHEN SYSTEM$STREAM_HAS_DATA('MOTION_DB.PUBLIC.MOTION_EVENTS_HL_STREAM'). Resumed at the end of the file.
- `V_HIGHLIGHTS_FEED` VIEW: latest 50 HIGHLIGHTS rows, newest first (same columns).

## cortex.sql (Cortex Search, AI functions in a Stream + Task)
- `COACH_DRILLS` TABLE: `drill_id STRING, title STRING, focus STRING, level STRING, description STRING, cues STRING, search_text STRING`.
  focus in `speed | reaction | accuracy | guard | symmetry | endurance | combos | footwork`;
  level in `beginner | intermediate | advanced`. ~30 original drills, seeded with MERGE.
- `COACH_DRILL_SEARCH` CORTEX SEARCH SERVICE ON search_text ATTRIBUTES focus, level,
  WAREHOUSE = MOTION_WH, TARGET_LAG = '1 day'. Returnable columns: drill_id, title, focus, level, description, cues.
  Query from SQL: `SNOWFLAKE.CORTEX.SEARCH_PREVIEW('MOTION_DB.PUBLIC.COACH_DRILL_SEARCH', '<json>')` where json is
  `{"query": "...", "columns": ["drill_id","title","focus","level","description","cues"], "filter": {"@eq": {"focus": "guard"}}, "limit": 3}`.
  It returns a JSON STRING `{"results": [{...columns}], ...}`. Pass the JSON as a SQL string literal (dollar-quoted `$$...$$`),
  not a bind, because the function needs constant arguments.
- `PLAYER_SCOUTING` TABLE: `player_id STRING, name STRING, fighting_style STRING /*AI_CLASSIFY label*/,
   scouting_report STRING /*AI_COMPLETE, 1-2 sentences*/, punches_at_scan NUMBER, form_score_at_scan FLOAT, updated_at TIMESTAMP_NTZ`.
  fighting_style in `'Out-boxer' | 'Swarmer' | 'Slugger' | 'Boxer-puncher' | 'Counter-puncher'`.
- `PLAYER_FORM_STREAM` STREAM ON TABLE MOTION_EVENTS (APPEND_ONLY, SHOW_INITIAL_ROWS). Not on PLAYER_FORM: streams on
  full-refresh dynamic tables are not supported. The task refreshes PLAYER_FORM before it reads it.
- `T_SCOUTING` TASK, WAREHOUSE = MOTION_WH, SCHEDULE = '5 MINUTE', WHEN SYSTEM$STREAM_HAS_DATA('MOTION_DB.PUBLIC.PLAYER_FORM_STREAM'):
  an `EXECUTE IMMEDIATE $$...$$` block that MERGEs into PLAYER_SCOUTING, calling AI only for players with >= 10 punches whose punches changed since the last scan.
- Structured coach card JSON schema (used by the server with AI_COMPLETE response_format):
  `{tips: string[3], drill: {name, description}, badge: {name, description}, headline: string, summary: string,
    focus: one of the focus values above}`.

## semantic.sql + semantic_model/motion_boxing.yaml (Cortex Analyst)
- `SEMANTIC_MODELS` STAGE, DIRECTORY = (ENABLE = TRUE), ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE').
- File `@MOTION_DB.PUBLIC.SEMANTIC_MODELS/motion_boxing.yaml` (source: `sql/semantic_model/motion_boxing.yaml`).
  Covers PLAYERS, SESSION_SUMMARY (or V_SESSION_STATS), MOTION_EVENTS, PLAYER_FORM, PLAYER_PROGRESS, PRO_BENCHMARKS, with verified queries.
- Streamlit calls Cortex Analyst: `_snowflake.send_snow_api_request("POST", "/api/v2/cortex/analyst/message", {}, {},
  {"messages": [...], "semantic_model_file": "@MOTION_DB.PUBLIC.SEMANTIC_MODELS/motion_boxing.yaml"}, None, 50000)`.

## New server endpoints (all work in mock mode; real mode degrades to 200 with `available:false` when the object is missing)
- `GET /api/player/:id/style` -> `{player_id, available, components:{speed,reaction,accuracy,guard,symmetry,endurance} /*0..100*/,
   pro_similarity_pct, twin:{player_id, name, similarity_pct}|null, scouting:{fighting_style, scouting_report, updated_at}|null}`
- `GET /api/player/:id/progress` -> `{player_id, available, sessions, best_score, last_score, speed_trend_mps_per_session,
   score_trend_per_session, accuracy_trend_pct_per_session, reaction_trend_ms_per_session, improving, history:[{session_index, session_id, score, avg_speed, accuracy_pct}]}`
- `GET /api/highlights?limit=20` -> `{available, highlights:[{highlight_id, created_at, kind, player_id, name, session_id, value, unit, message}]}`
- `GET /api/drills/search?q=...&focus=guard` -> `{available, source:'cortex_search'|'mock', results:[{drill_id,title,focus,level,description,cues}]}`
- `GET /api/snowflake/status` -> `{mode, features:{dynamic_tables, cortex_complete, structured_output, cortex_search, streams_tasks, vectors, cortex_analyst}}`
  each feature `{status:'up'|'missing'|'error'|'mock'|'unknown'|'streamlit', detail?:string}` (cortex_analyst is 'streamlit': it runs in SiS), plus `player_form_last_refresh` when known.
- `POST /api/session/end` coach card gains OPTIONAL fields (front end ignores unknown fields):
  `coach.focus`, `coach.grounding:{source:'cortex_search'|'mock'|'fallback', drills:[{drill_id,title}]}`, `coach.structured:boolean`.
  These appear on the front-end response shape and `GET /api/session/:id/coach`; the original `{session_id}` body shape is unchanged.
- Model default: `mistral-large3` (server `CORTEX_MODEL`, and a literal in the T_SCOUTING task). The structured schema uses only
  type/properties/required/items so every model accepts it; the server enforces 3 tips and a valid focus itself.

## Multi-sport (multisport.sql: goalkeeper now, archery next)
No DDL change: goalkeeper and archery rows go into `MOTION_EVENTS` with their own `sport`. Every boxing object
filters `LOWER(COALESCE(sport, 'boxing')) = 'boxing'`, so boxing numbers are unchanged.
- Event mapping (front-end shape and original API both accepted; the raw event stays in `payload`):
  - `SAVE` / `GOAL` -> sport `'goalkeeper'`, event_type `'save'` / `'goal'`, `hand` = saving glove (`L`/`R`, NULL for torso or goal),
    `speed_mps` = peak glove speed (m/s), `reaction_ms`, `accuracy` 0..1, `guard_up` NULL,
    `points` = save 1000 (+250 if reaction < 450 ms, +150 punch clearance, + accuracy/2), goal 0 (the keeper engine's arcade score),
    `payload:zone` 0..8 (= row * 3 + col, row 0 = top, col 0 = screen left; falls back to `payload:metrics:zone`, then row/col).
  - `ARROW_RELEASE` -> sport `'archery'`, event_type `'arrow'`, `points` = ring 0..10 (or `metrics.points`),
    `accuracy` = accuracy_score / 100 (else ring / 10), `payload:ring`, `payload:dx`, `payload:dy` (hit offset; NULL when not sent).
  - Original API: `POST /api/session/start {sport:'goalkeeper'|'archery'}`; events use `sport`, event_type `save|goal|arrow`,
    `hand` and `speed_mps` optional. Session end works for any sport; the coach card uses a goalkeeper or archery prompt.
- Views: `V_GOALKEEPER_STATS` (per player: shots_faced, saves, goals_conceded, save_pct, avg/best reaction, max glove speed, best_score),
  `V_GOALKEEPER_ZONES` (player x zone: shots, saves, save_pct, zone_label), `V_ARCHERY_STATS` (per player: arrows, avg_points,
  best_arrow, best_score, bullseyes, best/avg grouping, aim bias), `V_LEADERBOARD_BY_SPORT` (sport, rank, player_id, name,
  best_score, score, sessions, max_speed, best_reaction_ms), `V_DECATHLON` (per player: per-sport percentile of best score
  via CUME_DIST, overall_rating = mean over sports played, sports_played), `MULTISPORT_RATING` DYNAMIC TABLE (V_DECATHLON, 1 minute lag).
- `GET /api/leaderboard?sport=boxing|goalkeeper|archery` (case-insensitive, default boxing; unknown sport -> 400). Same row shape for
  every sport; for goalkeeper/archery `fastest_punch` / `max_speed` hold the fastest glove / release speed.
