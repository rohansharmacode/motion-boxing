# Cortex Analyst semantic model

`motion_boxing.yaml` tells Cortex Analyst what the Motion Boxing data means, so people can ask
questions in plain English ("Who has the fastest punch?") and get SQL plus an answer.

Logical tables and their base objects in `MOTION_DB.PUBLIC`:

| Logical table     | Base object       | Grain                         |
|-------------------|-------------------|-------------------------------|
| `players`         | PLAYERS           | one row per player            |
| `sessions`        | SESSION_SUMMARY   | one row per round (session)   |
| `punches`         | MOTION_EVENTS     | one row per punch/block/dodge |
| `player_form`     | PLAYER_FORM       | one row per player (career)   |
| `player_progress` | PLAYER_PROGRESS   | one row per player (trends)   |
| `benchmarks`      | PRO_BENCHMARKS    | one row per metric            |

It also has synonyms ("hand speed", "reflexes", "stamina", "left right balance", "round"),
5 relationships on `player_id` / `session_id`, custom instructions and 14 verified queries
(5 shown as onboarding questions).

## Upload

1. Run `sql/semantic.sql` as ACCOUNTADMIN (after `pipelines.sql`). It creates the stage
   `@MOTION_DB.PUBLIC.SEMANTIC_MODELS` and the grants.
2. Upload the file, keeping the name `motion_boxing.yaml`:
   - Snowsight: Data > Databases > MOTION_DB > PUBLIC > Stages > SEMANTIC_MODELS > + Files, or
   - SnowSQL / Snowflake CLI from the repo root:
     `PUT 'file://sql/semantic_model/motion_boxing.yaml' @MOTION_DB.PUBLIC.SEMANTIC_MODELS AUTO_COMPRESS = FALSE OVERWRITE = TRUE;`
3. Check with `LIST @MOTION_DB.PUBLIC.SEMANTIC_MODELS;`. Re-upload after every edit.

## Test in Snowsight

1. Open AI & ML > Cortex Analyst, choose the semantic model file on a stage, and pick
   `MOTION_DB.PUBLIC.SEMANTIC_MODELS` / `motion_boxing.yaml`. Snowsight validates it on open.
2. Use the chat panel on the right. Try the onboarding questions, then free-form ones such as
   "Which player has the best guard?" or "Average hand speed per player today".
3. Check the generated SQL and the result table. A verified query shows a "verified" badge.

The Streamlit app calls the same model with `semantic_model_file` =
`@MOTION_DB.PUBLIC.SEMANTIC_MODELS/motion_boxing.yaml` on `POST /api/v2/cortex/analyst/message`.

## Add a verified query

- In the playground: ask the question, check the SQL is right, click the option to save it as a
  verified query, then save the model (download it and copy it back here so the repo stays the source).
- By hand: add an entry under `verified_queries` with `name`, `question`, `sql`, `verified_at`
  (`date +%s`), `verified_by` and optionally `use_as_onboarding_question: true`. The SQL must use
  logical names: tables as `__punches`, `__players`, ... and the logical column names from this
  file (for example `is_punch`, `benchmark_metric`), not physical ones. Then re-upload.

## If something fails

- Validator rejects `custom_instructions`: delete that key (it is only a hint).
- SESSION_SUMMARY / PLAYER_PROGRESS do not exist yet: run `pipelines.sql`. Stopgap: delete the
  `player_progress` table, its relationship and `most_improved_players`; point `sessions` at
  V_SESSION_STATS, change `session_start_ts` to `started_at` and `punches` to `total_punches`
  inside its `expr` values (keep the logical names), and drop `session_index`.
- Optional upgrade: `CALL SYSTEM$CREATE_SEMANTIC_VIEW_FROM_YAML('MOTION_DB.PUBLIC', $$<yaml>$$, TRUE);`
  checks the YAML as a semantic view without creating it (`FALSE` creates it).
