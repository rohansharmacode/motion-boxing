import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/logger';
import { aggregatePlayer } from '../src/metrics';
import { SQL, SnowflakeRepo, fatigueFromParts, symmetryFromParts } from '../src/repo/snowflake';
import { normalizeRow, type Bind, type QueryResult, type SqlExecutor } from '../src/snowflake/executor';
import type { MotionEvent } from '../src/types';

type Handler = (sql: string, binds: Bind[]) => QueryResult | Promise<QueryResult>;

/** Records every statement; answers via a handler. Rows are passed through normalizeRow like the real executor. */
class FakeExecutor implements SqlExecutor {
  calls: { sql: string; binds: Bind[] }[] = [];
  constructor(private readonly handler: Handler = () => ({ rows: [] })) {}
  async query(sql: string, binds: Bind[] = []): Promise<QueryResult> {
    this.calls.push({ sql, binds });
    const r = await this.handler(sql, binds);
    return { ...r, rows: r.rows.map(normalizeRow) };
  }
  async close() {}
}

const countPlaceholders = (sql: string) => (sql.match(/\?/g) ?? []).length;

function ev(i: number, over: Partial<MotionEvent> = {}): MotionEvent {
  return {
    event_id: `e${i}`,
    session_id: 'sess-1',
    player_id: 'player-1',
    sport: 'boxing',
    event_ts: new Date(Date.UTC(2026, 10, 21, 12, 0, i)).toISOString(),
    event_type: 'jab',
    hand: i % 2 ? 'L' : 'R',
    speed_mps: 7 + i,
    accuracy: 0.5,
    reaction_ms: 200,
    guard_up: true,
    points: 10,
    payload: null,
    ...over,
  };
}

describe('SnowflakeRepo uses bind variables', () => {
  it('insertEvents: one multi-row INSERT ... SELECT FROM VALUES, 13 binds per row, no values in the SQL text', async () => {
    const db = new FakeExecutor();
    const repo = new SnowflakeRepo(db, silentLogger);
    const evil = "x'); DROP TABLE MOTION_EVENTS; --";
    await repo.insertEvents([ev(1), ev(2, { session_id: evil, payload: { raw: [1, 2] } }), ev(3)]);
    expect(db.calls).toHaveLength(1);
    const { sql, binds } = db.calls[0]!;
    expect(sql).toMatch(/INSERT INTO MOTION_EVENTS/);
    expect(sql).toMatch(/FROM VALUES/);
    expect(sql).toMatch(/TRY_PARSE_JSON\(v\.payload\)/);
    expect(sql).not.toMatch(/NOT EXISTS/);
    expect(countPlaceholders(sql)).toBe(3 * 13);
    expect(binds).toHaveLength(3 * 13);
    expect(sql).not.toContain('DROP');
    expect(sql).not.toContain('sess-1');
    expect(binds).toContain(evil);
    expect(binds).toContain('{"raw":[1,2]}');
    // timestamps are sent as UTC NTZ strings
    expect(binds[4]).toBe('2026-11-21 12:00:01.000');
  });

  it('insertEvents with dedupe adds the NOT EXISTS guard', async () => {
    const db = new FakeExecutor();
    await new SnowflakeRepo(db, silentLogger).insertEvents([ev(1)], { dedupe: true });
    expect(db.calls[0]!.sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM MOTION_EVENTS e WHERE e\.event_id = v\.event_id/);
  });

  it('createPlayer binds the name', async () => {
    const db = new FakeExecutor();
    const id = await new SnowflakeRepo(db, silentLogger).createPlayer("Robert'); DROP TABLE PLAYERS;--");
    const { sql, binds } = db.calls[0]!;
    expect(sql).toBe(SQL.insertPlayer);
    expect(binds[0]).toBe(id);
    expect(binds[1]).toBe("Robert'); DROP TABLE PLAYERS;--");
    expect(countPlaceholders(sql)).toBe(binds.length);
  });

  it('ensurePlayer / ensureSession are insert-if-missing MERGEs with every value bound', async () => {
    const db = new FakeExecutor();
    const repo = new SnowflakeRepo(db, silentLogger);
    await repo.ensurePlayer('p-1', "Naman'); DROP TABLE PLAYERS;--");
    await repo.ensurePlayer('p-2', null);
    await repo.ensureSession('s-1', 'p-1', 'boxing', '2026-11-21T14:02:00.000Z');
    const [named, unnamed, session] = db.calls;
    expect(named!.sql).toBe(SQL.upsertPlayer);
    expect(named!.sql).toMatch(/MERGE INTO PLAYERS[\s\S]*WHEN NOT MATCHED THEN INSERT/);
    expect(named!.binds.slice(0, 2)).toEqual(['p-1', "Naman'); DROP TABLE PLAYERS;--"]);
    expect(unnamed!.binds[1]).toBeNull();
    expect(session!.sql).toBe(SQL.ensureSession);
    expect(session!.sql).not.toMatch(/WHEN MATCHED/);
    expect(session!.binds).toEqual(['s-1', 'p-1', 'boxing', '2026-11-21 14:02:00.000']);
    for (const c of db.calls) expect(countPlaceholders(c.sql)).toBe(c.binds.length);
  });

  it('finalizeSession writes ai_coach_json via PARSE_JSON(?) only when not yet set', async () => {
    const db = new FakeExecutor(() => ({ rows: [{ 'number of rows updated': 1 }], numUpdated: 1 }));
    const repo = new SnowflakeRepo(db, silentLogger);
    const won = await repo.finalizeSession(
      'sess-1',
      { score: 1, total_punches: 1, avg_speed: 1, max_speed: 1, avg_reaction_ms: 1, best_reaction_ms: 1, accuracy: 1 },
      { tips: ['a', 'b', 'c'], drill: 'd', badge: 'b', summary: 's', fallback: false, model: 'm', generated_at: 'now' },
    );
    expect(won).toBe(true);
    const { sql, binds } = db.calls[0]!;
    expect(sql).toMatch(/ai_coach_json = PARSE_JSON\(\?\)/);
    expect(sql).toMatch(/ai_coach_json IS NULL/);
    expect(countPlaceholders(sql)).toBe(binds.length);
    expect(JSON.parse(binds[7] as string).tips).toEqual(['a', 'b', 'c']);
    expect(binds[8]).toBe('sess-1');
  });

  it('every parameterised statement has as many ? as binds', async () => {
    const db = new FakeExecutor();
    const repo = new SnowflakeRepo(db, silentLogger);
    await repo.getPlayer('p');
    await repo.createSession('p', 'boxing');
    await repo.getSession('s');
    await repo.playerSessions('p', 50);
    await repo.benchmarks('boxing');
    await repo.aggregateSession('s');
    await repo.playerMetrics('p');
    for (const c of db.calls) expect(countPlaceholders(c.sql)).toBe(c.binds.length);
  });
});

