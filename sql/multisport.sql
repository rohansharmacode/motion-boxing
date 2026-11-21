-- =============================================================================
-- Motion Sports on Snowflake: multi-sport analytics (goalkeeper, archery, decathlon)
-- Run AFTER sql/pipelines.sql, as ACCOUNTADMIN. Safe to re-run: every object here
-- is derived (no stored data), so CREATE OR REPLACE is used throughout, and the
-- GRANTs at the end are re-applied every run.
--
-- No DDL change: MOTION_EVENTS already has `sport` and a `payload` VARIANT.
-- Rows written by the server (sql/PLUS_CONTRACT.md "Multi-sport"):
--   goalkeeper: sport 'goalkeeper', event_type 'save' | 'goal'
--               reaction_ms  ms from the striker telegraph to the first glove move
--               speed_mps    peak glove speed (m/s), accuracy 0..1, hand = glove (NULL for torso / goal)
--               points       save = 1000 (+250 reaction < 450 ms, +150 punch clearance, + accuracy/2), goal = 0
--               payload:zone 9-grid zone 0..8 = row * 3 + col, row 0 = top, col 0 = screen left
--                            (falls back to payload:metrics:zone, then payload row/col)
--   archery:    sport 'archery', event_type 'arrow'
--               points = ring score 0..10 unless the game sends metrics.points
--               payload:ring 0..10, payload:dx / payload:dy hit offset from the target centre
--                            (each falls back to payload:metrics:<same name>)
-- Boxing objects (analytics.sql, pipelines.sql, cortex.sql) all filter
-- LOWER(COALESCE(sport, 'boxing')) = 'boxing', so these rows never reach them.
--
-- Conventions (same as analytics.sql):
--   * sport / event_type are normalised with LOWER, so 'GOALKEEPER' or 'Save' still count
--   * reaction_ms only counts when > 0
--   * score = SUM(points) over all events of a session; best_score = best session
--   * payload values are read with TRY_TO_NUMBER / TRY_TO_DOUBLE on ::STRING, so a JSON
--     null, a missing key or a non-numeric value is SQL NULL instead of an error
--   * GREATEST/LEAST return NULL if any argument is NULL, so NULLs are handled with
--     CASE / COALESCE before calling them
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE MOTION_WH;
USE SCHEMA MOTION_DB.PUBLIC;

-- -----------------------------------------------------------------------------
-- V_GOALKEEPER_STATS: one row per player with goalkeeper events.
--   shots_faced = saves + goals_conceded; save_pct 0..100.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW MOTION_DB.PUBLIC.V_GOALKEEPER_STATS
  COMMENT = 'Per-player goalkeeper stats: shots faced, saves, save_pct, reaction, glove speed, best shootout'
AS
WITH ev AS (
  SELECT
    player_id, session_id,
    LOWER(event_type) AS etype,
    reaction_ms, speed_mps, accuracy,
    COALESCE(points, 0) AS points,
    CASE WHEN payload:punch::STRING = 'true' OR payload:metrics:punch::STRING = 'true' THEN 1 ELSE 0 END AS is_punch
  FROM MOTION_DB.PUBLIC.MOTION_EVENTS
  WHERE player_id IS NOT NULL
    AND LOWER(COALESCE(sport, 'boxing')) = 'goalkeeper'
    AND LOWER(event_type) IN ('save', 'goal')
),
session_scores AS (
  SELECT player_id, session_id, SUM(points) AS score
  FROM ev
  GROUP BY player_id, session_id
),
agg AS (
  SELECT
    player_id,
    COUNT(DISTINCT session_id)                          AS sessions,
    COUNT(*)                                            AS shots_faced,
    COUNT_IF(etype = 'save')                            AS saves,
    COUNT_IF(etype = 'goal')                            AS goals_conceded,
    SUM(is_punch)                                       AS punch_clearances,
    AVG(CASE WHEN reaction_ms > 0 THEN reaction_ms END) AS avg_reaction_ms,
    MIN(CASE WHEN reaction_ms > 0 THEN reaction_ms END) AS best_reaction_ms,
    MAX(CASE WHEN speed_mps > 0 THEN speed_mps END)     AS max_glove_speed_mps,
    AVG(CASE WHEN etype = 'save' THEN accuracy END)     AS save_accuracy
  FROM ev
  GROUP BY player_id
)
SELECT
  a.player_id,
  COALESCE(n.name, 'Unknown')                                AS name,
  a.sessions,
  a.shots_faced,
  a.saves,
  a.goals_conceded,
  ROUND(100 * a.saves / NULLIF(a.shots_faced, 0), 1)         AS save_pct,
  a.punch_clearances,
  ROUND(a.avg_reaction_ms, 1)                                AS avg_reaction_ms,
  ROUND(a.best_reaction_ms, 1)                               AS best_reaction_ms,
  ROUND(a.max_glove_speed_mps, 2)                            AS max_glove_speed_mps,
  ROUND(a.save_accuracy * 100, 1)                            AS save_accuracy_pct,
  s.best_score
