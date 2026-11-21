import { describe, expect, it } from 'vitest';
import { buildCoachPrompt, generateCoachCard } from '../src/coach';
import { coachResponseFormatLiteral, parseStructuredCard, pickWeakestFocus } from '../src/coachStructured';
import { MOCK_STRUCTURED_CARD, SnowflakeCortex, isUnsupportedError, structuredCompleteSql } from '../src/cortex';
import { BUILTIN_DRILLS, drillSearchSql, mockDrillSearch, parseSearchResponse, type DrillSearchResult } from '../src/drills';
import { silentLogger } from '../src/logger';
import { SnowflakeRepo } from '../src/repo/snowflake';
import { normalizeRow, type Bind, type QueryResult, type SqlExecutor } from '../src/snowflake/executor';
import { dollarQuotedJson, sqlString, toObjectLiteral } from '../src/sqlLiteral';
import type { SessionAggregate } from '../src/types';
import { TimeoutError } from '../src/util';
import { FnCortex, makeApp } from './helpers';

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

const LEGACY_CARD = {
  tips: ['Keep the guard up.', 'Turn the hip on the cross.', 'Breathe out on every punch.'],
  drill: 'Shadow Rounds: 3 x 2 min shadow boxing',
  badge: 'Speed Demon',
  summary: 'Great round, 120 points!',
};

const AGG: SessionAggregate = {
  stats: { score: 120, total_punches: 20, avg_speed: 8, max_speed: 10, avg_reaction_ms: 240, best_reaction_ms: 200, accuracy: 0.8 },
  extras: {
    guard_pct: 30,
    symmetry_pct: 90,
    fatigue_drop_pct: 5,
    punch_mix: { jab: 8, cross: 6, hook: 4, uppercut: 2, block: 1 },
    total_events: 21,
  },
};

const compileError = () => Object.assign(new Error("SQL compilation error:\nUnknown function AI_COMPLETE"), { code: '002140' });
const isStructured = (sql: string) => sql.includes('AI_COMPLETE(');
const isLegacy = (sql: string) => sql.includes('SNOWFLAKE.CORTEX.COMPLETE(');

