# Shared contract (source of truth for server / sql / streamlit / scripts)

> NOTE: this schema was written before `motion-sports-research.md` (section 5) was in the repo.
> The front end (`src/api/CONTRACT.md`) uses the section-5 names, and we reconcile the two in the
> server (`server/src/frontend.ts`) instead of changing the tables. See "Front-end contract" at the
> bottom of this file and "Connecting the front end" in `README-snowflake.md`.

Database `MOTION_DB`, schema `PUBLIC`, warehouse `MOTION_WH` (X-SMALL, AUTO_SUSPEND=300,
AUTO_RESUME), role `MOTION_APP_ROLE`. Sport is always `'boxing'` for now.

## Tables

PLAYERS(player_id STRING PK default UUID_STRING(), name STRING, created_at TIMESTAMP_NTZ default CURRENT_TIMESTAMP())

SESSIONS(session_id STRING PK default UUID_STRING(), player_id STRING, sport STRING,
  started_at TIMESTAMP_NTZ, ended_at TIMESTAMP_NTZ NULL,
  score NUMBER NULL, total_punches NUMBER NULL, avg_speed FLOAT NULL, max_speed FLOAT NULL,
  avg_reaction_ms FLOAT NULL, best_reaction_ms FLOAT NULL, accuracy FLOAT NULL,
  ai_coach_json VARIANT NULL)

MOTION_EVENTS(event_id STRING default UUID_STRING(), session_id STRING, player_id STRING,
  sport STRING, event_ts TIMESTAMP_NTZ,
  event_type STRING   -- 'jab' | 'cross' | 'hook' | 'uppercut' | 'block' | 'slip' | 'duck'
                      --   (slip/duck are stored but are NOT punches and NOT in the punch mix)
  hand STRING         -- 'L' | 'R'
  speed_mps FLOAT     -- punch hand speed, metres/second (blocks: 0)
  accuracy FLOAT      -- 0..1 (blocks: NULL)
  reaction_ms FLOAT   -- ms from prompt/opening to action, NULL if not applicable
  guard_up BOOLEAN    -- was the OTHER hand's guard up when this punch was thrown
  points NUMBER       -- score awarded
  payload VARIANT NULL)

PRO_BENCHMARKS(sport STRING, metric STRING, p25 FLOAT, p50 FLOAT, p75 FLOAT, p90 FLOAT, pro_avg FLOAT, higher_is_better BOOLEAN)
Metrics (boxing): punch_speed_mps, reaction_ms (lower better), accuracy_pct, guard_pct,
symmetry_pct (100 = perfectly symmetric), fatigue_drop_pct (lower better).
For lower-is-better metrics p25 is the WORST-end... KEEP SIMPLE: p25<p50<p75<p90 always ascending
numeric values; `higher_is_better` tells you how to turn a value into a percentile.
Percentile of v = piecewise-linear interpolation through (p25->25, p50->50, p75->75, p90->90),
clamped to [1,99], extrapolating to 0 / 100 at the ends; flipped (100 - x) if NOT higher_is_better.

## Views / dynamic table (sql/analytics.sql)
- `PLAYER_FORM` dynamic table, TARGET_LAG='1 minute', one row per (player_id) with:
  player_id, name, sessions, punches, avg_speed, max_speed, avg_reaction_ms, best_reaction_ms,
  accuracy_pct, fatigue_drop_pct (Q1 vs Q4 of events by event_ts per session via NTILE(4), avg speed),
  symmetry_pct, guard_pct, mix_jab_pct, mix_cross_pct, mix_hook_pct, mix_uppercut_pct, mix_block_pct,
  form_score (0-100).
- `V_LEADERBOARD`: top 10 columns: rank, player_id, name, best_score, fastest_punch, best_reaction_ms.
- `V_GLOBAL_STATS`: total_players, total_sessions, total_punches, avg_speed, max_speed.
- `V_SESSION_STATS(session_id, ...)`: per-session aggregates used by /api/session/end.
- `V_SPEED_OVER_TIME`: session_id, player_id, minute/bucket, avg_speed (for charts).
- `V_FATIGUE_CURVE`: player_id, quartile (1-4), avg_speed.

## REST API (server, port 3001, JSON, CORS http://localhost:5173)
- GET  /api/health -> {ok:true, mode:'snowflake'|'mock', snowflake:'up'|'down'|'mock', queueDepth:n}
- POST /api/players {name} -> {player_id}
- POST /api/session/start {player_id, sport:'boxing'} -> {session_id}
- POST /api/events  body: array of events {session_id, player_id, sport?, event_ts (ISO), event_type, hand, speed_mps, accuracy?, reaction_ms?, guard_up?, points?, payload?}
    -> 202 {accepted:n, queued:boolean, duplicates?:n}
    JSON or text/plain (sendBeacon). payload.client_event_id (a UUID) becomes event_id, so a resent event is skipped.
    payload.speed_unit = 'SW/s' means speed_mps is in shoulder-widths/s; the server converts it with SHOULDER_WIDTH_M and keeps the raw value in payload.speed_sw_s.
- POST /api/session/end {session_id} -> {session_id, stats:{score,total_punches,avg_speed,max_speed,avg_reaction_ms,best_reaction_ms,accuracy}, coach:{tips:[string,string,string], drill:string, badge:string, summary:string}, fallback:boolean}
- GET  /api/leaderboard -> [{rank, player_id, name, score, fastest_punch, best_reaction_ms}] (max 10)
- GET  /api/player/:id/stats -> {player:{player_id,name}, sessions:[{session_id,started_at,score,...}], percentiles:{punch_speed_mps:n,reaction_ms:n,accuracy_pct:n,guard_pct:n,symmetry_pct:n,fatigue_drop_pct:n}}
- (stretch) POST /api/ask {player_id?, question} -> {answer, sql?}

Score = sum(points) for the session.
Coach card fallback (hardcoded) is used when Cortex errors / times out (8 s) / returns invalid JSON.

## Front-end contract (accepted on the same endpoints)
- Client-generated ids: the server MERGEs PLAYERS / SESSIONS rows on first sight (no /api/players, /api/session/start needed).
- POST /api/events accepts {events:[...]} or an array, as JSON or text/plain (sendBeacon). Section-5 events map as follows:
  - PUNCH + metrics.punchType -> event_type; BLOCK -> 'block'.
  - DODGE -> 'duck' (metrics.kind 'duck' or metrics.direction 'DOWN') or 'slip'; other types are ignored.
  - peak_velocity * SHOULDER_WIDTH_M -> speed_mps; accuracy_score/100 -> accuracy.
  - metrics.hand -> hand; metrics.guardUp -> guard_up.
  - metrics.points -> points. Without metrics.points: 10 + 10*accuracy for a landed punch, 0 for a missed punch, 5 for a block or dodge.
  - The raw event is kept in payload.
  - Reply: 202 {accepted, queued, ignored, rejected, duplicates}.
- POST /api/session/end with player_id + display_name (+ final_score, result, avg_inference_fps, stats).
  - Upserts the player name and stores the client summary in ai_coach_json:client.
  - Returns {session_id, stats, coach:{headline, tips[3], drill:{name,description}, badge:{name,description}, summary}, leaderboard:[...rows + display_name, sport, max_speed], form_score, fallback}.
- GET /api/leaderboard rows also include display_name, sport ('BOXING') and max_speed.

## Mock mode
`SNOWFLAKE_MOCK=1`: server uses an in-memory repository and a canned Cortex reply, so every
endpoint works with no credentials. Real mode needs the env vars in `server/.env.example`.