FROM agg a
LEFT JOIN (SELECT player_id, MAX(score) AS best_score FROM session_scores GROUP BY player_id) s
  ON s.player_id = a.player_id
LEFT JOIN (SELECT player_id, MAX(name) AS name FROM MOTION_DB.PUBLIC.PLAYERS GROUP BY player_id) n
  ON n.player_id = a.player_id;

-- -----------------------------------------------------------------------------
-- V_GOALKEEPER_ZONES: player x 9-grid zone (only zones that were shot at).
--   zone = COALESCE(payload:zone, payload:metrics:zone, row * 3 + col), 0..8,
--   row 0 = top, col 0 = screen left (src/sports/goalkeeper/types.ts ZONES).
--   Feeds the save heatmap; lowest save_pct per player = weakest zone.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW MOTION_DB.PUBLIC.V_GOALKEEPER_ZONES
  COMMENT = 'Goalkeeper save percentage per player and 9-grid zone (0 = top left, 8 = bottom right)'
AS
WITH ev AS (
  SELECT
    player_id,
    LOWER(event_type) AS etype,
    reaction_ms,
    COALESCE(
      TRY_TO_NUMBER(payload:zone::STRING),
      TRY_TO_NUMBER(payload:metrics:zone::STRING),
      COALESCE(TRY_TO_NUMBER(payload:row::STRING), TRY_TO_NUMBER(payload:metrics:row::STRING)) * 3
        + COALESCE(TRY_TO_NUMBER(payload:col::STRING), TRY_TO_NUMBER(payload:metrics:col::STRING))
    ) AS zone
  FROM MOTION_DB.PUBLIC.MOTION_EVENTS
  WHERE player_id IS NOT NULL
    AND LOWER(COALESCE(sport, 'boxing')) = 'goalkeeper'
    AND LOWER(event_type) IN ('save', 'goal')
),
z AS (
  SELECT
    player_id,
    zone,
    COUNT(*)                                            AS shots,
    COUNT_IF(etype = 'save')                            AS saves,
    COUNT_IF(etype = 'goal')                            AS goals,
    AVG(CASE WHEN reaction_ms > 0 THEN reaction_ms END) AS avg_reaction_ms
  FROM ev
  WHERE zone BETWEEN 0 AND 8
  GROUP BY player_id, zone
)
SELECT
  z.player_id,
  COALESCE(n.name, 'Unknown')              AS name,
  z.zone,
  FLOOR(z.zone / 3)                        AS zone_row,
  MOD(z.zone, 3)                           AS zone_col,
  CASE z.zone
    WHEN 0 THEN 'top left'    WHEN 1 THEN 'top centre'    WHEN 2 THEN 'top right'
    WHEN 3 THEN 'middle left' WHEN 4 THEN 'centre'        WHEN 5 THEN 'middle right'
    WHEN 6 THEN 'bottom left' WHEN 7 THEN 'bottom centre' ELSE 'bottom right'
  END                                      AS zone_label,
  z.shots,
  z.saves,
  z.goals,
  ROUND(100 * z.saves / NULLIF(z.shots, 0), 1) AS save_pct,
  ROUND(z.avg_reaction_ms, 1)              AS avg_reaction_ms
