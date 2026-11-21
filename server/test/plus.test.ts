import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { SnowflakeCortex } from '../src/cortex';
import type { Logger } from '../src/logger';
import { silentLogger } from '../src/logger';
import { aggregatePlayer } from '../src/metrics';
import { SQL, SnowflakeRepo, isMissingObjectError } from '../src/repo/snowflake';
import { normalizeRow, type Bind, type QueryResult, type SqlExecutor } from '../src/snowflake/executor';
import { cosine, regrSlope, styleComponents, styleVector } from '../src/style';
import { STYLE_COMPONENTS } from '../src/types';
import { apiEvents, makeApp, newSession, testConfig, type EventSpec, type TestApp } from './helpers';

type Handler = (sql: string, binds: Bind[]) => QueryResult | Promise<QueryResult>;

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

function capturingLogger() {
  const warnings: string[] = [];
  const log: Logger = { ...silentLogger, warn: (m) => warnings.push(m) };
  return { log, warnings };
}

const missing = (obj: string) =>
  Object.assign(new Error(`SQL compilation error:\nObject '${obj}' does not exist or not authorized.`), { code: '002003' });

const punches = (n: number, over: EventSpec = {}): EventSpec[] =>
  Array.from({ length: n }, (_, i) => ({ type: (['jab', 'cross', 'hook'] as const)[i % 3], ...over }));

async function playRound(t: TestApp, name: string, specs: EventSpec[], startMs: number, playerId?: string) {
  let pid = playerId;
  if (!pid) pid = (await t.http.post('/api/players').send({ name }).expect(201)).body.player_id as string;
  const sid = (await t.http.post('/api/session/start').send({ player_id: pid, sport: 'boxing' }).expect(201)).body.session_id as string;
  t.repo.sessions.get(sid)!.started_at = new Date(startMs).toISOString();
  await t.http.post('/api/events').send(apiEvents(sid, pid, specs, startMs)).expect(202);
  await t.http.post('/api/session/end').send({ session_id: sid }).expect(200);
  return { pid, sid };
}

async function seeded() {
  const t = makeApp({ config: { coachTimeoutMs: 2000 } });
  const day = Date.UTC(2026, 10, 20, 10);
  const ada = await playRound(t, 'Ada', punches(60, { speed: 6, accuracy: 0.6, guard: false }), day);
  await playRound(t, 'Ada', punches(50, { speed: 8, accuracy: 0.8 }), day + 3_600_000, ada.pid);
  const bo = await playRound(t, 'Bo', punches(12, { speed: 25 }), day + 7_200_000);
  const cy = await playRound(t, 'Cy', punches(4, { speed: 7, reaction: 180 }), day + 9_000_000);
  return { t, ada, bo, cy };
}