describe('Snowflake literal builders', () => {
  it('escapes backslash and single quote in strings', () => {
    expect(sqlString("it's")).toBe("'it\\'s'");
    expect(sqlString('a\\b')).toBe("'a\\\\b'");
    expect(sqlString("\\'")).toBe("'\\\\\\''");
  });

  it('builds nested OBJECT / ARRAY constants', () => {
    expect(toObjectLiteral({ type: 'json', n: 1.5, ok: true, none: null, list: ['a', "b'c"], o: { k: [1, 2] } })).toBe(
      "{'type': 'json', 'n': 1.5, 'ok': TRUE, 'none': NULL, 'list': ['a', 'b\\'c'], 'o': {'k': [1, 2]}}",
    );
    expect(toObjectLiteral({ "we'ird\\key": 'x' })).toBe("{'we\\'ird\\\\key': 'x'}");
    expect(() => toObjectLiteral({ bad: Number.NaN })).toThrow();
  });

  it('dollar-quoted JSON never contains $$ inside and parses back to the same value', () => {
    const lit = dollarQuotedJson({ query: 'cash $$ money $', n: 1 });
    expect(lit.startsWith('$$') && lit.endsWith('$$')).toBe(true);
    const inner = lit.slice(2, -2);
    expect(inner).not.toContain('$');
    expect(JSON.parse(inner)).toEqual({ query: 'cash $$ money $', n: 1 });
  });

  it('response_format is a {type: json, schema} object literal with required arrays', () => {
    const rf = coachResponseFormatLiteral();
    expect(rf.startsWith("{'type': 'json', 'schema': {'type': 'object'")).toBe(true);
    expect(rf).toContain("'required': ['headline', 'summary', 'tips', 'drill', 'badge', 'focus']");
    expect(rf).toContain("'tips': {'type': 'array', 'items': {'type': 'string'}}");
    expect(rf).not.toContain('"');
  });

  it('structured SQL uses named arguments with model and prompt bound', () => {
    const sql = structuredCompleteSql();
    expect(sql).toMatch(/^SELECT AI_COMPLETE\(\n {2}model => \?,\n {2}prompt => \?,\n {2}model_parameters => \{'temperature': 0\.3, 'max_tokens': 700\},\n {2}response_format => \{'type': 'json'/);
    expect((sql.match(/\?/g) ?? []).length).toBe(2);
    expect(sql).toMatch(/\) AS response$/);
  });
});

describe('parseStructuredCard', () => {
  it('maps an OBJECT result onto the internal card', () => {
    const p = parseStructuredCard(MOCK_STRUCTURED_CARD)!;
    expect(p.card.tips).toEqual(MOCK_STRUCTURED_CARD.tips);
    expect(p.card.drill).toBe(`${MOCK_STRUCTURED_CARD.drill.name}: ${MOCK_STRUCTURED_CARD.drill.description}`);
    expect(p.card.badge).toBe('Sharp Shooter');
    expect(p.headline).toBe(MOCK_STRUCTURED_CARD.headline);
    expect(p.focus).toBe('guard');
  });

  it('accepts JSON text, double-encoded text and a show_details wrapper', () => {
    const want = parseStructuredCard(MOCK_STRUCTURED_CARD);
    expect(parseStructuredCard(JSON.stringify(MOCK_STRUCTURED_CARD))).toEqual(want);
    expect(parseStructuredCard(JSON.stringify(JSON.stringify(MOCK_STRUCTURED_CARD)))).toEqual(want);
    expect(parseStructuredCard({ structured_output: MOCK_STRUCTURED_CARD, model: 'x' })).toEqual(want);
  });

  it('drops an unknown focus and rejects incomplete cards', () => {
    expect(parseStructuredCard({ ...MOCK_STRUCTURED_CARD, focus: 'dancing' })?.focus).toBeNull();
    expect(parseStructuredCard({ ...MOCK_STRUCTURED_CARD, tips: ['one', 'two'] })).toBeNull();
    expect(parseStructuredCard({ ...MOCK_STRUCTURED_CARD, drill: {} })).toBeNull();
    expect(parseStructuredCard('not json')).toBeNull();
    expect(parseStructuredCard(null)).toBeNull();
  });
});

describe('focus selection', () => {
  it('picks the weakest area (percentile first, component formula otherwise)', () => {
    expect(pickWeakestFocus(AGG, {})).toBe('guard');
    expect(pickWeakestFocus(AGG, { reaction_ms: 5, guard_pct: 60 })).toBe('reaction');
    const empty: SessionAggregate = {
      stats: { score: 0, total_punches: 0, avg_speed: null, max_speed: null, avg_reaction_ms: null, best_reaction_ms: null, accuracy: null },
      extras: { ...AGG.extras, guard_pct: null, symmetry_pct: null, fatigue_drop_pct: null },
    };
    expect(pickWeakestFocus(empty, {})).toBe('guard');
  });
});

describe('SnowflakeCortex structured output with fallback to CORTEX.COMPLETE', () => {
  it('uses AI_COMPLETE and maps the OBJECT result (structured:true)', async () => {
    const db = new FakeExecutor((sql) => (isStructured(sql) ? { rows: [{ RESPONSE: MOCK_STRUCTURED_CARD }] } : { rows: [] }));
    const cortex = new SnowflakeCortex(db, 'mistral-large3');
    const r = await generateCoachCard({ cortex, timeoutMs: 1000, log: silentLogger }, AGG, {});
    expect(r.fallback).toBe(false);
    expect(r.meta).toMatchObject({ structured: true, focus: 'guard', headline: MOCK_STRUCTURED_CARD.headline });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.binds[0]).toBe('mistral-large3');
    expect(String(db.calls[0]!.binds[1])).toContain('ROUND STATS');
    expect(cortex.health()).toMatchObject({ structured: { status: 'up' }, complete: { status: 'up' } });
  });

  it('also accepts the result as a JSON string', async () => {
    const db = new FakeExecutor(() => ({ rows: [{ RESPONSE: JSON.stringify(MOCK_STRUCTURED_CARD) }] }));
    const r = await generateCoachCard({ cortex: new SnowflakeCortex(db, 'm'), timeoutMs: 1000, log: silentLogger }, AGG, {});
    expect(r.meta?.structured).toBe(true);
    expect(r.card.badge).toBe('Sharp Shooter');
  });

  it('a compilation error falls back to CORTEX.COMPLETE and is remembered for later cards', async () => {
    const db = new FakeExecutor((sql) => {
      if (isStructured(sql)) throw compileError();
      if (isLegacy(sql)) return { rows: [{ RESPONSE: JSON.stringify(LEGACY_CARD) }] };
      return { rows: [] };
    });
    const cortex = new SnowflakeCortex(db, 'm');
    const deps = { cortex, timeoutMs: 1000, log: silentLogger };
    const first = await generateCoachCard(deps, AGG, {});
    expect(first).toMatchObject({ fallback: false, card: LEGACY_CARD, meta: { structured: false } });
    expect(db.calls.map((c) => (isStructured(c.sql) ? 'structured' : 'legacy'))).toEqual(['structured', 'legacy']);
    expect(cortex.structuredAvailable()).toBe(false);
    expect(cortex.health().structured.status).toBe('missing');

    const second = await generateCoachCard(deps, AGG, {});
    expect(second.fallback).toBe(false);
    expect(db.calls.map((c) => (isStructured(c.sql) ? 'structured' : 'legacy'))).toEqual(['structured', 'legacy', 'legacy']);
  });

  it('a timeout is not treated as unsupported: fallback card, structured stays enabled', async () => {
    const db = new FakeExecutor((sql) => (isStructured(sql) ? new Promise<QueryResult>(() => undefined) : { rows: [] }));
    const cortex = new SnowflakeCortex(db, 'm');
    const r = await generateCoachCard({ cortex, timeoutMs: 120, log: silentLogger }, AGG, {});
    expect(r).toMatchObject({ fallback: true, reason: 'timeout' });
    expect(cortex.structuredAvailable()).toBe(true);
    expect(db.calls.filter((c) => isLegacy(c.sql))).toHaveLength(0);
  });

  it('CORTEX_STRUCTURED=0 goes straight to CORTEX.COMPLETE', async () => {
    const db = new FakeExecutor(() => ({ rows: [{ RESPONSE: JSON.stringify(LEGACY_CARD) }] }));
    const r = await generateCoachCard({ cortex: new SnowflakeCortex(db, 'm', { structured: false }), timeoutMs: 1000, log: silentLogger }, AGG, {});
    expect(r.fallback).toBe(false);
    expect(db.calls.every((c) => isLegacy(c.sql))).toBe(true);
  });

  it('classifies errors', () => {
    expect(isUnsupportedError(compileError())).toBe(true);
    expect(isUnsupportedError(new Error('invalid argument response_format for model x'))).toBe(true);
    expect(isUnsupportedError(new TimeoutError('x', 1))).toBe(false);
    expect(isUnsupportedError(new Error('Request failed: 503 Service Unavailable'))).toBe(false);
  });
});