FROM z
LEFT JOIN (SELECT player_id, MAX(name) AS name FROM MOTION_DB.PUBLIC.PLAYERS GROUP BY player_id) n
  ON n.player_id = z.player_id;

-- -----------------------------------------------------------------------------
-- V_ARCHERY_STATS: one row per player with archery events.
--   ring = COALESCE(payload:ring, payload:metrics:ring); bullseye = ring >= 10.
--   grouping = per session, RMS distance of the hits (dx, dy) from that session
--   centroid, sessions with >= 2 located arrows only; best_grouping = tightest
--   session, avg_grouping = mean over sessions. Lower is tighter. NULL until the
--   game sends dx/dy. mean_dx / mean_dy = aim bias (+dx right, +dy up).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW MOTION_DB.PUBLIC.V_ARCHERY_STATS
  COMMENT = 'Per-player archery stats: arrows, avg/best points, bullseyes, grouping, aim bias'
AS
WITH ev AS (
  SELECT
    player_id, session_id,
    COALESCE(points, 0) AS points,
    accuracy,
    COALESCE(TRY_TO_DOUBLE(payload:ring::STRING), TRY_TO_DOUBLE(payload:metrics:ring::STRING)) AS ring,
    COALESCE(TRY_TO_DOUBLE(payload:dx::STRING),   TRY_TO_DOUBLE(payload:metrics:dx::STRING))   AS dx,
    COALESCE(TRY_TO_DOUBLE(payload:dy::STRING),   TRY_TO_DOUBLE(payload:metrics:dy::STRING))   AS dy
  FROM MOTION_DB.PUBLIC.MOTION_EVENTS
  WHERE player_id IS NOT NULL
    AND LOWER(COALESCE(sport, 'boxing')) = 'archery'
    AND LOWER(event_type) IN ('arrow', 'arrow_release')
),
located AS (
  SELECT
    player_id, session_id, dx, dy,
    AVG(dx) OVER (PARTITION BY player_id, session_id) AS cx,
    AVG(dy) OVER (PARTITION BY player_id, session_id) AS cy
  FROM ev
  WHERE dx IS NOT NULL AND dy IS NOT NULL
),
session_grouping AS (
  SELECT player_id, session_id, SQRT(AVG(SQUARE(dx - cx) + SQUARE(dy - cy))) AS group_rms
  FROM located
  GROUP BY player_id, session_id
  HAVING COUNT(*) >= 2
),
session_scores AS (
  SELECT player_id, session_id, SUM(points) AS score
  FROM ev
  GROUP BY player_id, session_id
),
agg AS (
  SELECT
    player_id,
    COUNT(DISTINCT session_id) AS sessions,
    COUNT(*)                   AS arrows,
    AVG(points)                AS avg_points,
    MAX(points)                AS best_arrow,
    AVG(ring)                  AS avg_ring,
    COUNT_IF(ring >= 10)       AS bullseyes,
    AVG(accuracy)              AS accuracy,
    AVG(dx)                    AS mean_dx,
    AVG(dy)                    AS mean_dy
  FROM ev
  GROUP BY player_id
)
SELECT
  a.player_id,
  COALESCE(n.name, 'Unknown')   AS name,
  a.sessions,
  a.arrows,
  ROUND(a.avg_points, 2)        AS avg_points,
  a.best_arrow,
  s.best_score,
  ROUND(a.avg_ring, 2)          AS avg_ring,
  a.bullseyes,
  ROUND(a.accuracy * 100, 1)    AS accuracy_pct,
  ROUND(g.best_grouping, 3)     AS best_grouping,
  ROUND(g.avg_grouping, 3)      AS avg_grouping,
  ROUND(a.mean_dx, 3)           AS mean_dx,
  ROUND(a.mean_dy, 3)           AS mean_dy
FROM agg a
LEFT JOIN (SELECT player_id, MAX(score) AS best_score FROM session_scores GROUP BY player_id) s
  ON s.player_id = a.player_id
LEFT JOIN (
  SELECT player_id, MIN(group_rms) AS best_grouping, AVG(group_rms) AS avg_grouping
  FROM session_grouping GROUP BY player_id
) g ON g.player_id = a.player_id
LEFT JOIN (SELECT player_id, MAX(name) AS name FROM MOTION_DB.PUBLIC.PLAYERS GROUP BY player_id) n
  ON n.player_id = a.player_id;