describe('SnowflakeRepo result mapping', () => {
  it('lower-cases keys and parses the stored coach card', async () => {
    const db = new FakeExecutor(() => ({
      rows: [
        {
          SESSION_ID: 's',
          PLAYER_ID: 'p',
          SPORT: 'boxing',
          STARTED_AT: '2026-11-21T12:00:00.000Z',
          ENDED_AT: '2026-11-21T12:03:00.000Z',
          SCORE: 120,
          TOTAL_PUNCHES: 30,
          AVG_SPEED: 7.123,
          MAX_SPEED: 9.5,
          AVG_REACTION_MS: 251.04,
          BEST_REACTION_MS: 180,
          ACCURACY: 0.71234,
          AI_COACH_JSON: JSON.stringify({ tips: ['a', 'b', 'c'], drill: 'd', badge: 'B', summary: 'S', fallback: true }),
        },
      ],
    }));
    const s = await new SnowflakeRepo(db, silentLogger).getSession('s');
    expect(s).toMatchObject({
      session_id: 's',
      ended_at: '2026-11-21T12:03:00.000Z',
      stats: { score: 120, total_punches: 30, avg_speed: 7.12, max_speed: 9.5, avg_reaction_ms: 251, best_reaction_ms: 180, accuracy: 0.712 },
      coach: { badge: 'B', fallback: true },
    });
  });

  it('leaderboard reads V_LEADERBOARD ordered by rank and falls back to inline SQL if the view is missing', async () => {
    const row = { RANK: 1, PLAYER_ID: 'p', NAME: 'Ada', SCORE: 50, BEST_SCORE: 50, FASTEST_PUNCH: 9.1, BEST_REACTION_MS: 190 };
    const ok = new FakeExecutor(() => ({ rows: [row] }));
    expect(await new SnowflakeRepo(ok, silentLogger).leaderboard(10)).toEqual([
      { rank: 1, player_id: 'p', name: 'Ada', score: 50, fastest_punch: 9.1, best_reaction_ms: 190 },
    ]);
    expect(ok.calls[0]!.sql).toMatch(/FROM V_LEADERBOARD ORDER BY rank LIMIT 10/);

    const missing = new FakeExecutor((sql) => {
      if (sql.includes('V_LEADERBOARD')) throw new Error("Object 'V_LEADERBOARD' does not exist");
      return { rows: [row] };
    });
    expect(await new SnowflakeRepo(missing, silentLogger).leaderboard(10)).toHaveLength(1);
    expect(missing.calls[1]!.sql).toMatch(/ROW_NUMBER\(\) OVER/);
  });

  it('aggregateSession prefers V_SESSION_STATS and falls back to inline SQL', async () => {
    const parts = { TOTAL_EVENTS: 5, N_JAB: 2, N_CROSS: 1, N_HOOK: 1, N_UPPERCUT: 0, N_BLOCK: 1, X_GUARD_PCT: 75, L_N: 2, R_N: 2, L_SPEED: 8, R_SPEED: 8, Q1_SPEED: null, Q4_SPEED: null };
    const stats = { SCORE: 42, TOTAL_PUNCHES: 4, AVG_SPEED: 8, MAX_SPEED: 9, AVG_REACTION_MS: 250, BEST_REACTION_MS: 200, ACCURACY: 0.75 };
    const viaView = new FakeExecutor(() => ({ rows: [{ ...stats, ...parts }] }));
    const agg = await new SnowflakeRepo(viaView, silentLogger).aggregateSession('s');
    expect(viaView.calls).toHaveLength(1);
    expect(viaView.calls[0]!.sql).toMatch(/FROM V_SESSION_STATS WHERE session_id = \?/);
    expect(agg.stats).toEqual({ score: 42, total_punches: 4, avg_speed: 8, max_speed: 9, avg_reaction_ms: 250, best_reaction_ms: 200, accuracy: 0.75 });
    expect(agg.extras).toMatchObject({ guard_pct: 75, symmetry_pct: 100, fatigue_drop_pct: null, total_events: 5 });
    expect(agg.extras.punch_mix).toEqual({ jab: 2, cross: 1, hook: 1, uppercut: 0, block: 1 });

    const noView = new FakeExecutor((sql) => {
      if (sql.includes('V_SESSION_STATS')) throw new Error('does not exist');
      return { rows: [{ ...stats, ...parts }] };
    });
    expect((await new SnowflakeRepo(noView, silentLogger).aggregateSession('s')).stats.score).toBe(42);
    expect(noView.calls).toHaveLength(2);
  });

  it('playerMetrics uses PLAYER_FORM only when it has caught up with live events', async () => {
    const form = { LIVE_PUNCHES: 10, PUNCHES: 10, AVG_SPEED: 7.5, AVG_REACTION_MS: 240, ACCURACY_PCT: 70, GUARD_PCT: 80, SYMMETRY_PCT: 85, FATIGUE_DROP_PCT: 5 };
    const fresh = new FakeExecutor(() => ({ rows: [form] }));
    expect(await new SnowflakeRepo(fresh, silentLogger).playerMetrics('p')).toEqual({
      punch_speed_mps: 7.5,
      reaction_ms: 240,
      accuracy_pct: 70,
      guard_pct: 80,
      symmetry_pct: 85,
      fatigue_drop_pct: 5,
    });
    expect(fresh.calls).toHaveLength(1);

    const stale = new FakeExecutor((sql) =>
      sql.includes('PLAYER_FORM')
        ? { rows: [{ ...form, PUNCHES: 6 }] }
        : { rows: [{ AVG_SPEED: 8, AVG_REACTION_MS: 230, ACCURACY_PCT: 72, GUARD_PCT: 81, L_N: 5, R_N: 5, L_SPEED: 8, R_SPEED: 8, Q1_SPEED: 10, Q4_SPEED: 9 }] },
    );
    expect(await new SnowflakeRepo(stale, silentLogger).playerMetrics('p')).toEqual({
      punch_speed_mps: 8,
      reaction_ms: 230,
      accuracy_pct: 72,
      guard_pct: 81,
      symmetry_pct: 100,
      fatigue_drop_pct: 10,
    });
    expect(stale.calls[1]!.sql).toMatch(/NTILE\(4\) OVER \(PARTITION BY session_id ORDER BY event_ts, event_id\)/);
  });

  it('runReadOnlyQuery uses the read-only executor and wraps the SQL in a LIMIT', async () => {
    const main = new FakeExecutor();
    const ro = new FakeExecutor(() => ({ rows: [{ NAME: 'Ada' }] }));
    const rows = await new SnowflakeRepo(main, silentLogger, ro).runReadOnlyQuery('SELECT name FROM PLAYERS', 25);
    expect(rows).toEqual([{ name: 'Ada' }]);
    expect(main.calls).toHaveLength(0);
    expect(ro.calls[0]!.sql).toBe('SELECT * FROM (\nSELECT name FROM PLAYERS\n) LIMIT 25');
    await expect(new SnowflakeRepo(main, silentLogger).runReadOnlyQuery('SELECT 1', 5)).rejects.toThrow(/read-only/);
  });

  it('ping returns false instead of throwing', async () => {
    const db = new FakeExecutor(() => {
      throw new Error('network');
    });
    expect(await new SnowflakeRepo(db, silentLogger).ping()).toBe(false);
  });
});

describe('SQL-side formulas match the JS mirror', () => {
  it('symmetry and fatigue', () => {
    const events: MotionEvent[] = [];
    for (let i = 0; i < 8; i++) events.push(ev(i, { hand: i < 6 ? 'L' : 'R', speed_mps: 10 - i * 0.5 }));
    const js = aggregatePlayer(events);
    const left = events.filter((e) => e.hand === 'L');
    const right = events.filter((e) => e.hand === 'R');
    const avg = (a: MotionEvent[]) => a.reduce((s, e) => s + e.speed_mps, 0) / a.length;
    expect(js.symmetry_pct).toBeCloseTo(symmetryFromParts(left.length, right.length, avg(left), avg(right))!, 1);
    // 8 punches -> quartiles of 2: Q1 = 10, 9.5 ; Q4 = 7, 6.5
    expect(js.fatigue_drop_pct).toBeCloseTo(fatigueFromParts(9.75, 6.75)!, 1);
  });
});