describe('Cortex Search grounding', () => {
  const okSearch = async (): Promise<DrillSearchResult> => ({ available: true, source: 'cortex_search', results: BUILTIN_DRILLS.slice(3, 4) });

  it('puts the drills and focus in the prompt and reports grounding', async () => {
    let prompt = '';
    const cortex = new FnCortex(async (p) => {
      prompt = p;
      return JSON.stringify(LEGACY_CARD);
    });
    const r = await generateCoachCard({ cortex, timeoutMs: 1000, log: silentLogger, search: okSearch }, AGG, {});
    expect(r.meta?.grounding).toEqual({ source: 'cortex_search', drills: [{ drill_id: 'builtin-guard-1', title: 'Glove-to-Chin Rounds' }] });
    expect(prompt).toContain('FOCUS: guard');
    expect(prompt).toContain('Glove-to-Chin Rounds');
    expect(prompt).toContain('Base the drill on ONE of these');
  });

  it('a failing search never fails the card', async () => {
    const cortex = new FnCortex(async () => JSON.stringify(LEGACY_CARD));
    const search = async (): Promise<DrillSearchResult> => {
      throw new Error('Cortex Search Service COACH_DRILL_SEARCH does not exist or not authorized');
    };
    const r = await generateCoachCard({ cortex, timeoutMs: 1000, log: silentLogger, search }, AGG, {});
    expect(r.fallback).toBe(false);
    expect(r.meta?.grounding).toEqual({ source: 'fallback', drills: [] });
  });

  it('a hanging search is cut off by its own timeout and the card still arrives', async () => {
    const cortex = new FnCortex(async () => JSON.stringify(LEGACY_CARD));
    const search = () => new Promise<DrillSearchResult>(() => undefined);
    const t0 = Date.now();
    const r = await generateCoachCard({ cortex, timeoutMs: 3000, log: silentLogger, search, searchTimeoutMs: 80 }, AGG, {});
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.fallback).toBe(false);
    expect(r.meta?.grounding.source).toBe('fallback');
  });

  it('the legacy prompt keeps its original JSON-only instructions', () => {
    const p = buildCoachPrompt(AGG, {}, { focus: 'guard', drills: BUILTIN_DRILLS.slice(0, 1) });
    expect(p).toMatch(/ONLY one JSON object/);
    expect(p).toContain('Snap-Back Jabs');
  });

  it('SEARCH_PREVIEW SQL: constant service name, dollar-quoted JSON with focus filter, no $ from user text', () => {
    const sql = drillSearchSql("guard $$; DROP TABLE x; 'x", { focus: 'guard', limit: 3 });
    expect(sql.startsWith("SELECT SNOWFLAKE.CORTEX.SEARCH_PREVIEW('MOTION_DB.PUBLIC.COACH_DRILL_SEARCH', $$")).toBe(true);
    expect(sql.endsWith('$$) AS response')).toBe(true);
    const json = JSON.parse(sql.slice(sql.indexOf('$$') + 2, sql.lastIndexOf('$$')));
    expect(json).toEqual({
      query: "guard $$; DROP TABLE x; 'x",
      columns: ['drill_id', 'title', 'focus', 'level', 'description', 'cues'],
      limit: 3,
      filter: { '@eq': { focus: 'guard' } },
    });
    expect(sql.split('$$')).toHaveLength(3);
  });

  it('parses the search reply as a string or an object', () => {
    const reply = { results: [{ drill_id: 'd1', title: 'T', focus: 'guard', level: 'beginner', description: 'x', cues: ['a', 'b'] }], request_id: 'r' };
    expect(parseSearchResponse(JSON.stringify(reply))[0]).toMatchObject({ drill_id: 'd1', cues: 'a; b' });
    expect(parseSearchResponse(reply)).toHaveLength(1);
    expect(() => parseSearchResponse('{}')).toThrow();
  });

  it('SnowflakeRepo.searchDrills returns available:false when the service is missing', async () => {
    const db = new FakeExecutor(() => {
      throw Object.assign(new Error("SQL compilation error:\nCortex Search Service 'COACH_DRILL_SEARCH' does not exist or not authorized."), { code: '002003' });
    });
    const repo = new SnowflakeRepo(db, silentLogger);
    expect(await repo.searchDrills('guard', { focus: 'guard', limit: 3 })).toEqual({ available: false, source: 'cortex_search', results: [] });
  });

  it('SnowflakeRepo.searchDrills maps rows', async () => {
    const db = new FakeExecutor(() => ({ rows: [{ RESPONSE: JSON.stringify({ results: [BUILTIN_DRILLS[0]] }) }] }));
    const r = await new SnowflakeRepo(db, silentLogger).searchDrills('speed', { focus: 'speed', limit: 3 });
    expect(r).toEqual({ available: true, source: 'cortex_search', results: [BUILTIN_DRILLS[0]] });
  });

  it('mock search filters by focus and ranks by keywords', () => {
    const r = mockDrillSearch('mirror combos left right', { limit: 2 }, BUILTIN_DRILLS);
    expect(r[0]!.drill_id).toBe('builtin-symmetry-1');
    expect(mockDrillSearch('anything', { focus: 'guard', limit: 3 }, BUILTIN_DRILLS).every((d) => d.focus === 'guard')).toBe(true);
  });
});