-- -----------------------------------------------------------------------------
-- V_LEADERBOARD_BY_SPORT: every sport, every player (no top-10 cut; callers
-- filter sport and ORDER BY rank LIMIT n). Same ranking as V_LEADERBOARD:
-- best session score, then max speed, then best reaction, then player_id.
--   max_speed: boxing = fastest punch (same as V_LEADERBOARD.fastest_punch);
--              goalkeeper = fastest glove; archery = fastest release (> 0 only).
-- GET /api/leaderboard?sport=goalkeeper|archery reads it (boxing keeps V_LEADERBOARD).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW MOTION_DB.PUBLIC.V_LEADERBOARD_BY_SPORT
  COMMENT = 'Leaderboard per sport: sport, rank, player_id, name, best_score, score, sessions, max_speed, best_reaction_ms'
AS
WITH ev AS (
  SELECT
    LOWER(COALESCE(sport, 'boxing')) AS sport,
    session_id, player_id, speed_mps, reaction_ms,
    LOWER(event_type) AS etype,
    COALESCE(points, 0) AS points
  FROM MOTION_DB.PUBLIC.MOTION_EVENTS
  WHERE player_id IS NOT NULL
),
session_scores AS (
  SELECT sport, player_id, session_id, SUM(points) AS score
  FROM ev
  GROUP BY sport, player_id, session_id
),
per_event AS (
  SELECT
    sport, player_id,
    MAX(CASE
          WHEN sport = 'boxing' THEN CASE WHEN etype IN ('jab', 'cross', 'hook', 'uppercut') THEN speed_mps END
          WHEN speed_mps > 0 THEN speed_mps
        END)                                            AS max_speed,
    MIN(CASE WHEN reaction_ms > 0 THEN reaction_ms END) AS best_reaction_ms
  FROM ev
  GROUP BY sport, player_id
),
per_player AS (
  SELECT
    s.sport,
    s.player_id,
    MAX(s.score)          AS best_score,
    COUNT(*)              AS sessions,
    MAX(e.max_speed)      AS max_speed,
    MIN(e.best_reaction_ms) AS best_reaction_ms
  FROM session_scores s
  JOIN per_event e ON e.sport = s.sport AND e.player_id = s.player_id
  GROUP BY s.sport, s.player_id
)
SELECT
  p.sport,
  ROW_NUMBER() OVER (
    PARTITION BY p.sport
    ORDER BY p.best_score DESC NULLS LAST,
             p.max_speed DESC NULLS LAST,
             p.best_reaction_ms ASC NULLS LAST,
             p.player_id
  )                              AS rank,
  p.player_id,
  COALESCE(n.name, 'Unknown')    AS name,
  p.best_score,
  p.best_score                   AS score,
  p.sessions,
  ROUND(p.max_speed, 2)          AS max_speed,
  ROUND(p.best_reaction_ms, 1)   AS best_reaction_ms
FROM per_player p
LEFT JOIN (SELECT player_id, MAX(name) AS name FROM MOTION_DB.PUBLIC.PLAYERS GROUP BY player_id) n
  ON n.player_id = p.player_id;

-- -----------------------------------------------------------------------------
-- V_DECATHLON: cross-sport "Overall Kinetic Rating", one row per player.
--   <sport>_pct = percentile of the player best_score within that sport,
--                 100 * CUME_DIST() (share of that sport players with a best score
--                 <= yours: the top player is 100, a sport with one player gives 100).
--   overall_rating = mean of the <sport>_pct of the sports played (NULLs skipped),
--                    rounded to 0.1. sports_played = 1..3. overall_rank: rating,
--                    then sports played, then player_id.
-- MULTISPORT_RATING (below) is the same data as a dynamic table.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW MOTION_DB.PUBLIC.V_DECATHLON
  COMMENT = 'Cross-sport rating: per-sport percentile of best score, overall_rating = mean over sports played'
