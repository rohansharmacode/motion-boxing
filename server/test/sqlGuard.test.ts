import { describe, expect, it } from 'vitest';
import { guardSql } from '../src/sqlGuard';

describe('guardSql: allowed', () => {
  it.each([
    'SELECT * FROM PLAYERS',
    'select name, score from v_leaderboard order by rank limit 5',
    'SELECT name FROM PLAYERS;',
    'SELECT p.name, s.score FROM PLAYERS p JOIN SESSIONS s ON s.player_id = p.player_id WHERE s.score > 10',
    'SELECT p.name FROM PLAYERS AS p, SESSIONS s WHERE p.player_id = s.player_id',
    'SELECT * FROM MOTION_DB.PUBLIC.PLAYER_FORM WHERE player_id = \'abc-123\'',
    'SELECT * FROM public.v_global_stats',
    'WITH best AS (SELECT player_id, MAX(score) AS m FROM SESSIONS GROUP BY player_id) SELECT * FROM best b JOIN PLAYERS p ON p.player_id = b.player_id',
    "SELECT COUNT(*) FROM MOTION_EVENTS WHERE event_type = 'jab' AND hand = 'L'",
    "SELECT * FROM PLAYERS WHERE name = 'drop table; delete from x -- not code'".replace('--', '- -'),
    'SELECT EXTRACT(year FROM started_at) AS y, COUNT(*) FROM SESSIONS GROUP BY 1',
    'SELECT * FROM (SELECT player_id, score FROM SESSIONS) t WHERE score IS DISTINCT FROM NULL',
    'SELECT s.session_id, f.value::string AS tip FROM SESSIONS s, LATERAL FLATTEN(input => s.ai_coach_json:tips) f',
    'SELECT GET(ai_coach_json, \'badge\') FROM SESSIONS',
    'SELECT (SELECT MAX(score) FROM SESSIONS) AS top, name FROM PLAYERS',
    'SELECT quartile, avg_speed FROM V_FATIGUE_CURVE UNION ALL SELECT 0, avg_speed FROM V_GLOBAL_STATS',
    'SELECT 1',
  ])('allows: %s', (sql) => {
    const r = guardSql(sql);
    expect(r).toEqual({ ok: true, sql: sql.trim().replace(/;$/, '').trim() });
  });
});

describe('guardSql: rejected', () => {
  it.each([
    ['DML', 'DELETE FROM PLAYERS'],
    ['DDL', 'DROP TABLE PLAYERS'],
    ['update', 'UPDATE SESSIONS SET score = 0'],
    ['insert via select', 'INSERT INTO PLAYERS SELECT * FROM PLAYERS'],
    ['multi statement', 'SELECT 1; DROP TABLE PLAYERS'],
    ['two selects', 'SELECT 1; SELECT 2'],
    ['line comment', 'SELECT * FROM PLAYERS -- hi'],
    ['block comment', 'SELECT /* x */ * FROM PLAYERS'],
    ['not select', 'SHOW TABLES'],
    ['call', 'CALL SYSTEM$WAIT(10)'],
    ['create as select', 'CREATE TABLE x AS SELECT * FROM PLAYERS'],
    ['merge', 'MERGE INTO PLAYERS USING SESSIONS ON TRUE WHEN MATCHED THEN DELETE'],
    ['unknown table', 'SELECT * FROM SECRETS'],
    ['other schema', 'SELECT * FROM OTHER_DB.PUBLIC.PLAYERS'],
    ['information_schema', 'SELECT * FROM INFORMATION_SCHEMA.TABLES'],
    ['account usage', 'SELECT * FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY'],
    ['system function', 'SELECT SYSTEM$CANCEL_ALL_QUERIES(1)'],
    ['cortex in query', "SELECT SNOWFLAKE.CORTEX.COMPLETE('m', name) FROM PLAYERS"],
    ['ai function', "SELECT AI_COMPLETE('m', name) FROM PLAYERS"],
    ['stage', 'SELECT $1 FROM @my_stage'],
    ['identifier()', "SELECT * FROM IDENTIFIER('PLAYERS')"],
    ['table function', 'SELECT * FROM TABLE(GENERATOR(ROWCOUNT => 1000000000))'],
    ['result_scan', "SELECT * FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))"],
    ['dollar quoting', 'SELECT $$x$$'],
    ['unterminated string', "SELECT 'abc FROM PLAYERS"],
    ['use role', 'USE ROLE ACCOUNTADMIN'],
    ['set variable', 'SET x = 1'],
    ['select into', 'SELECT * INTO new_t FROM PLAYERS'],
    ['subquery on unknown table', 'SELECT * FROM PLAYERS WHERE player_id IN (SELECT id FROM SECRETS)'],
    ['comma join to unknown table', 'SELECT * FROM PLAYERS p, SECRETS s'],
    ['empty', '   '],
    ['non-string', 42],
  ])('rejects %s', (_label, sql) => {
    const r = guardSql(sql);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toEqual(expect.any(String));
  });

  it('rejects overly long SQL', () => {
    expect(guardSql('SELECT ' + '1,'.repeat(3000) + '1').ok).toBe(false);
  });
});