describe('POST /api/session/end in mock mode (structured + grounded)', () => {
  it('front-end shape gains coach.focus / grounding / structured; original shape is unchanged', async () => {
    const t = makeApp({ config: { coachTimeoutMs: 2000 } });
    const sid = 'sess-structured-1';
    const pid = 'player-structured-1';
    const fe = await t.http.post('/api/session/end').send({ session_id: sid, player_id: pid, display_name: 'Ada' }).expect(200);
    expect(fe.body.coach).toMatchObject({
      headline: MOCK_STRUCTURED_CARD.headline,
      structured: true,
      focus: expect.any(String),
      grounding: { source: 'mock', drills: expect.any(Array) },
    });
    expect(fe.body.coach.grounding.drills.length).toBeGreaterThan(0);
    expect(fe.body.coach_meta).toBeUndefined();

    const again = await t.http.post('/api/session/end').send({ session_id: sid }).expect(200);
    expect(Object.keys(again.body).sort()).toEqual(['coach', 'fallback', 'session_id', 'stats']);
    expect(Object.keys(again.body.coach).sort()).toEqual(['badge', 'drill', 'summary', 'tips']);

    const status = await t.http.get(`/api/session/${sid}/coach`).expect(200);
    expect(status.body.coach_card).toMatchObject({ structured: true });
    expect(t.repo.sessions.get(sid)?.coach).toMatchObject({ structured: true, grounding: { source: 'mock' } });
  });

  it('COACH_GROUNDING=0 skips the search', async () => {
    const t = makeApp({ config: { coachTimeoutMs: 2000, coachGrounding: false } });
    const fe = await t.http.post('/api/session/end').send({ session_id: 's-ng', player_id: 'p-ng' }).expect(200);
    expect(fe.body.coach.grounding).toEqual({ source: 'fallback', drills: [] });
  });
});