AS
WITH pct AS (
  SELECT
    sport, player_id, name, best_score,
    100 * CUME_DIST() OVER (PARTITION BY sport ORDER BY best_score ASC NULLS FIRST) AS sport_pct
  FROM MOTION_DB.PUBLIC.V_LEADERBOARD_BY_SPORT
  WHERE sport IN ('boxing', 'goalkeeper', 'archery')
),
wide AS (
  SELECT
    player_id,
    MAX(name)                                                AS name,
    MAX(CASE WHEN sport = 'boxing'     THEN best_score END)  AS boxing_best_score,
    MAX(CASE WHEN sport = 'boxing'     THEN sport_pct END)   AS boxing_pct,
    MAX(CASE WHEN sport = 'goalkeeper' THEN best_score END)  AS goalkeeper_best_score,
    MAX(CASE WHEN sport = 'goalkeeper' THEN sport_pct END)   AS goalkeeper_pct,
    MAX(CASE WHEN sport = 'archery'    THEN best_score END)  AS archery_best_score,
    MAX(CASE WHEN sport = 'archery'    THEN sport_pct END)   AS archery_pct,
    COUNT(DISTINCT sport)                                    AS sports_played,
    AVG(sport_pct)                                           AS overall_rating
  FROM pct
  GROUP BY player_id
)
SELECT
  ROW_NUMBER() OVER (ORDER BY overall_rating DESC NULLS LAST, sports_played DESC, player_id) AS overall_rank,
  player_id,
  COALESCE(name, 'Unknown')       AS name,
  sports_played,
  ROUND(overall_rating, 1)        AS overall_rating,
  boxing_best_score,
  ROUND(boxing_pct, 1)            AS boxing_pct,
  goalkeeper_best_score,
  ROUND(goalkeeper_pct, 1)        AS goalkeeper_pct,
  archery_best_score,
  ROUND(archery_pct, 1)           AS archery_pct
FROM wide;

-- -----------------------------------------------------------------------------
-- MULTISPORT_RATING: V_DECATHLON materialised as a dynamic table (1 minute lag)
-- so the booth leaderboard reads a precomputed row set. REFRESH_MODE = FULL for
-- the same reason as PLAYER_FORM (window functions, CUME_DIST over an aggregate);
-- Snowflake skips a scheduled refresh when MOTION_EVENTS and PLAYERS did not
-- change, so an idle booth does not keep the warehouse running. Both base tables
-- have CHANGE_TRACKING = TRUE (setup.sql).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE MOTION_DB.PUBLIC.MULTISPORT_RATING
  TARGET_LAG = '1 minute'
  WAREHOUSE = MOTION_WH
  REFRESH_MODE = FULL
  INITIALIZE = ON_CREATE
  COMMENT = 'Cross-sport decathlon rating per player (V_DECATHLON as a dynamic table)'
AS
SELECT
  overall_rank, player_id, name, sports_played, overall_rating,
  boxing_best_score, boxing_pct,
  goalkeeper_best_score, goalkeeper_pct,
  archery_best_score, archery_pct
FROM MOTION_DB.PUBLIC.V_DECATHLON;

-- -----------------------------------------------------------------------------
-- Grants (CREATE OR REPLACE drops grants on the old object, so these run every
-- time; they are idempotent).
-- -----------------------------------------------------------------------------
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_GOALKEEPER_STATS     TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_GOALKEEPER_ZONES     TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_ARCHERY_STATS        TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_LEADERBOARD_BY_SPORT TO ROLE MOTION_APP_ROLE;
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_DECATHLON            TO ROLE MOTION_APP_ROLE;
GRANT SELECT, MONITOR ON DYNAMIC TABLE MOTION_DB.PUBLIC.MULTISPORT_RATING TO ROLE MOTION_APP_ROLE;

GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_GOALKEEPER_STATS     TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_GOALKEEPER_ZONES     TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_ARCHERY_STATS        TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_LEADERBOARD_BY_SPORT TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT ON VIEW MOTION_DB.PUBLIC.V_DECATHLON            TO ROLE MOTION_READONLY_ROLE;
GRANT SELECT, MONITOR ON DYNAMIC TABLE MOTION_DB.PUBLIC.MULTISPORT_RATING TO ROLE MOTION_READONLY_ROLE;