describe('style math (mirror of sql/pipelines.sql)', () => {
  it('components use the PLAYER_FORM formulas with NULL -> 50', () => {
    expect(styleComponents({})).toEqual({ speed: 50, reaction: 50, accuracy: 50, guard: 50, symmetry: 50, endurance: 50 });
    expect(styleComponents({ punch_speed_mps: 12, reaction_ms: 340, accuracy_pct: 70, guard_pct: -5, symmetry_pct: 90, fatigue_drop_pct: 10 })).toEqual({
      speed: 100,
      reaction: 50,
      accuracy: 70,
      guard: 0,
      symmetry: 90,
      endurance: 80,
    });
    expect(styleVector(styleComponents({}))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('cosine and REGR_SLOPE', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosine([0, 0], [1, 0])).toBeNull();
    expect(regrSlope([{ x: 1, y: 10 }, { x: 2, y: 20 }, { x: 3, y: 30 }])).toBeCloseTo(10);
    expect(regrSlope([{ x: 1, y: 10 }, { x: 2, y: null }])).toBeNull();
    expect(regrSlope([{ x: 1, y: 1 }, { x: 1, y: 2 }])).toBeNull();
  });
});

describe('Plus endpoints in mock mode', () => {
  it('GET /api/player/:id/style returns components, pro similarity, twin and scouting', async () => {
    const { t, ada, bo } = await seeded();
    const res = await t.http.get(`/api/player/${ada.pid}/style`).expect(200);
    expect(res.body).toMatchObject({
      player_id: ada.pid,
      available: true,
      pro_similarity_pct: expect.any(Number),
      twin: { player_id: expect.any(String), name: expect.any(String), similarity_pct: expect.any(Number) },
      scouting: { fighting_style: expect.any(String), scouting_report: expect.stringContaining('Ada'), updated_at: expect.any(String) },
    });
    expect(Object.keys(res.body.components)).toEqual([...STYLE_COMPONENTS]);
    for (const v of Object.values(res.body.components) as number[]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(res.body.twin.player_id).not.toBe(ada.pid);
    const want = styleComponents(aggregatePlayer(t.repo.events.filter((e) => e.player_id === bo.pid)));
    const bob = await t.http.get(`/api/player/${bo.pid}/style`).expect(200);
    expect(bob.body.components.speed).toBe(Math.round(want.speed * 10) / 10);
    expect(['Out-boxer', 'Swarmer', 'Slugger', 'Boxer-puncher', 'Counter-puncher']).toContain(bob.body.scouting.fighting_style);
  });

  it('style: player without punches has null components; scouting needs >= 10 punches; 404 / 400', async () => {
    const { t, cy } = await seeded();
    expect((await t.http.get(`/api/player/${cy.pid}/style`).expect(200)).body.scouting).toBeNull();
    const p = await t.http.post('/api/players').send({ name: 'New' }).expect(201);
    expect((await t.http.get(`/api/player/${p.body.player_id}/style`).expect(200)).body).toEqual({
      player_id: p.body.player_id,
      available: true,
      components: null,
      pro_similarity_pct: null,
      twin: null,
      scouting: null,
    });
    expect((await t.http.get('/api/player/nobody/style').expect(404)).body.error).toBe('player_not_found');
    expect((await t.http.get('/api/player/bad%20id/style').expect(400)).body.error).toBe('validation_error');
  });

  it('GET /api/player/:id/progress returns trends and ordered history', async () => {
    const { t, ada, cy } = await seeded();
    const res = await t.http.get(`/api/player/${ada.pid}/progress`).expect(200);
    expect(res.body).toMatchObject({
      player_id: ada.pid,
      available: true,
      sessions: 2,
      best_score: 600,
      last_score: 500,
      speed_trend_mps_per_session: 2,
      score_trend_per_session: -100,
      accuracy_trend_pct_per_session: 20,
      reaction_trend_ms_per_session: 0,
      improving: false,
    });
    expect(res.body.history.map((h: { session_index: number }) => h.session_index)).toEqual([1, 2]);
    expect(res.body.history[1]).toEqual({ session_index: 2, session_id: expect.any(String), score: 500, avg_speed: 8, accuracy_pct: 80 });
    const one = await t.http.get(`/api/player/${cy.pid}/progress`).expect(200);
    expect(one.body).toMatchObject({ sessions: 1, speed_trend_mps_per_session: null, improving: false });
    expect((await t.http.get(`/api/player/${ada.pid}/progress?limit=1`).expect(200)).body.history).toHaveLength(1);
    await t.http.get(`/api/player/${ada.pid}/progress?limit=0`).expect(400);
  });

  it('GET /api/highlights derives records, milestones and suspicious speeds, newest first', async () => {
    const { t, ada, bo, cy } = await seeded();
    const res = await t.http.get('/api/highlights?limit=20').expect(200);
    expect(res.body.available).toBe(true);
    const kinds = res.body.highlights.map((h: { kind: string; player_id: string }) => `${h.kind}:${h.player_id}`);
    expect(kinds).toContain(`speed_record:${ada.pid}`);
    expect(kinds).toContain(`punch_milestone:${ada.pid}`);
    expect(kinds).toContain(`suspicious_speed:${bo.pid}`);
    expect(kinds).toContain(`reaction_record:${cy.pid}`);
    expect(kinds).not.toContain(`speed_record:${bo.pid}`); // over 20 m/s does not count
    const h = res.body.highlights[0];
    expect(Object.keys(h).sort()).toEqual(['created_at', 'highlight_id', 'kind', 'message', 'name', 'player_id', 'session_id', 'unit', 'value']);
    const times = res.body.highlights.map((x: { created_at: string }) => x.created_at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(res.body.highlights.find((x: { kind: string }) => x.kind === 'punch_milestone').message).toBe('Ada reached 100 punches');
    expect((await t.http.get('/api/highlights?limit=2').expect(200)).body.highlights).toHaveLength(2);
    await t.http.get('/api/highlights?limit=abc').expect(400);
    await t.http.get('/api/highlights?limit=51').expect(400);
  });

  it('GET /api/drills/search filters by focus and validates params', async () => {
    const { http } = makeApp();
    const res = await http.get('/api/drills/search?q=keep%20the%20guard%20up&focus=guard').expect(200);
    expect(res.body).toMatchObject({ available: true, source: 'mock' });
    expect(res.body.results.length).toBeGreaterThan(0);
    for (const d of res.body.results) {
      expect(d.focus).toBe('guard');
      expect(Object.keys(d).sort()).toEqual(['cues', 'description', 'drill_id', 'focus', 'level', 'title']);
    }
    expect((await http.get('/api/drills/search').expect(200)).body.results.length).toBeGreaterThan(0);
    await http.get('/api/drills/search?focus=kicking').expect(400);
    await http.get(`/api/drills/search?q=${'x'.repeat(201)}`).expect(400);
    await http.get('/api/drills/search?limit=11').expect(400);
  });

  it('GET /api/snowflake/status reports every feature', async () => {
    const { http } = makeApp();
    const res = await http.get('/api/snowflake/status').expect(200);
    expect(res.body.mode).toBe('mock');
    expect(Object.keys(res.body.features).sort()).toEqual(
      ['cortex_analyst', 'cortex_complete', 'cortex_search', 'dynamic_tables', 'streams_tasks', 'structured_output', 'vectors'],
    );
    expect(res.body.features.cortex_analyst.status).toBe('streamlit');
    expect(res.body.features.cortex_complete.status).toBe('mock');
    expect(res.body.features.vectors.status).toBe('mock');
  });
});

describe('Plus objects in real mode (fake executor)', () => {
  it('missing objects -> available:false with one warning per object', async () => {
    const { log, warnings } = capturingLogger();
    const db = new FakeExecutor((sql) => {
      const m = /FROM (V_PLAYER_STYLE|V_STYLE_TWINS|PLAYER_SCOUTING|PLAYER_PROGRESS|SESSION_SUMMARY|V_HIGHLIGHTS_FEED)/.exec(sql);
      if (m) throw missing(m[1]!);
      return { rows: [] };
    });
    const repo = new SnowflakeRepo(db, log);
    expect(await repo.playerStyle('p1')).toEqual({ player_id: 'p1', available: false, components: null, pro_similarity_pct: null, twin: null, scouting: null });
    await repo.playerStyle('p2');
    expect(await repo.highlights(20)).toEqual({ available: false, highlights: [] });
    const prog = await repo.playerProgress('p1', 50);
    expect(prog).toMatchObject({ available: false, sessions: 0, improving: false, history: [] });
    expect(warnings).toHaveLength(6);
  });

  it('other errors still surface (503 at the route), not available:false', async () => {
    const db = new FakeExecutor(() => {
      throw new Error('Network error: connection reset');
    });
    await expect(new SnowflakeRepo(db, silentLogger).highlights(5)).rejects.toThrow('connection reset');
  });

  it('maps rows and binds the player id', async () => {
    const db = new FakeExecutor((sql) => {
      if (sql === SQL.playerStyle) return { rows: [{ PLAYER_ID: 'p1', NAME: 'Ada', C_SPEED: 71.23, C_REACTION: '40', C_ACCURACY: 60, C_GUARD: 50, C_SYMMETRY: null, C_ENDURANCE: 90, PRO_SIMILARITY_PCT: 82.5 }] };
      if (sql === SQL.styleTwin) return { rows: [{ TWIN_PLAYER_ID: 'p2', TWIN_NAME: 'Bo', SIMILARITY_PCT: 97.1 }] };
      if (sql === SQL.scouting) return { rows: [{ FIGHTING_STYLE: 'Swarmer', SCOUTING_REPORT: 'Busy hands.', UPDATED_AT: '2026-11-21T12:00:00.000Z' }] };
      if (sql === SQL.playerProgress) return { rows: [{ SESSIONS: 3, BEST_SCORE: 900, LAST_SCORE: 800, SPEED_TREND_MPS_PER_SESSION: 0.25, SCORE_TREND_PER_SESSION: 50, ACCURACY_TREND_PCT_PER_SESSION: 1.5, REACTION_TREND_MS_PER_SESSION: -4, IMPROVING: true }] };
      if (sql.includes('FROM SESSION_SUMMARY')) return { rows: [{ SESSION_INDEX: 1, SESSION_ID: 's1', SCORE: 700, AVG_SPEED: 7.1, ACCURACY_PCT: 61 }] };
      return { rows: [] };
    });
    const repo = new SnowflakeRepo(db, silentLogger);
    expect(await repo.playerStyle("p1'--")).toEqual({
      player_id: "p1'--",
      available: true,
      components: { speed: 71.2, reaction: 40, accuracy: 60, guard: 50, symmetry: 50, endurance: 90 },
      pro_similarity_pct: 82.5,
      twin: { player_id: 'p2', name: 'Bo', similarity_pct: 97.1 },
      scouting: { fighting_style: 'Swarmer', scouting_report: 'Busy hands.', updated_at: '2026-11-21T12:00:00.000Z' },
    });
    expect(await repo.playerProgress('p1', 10)).toMatchObject({ available: true, sessions: 3, improving: true, history: [{ session_index: 1, session_id: 's1' }] });
    for (const c of db.calls) {
      expect(c.sql).not.toContain("p1'--");
      expect((c.sql.match(/\?/g) ?? []).length).toBe(c.binds.length);
    }
  });

  it('isMissingObjectError', () => {
    expect(isMissingObjectError(missing('X'))).toBe(true);
    expect(isMissingObjectError(new Error('Unknown function SEARCH_PREVIEW'))).toBe(true);
    expect(isMissingObjectError(new Error('Warehouse MOTION_WH is suspended'))).toBe(false);
  });

  it('probeFeatures never throws: missing / error / timeout / up, each independent', async () => {
    const db = new FakeExecutor((sql) => {
      if (sql.includes('DYNAMIC_TABLE_REFRESH_HISTORY')) {
        return { rows: [{ NAME: 'PLAYER_FORM', STATE: 'SUCCEEDED', REFRESH_END_TIME: '2026-11-21T12:00:00.000Z' }, { NAME: 'SESSION_SUMMARY', STATE: 'SUCCEEDED', REFRESH_END_TIME: null }] };
      }
      if (sql.includes('SEARCH_PREVIEW')) throw missing('COACH_DRILL_SEARCH');
      if (sql.includes('TASK_HISTORY')) throw new Error('boom');
      if (sql === SQL.showTasks) throw new Error('Insufficient privileges to operate on schema');
      if (sql === SQL.vectorsProbe) return new Promise<QueryResult>(() => undefined);
      return { rows: [] };
    });
    const repo = new SnowflakeRepo(db, silentLogger);
    const p = await repo.probeFeatures(100);
    expect(p).toEqual({
      dynamic_tables: { status: 'up', detail: expect.stringContaining('PLAYER_FORM') },
      cortex_search: { status: 'missing', detail: expect.any(String) },
      streams_tasks: { status: 'missing', detail: expect.any(String) },
      vectors: { status: 'error', detail: 'timed out after 100 ms' },
      player_form_last_refresh: '2026-11-21T12:00:00.000Z',
    });
    // Cortex Search probe is cached for 60 s
    const before = db.calls.filter((c) => c.sql.includes('SEARCH_PREVIEW')).length;
    await repo.probeFeatures(100);
    expect(db.calls.filter((c) => c.sql.includes('SEARCH_PREVIEW')).length).toBe(before);
  });

  it('GET /api/snowflake/status stays 200 when every Snowflake call fails; Plus routes degrade', async () => {
    const db = new FakeExecutor((sql) => {
      if (sql.includes('FROM PLAYERS')) return { rows: [{ PLAYER_ID: 'p1', NAME: 'Ada' }] };
      if (/V_PLAYER_STYLE|V_STYLE_TWINS|PLAYER_SCOUTING|V_HIGHLIGHTS_FEED|PLAYER_PROGRESS|SESSION_SUMMARY|SEARCH_PREVIEW/.test(sql)) throw missing('X');
      throw new Error('Snowflake is down');
    });
    const repo = new SnowflakeRepo(db, silentLogger);
    const cortex = new SnowflakeCortex(db, 'mistral-large3');
    const { app } = createApp({ repo, cortex, config: testConfig({ statusProbeTimeoutMs: 200 }), log: silentLogger });
    const http = request(app);
    const res = await http.get('/api/snowflake/status').expect(200);
    expect(res.body.mode).toBe('snowflake');
    expect(res.body.features).toMatchObject({
      dynamic_tables: { status: 'error' },
      cortex_complete: { status: 'unknown' },
      structured_output: { status: 'unknown' },
      cortex_search: { status: 'missing' },
      streams_tasks: { status: 'error' },
      vectors: { status: 'missing' },
      cortex_analyst: { status: 'streamlit' },
    });
    expect((await http.get('/api/player/p1/style').expect(200)).body.available).toBe(false);
    expect((await http.get('/api/player/p1/progress').expect(200)).body.available).toBe(false);
    expect((await http.get('/api/highlights').expect(200)).body).toEqual({ available: false, highlights: [] });
    expect((await http.get('/api/drills/search?focus=guard').expect(200)).body).toEqual({ available: false, source: 'cortex_search', results: [] });
  });
});

describe('coach card in mock mode still works with the seeded helper', () => {
  it('newSession + end produces a stored structured card', async () => {
    const t = makeApp({ config: { coachTimeoutMs: 2000 } });
    const { playerId, sessionId } = await newSession(t.http);
    await t.http.post('/api/events').send(apiEvents(sessionId, playerId, punches(5)));
    await t.http.post('/api/session/end').send({ session_id: sessionId }).expect(200);
    expect(t.repo.sessions.get(sessionId)?.coach?.structured).toBe(true);
  });
});
