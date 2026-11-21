import { describe, expect, it } from 'vitest';
import { FALLBACK_TIPS, extractJsonObjects, fallbackCard, parseCoachCard } from '../src/coach';
import { MOCK_COACH_REPLY } from '../src/cortex';
import { FnCortex, apiEvents, makeApp, newSession } from './helpers';

const CARD = {
  tips: ['Keep the guard up.', 'Turn the hip on the cross.', 'Breathe out on every punch.'],
  drill: '3 x 2 min shadow boxing',
  badge: 'Speed Demon',
  summary: 'Great round, 120 points!',
};

describe('parseCoachCard', () => {
  it('parses a clean JSON object', () => {
    expect(parseCoachCard(JSON.stringify(CARD))).toEqual(CARD);
    expect(parseCoachCard(MOCK_COACH_REPLY)?.tips).toHaveLength(3);
  });

  it('strips code fences and surrounding prose', () => {
    const raw = 'Sure! Here is your card:\n```json\n' + JSON.stringify(CARD, null, 2) + '\n```\nGood luck!';
    expect(parseCoachCard(raw)).toEqual(CARD);
  });

  it('handles a double-encoded JSON string', () => {
    expect(parseCoachCard(JSON.stringify(JSON.stringify(CARD)))).toEqual(CARD);
  });

  it('accepts the card nested under "coach" or wrapped in an array', () => {
    expect(parseCoachCard(JSON.stringify({ coach: CARD }))).toEqual(CARD);
    expect(parseCoachCard(JSON.stringify([CARD]))).toEqual(CARD);
  });

  it('keeps exactly three tips and trims/limits text', () => {
    const card = parseCoachCard(
      JSON.stringify({ ...CARD, tips: ['  a  ', 'b', 'c', 'd'], badge: 'B'.repeat(100), summary: 'line1\nline2' }),
    );
    expect(card?.tips).toEqual(['a', 'b', 'c']);
    expect(card?.badge.length).toBeLessThanOrEqual(40);
    expect(card?.summary).toBe('line1 line2');
  });

  it.each([
    ['plain prose', 'You did great, keep it up!'],
    ['empty', ''],
    ['two tips', JSON.stringify({ ...CARD, tips: ['a', 'b'] })],
    ['tips not array', JSON.stringify({ ...CARD, tips: 'a, b, c' })],
    ['missing drill', JSON.stringify({ ...CARD, drill: undefined })],
    ['blank badge', JSON.stringify({ ...CARD, badge: '   ' })],
    ['truncated JSON', JSON.stringify(CARD).slice(0, 40)],
    ['array of numbers', JSON.stringify([1, 2, 3])],
    ['number', 42],
    ['null', null],
  ])('returns null for %s', (_label, raw) => {
    expect(parseCoachCard(raw)).toBeNull();
  });

  it('extractJsonObjects ignores braces inside strings', () => {
    expect(extractJsonObjects('x {"a":"}{"} y {"b":1}')).toEqual(['{"a":"}{"}', '{"b":1}']);
  });
});

describe('fallbackCard', () => {
  it('is a complete card mentioning the score', () => {
    const c = fallbackCard({ score: 120, total_punches: 30, avg_speed: 7.2, max_speed: 9, avg_reaction_ms: 250, best_reaction_ms: 200, accuracy: 0.7 });
    expect(c.tips).toEqual(FALLBACK_TIPS);
    expect(c.summary).toContain('120 points');
    expect(c.drill && c.badge).toBeTruthy();
  });
});

async function endWith(cortex: FnCortex, config = {}) {
  const t = makeApp({ cortex, config });
  const { playerId, sessionId } = await newSession(t.http);
  await t.http.post('/api/events').send(apiEvents(sessionId, playerId, [{}, { type: 'cross' }, { type: 'block' }]));
  const res = await t.http.post('/api/session/end').send({ session_id: sessionId });
  return { ...t, res, sessionId };
}

describe('session/end coach card failures -> fallback', () => {
  it('Cortex error -> fallback card with fallback:true, stored', async () => {
    const { res, repo, sessionId } = await endWith(new FnCortex(async () => Promise.reject(new Error('Cortex 500'))));
    expect(res.status).toBe(200);
    expect(res.body.fallback).toBe(true);
    expect(res.body.coach.tips).toEqual(FALLBACK_TIPS);
    expect(res.body.stats.score).toBe(22);
    expect(repo.sessions.get(sessionId)?.coach).toMatchObject({ fallback: true, model: 'fallback' });
  });

  it('Cortex timeout -> fallback within the coach timeout', async () => {
    const hang = new FnCortex(() => new Promise<string>(() => undefined));
    const t0 = Date.now();
    const { res } = await endWith(hang, { coachTimeoutMs: 150 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.status).toBe(200);
    expect(res.body.fallback).toBe(true);
    expect(res.body.coach.tips).toHaveLength(3);
  });

  it('Cortex bad JSON -> fallback', async () => {
    const { res } = await endWith(new FnCortex(async () => 'Great job! {tips: [oops'));
    expect(res.body.fallback).toBe(true);
    expect(res.body.coach.badge).toBe('Iron Will');
  });

  it('Cortex JSON with wrong shape -> fallback', async () => {
    const { res } = await endWith(new FnCortex(async () => JSON.stringify({ tips: ['only one'], drill: 'x', badge: 'y', summary: 'z' })));
    expect(res.body.fallback).toBe(true);
  });

  it('Cortex fenced JSON with prose -> parsed, fallback:false', async () => {
    const { res } = await endWith(new FnCortex(async () => 'Here you go:\n```json\n' + JSON.stringify(CARD) + '\n```'));
    expect(res.body.fallback).toBe(false);
    expect(res.body.coach).toEqual(CARD);
  });

  it('a stored fallback card is returned again (idempotent), Cortex not retried', async () => {
    const cortex = new FnCortex(async () => {
      throw new Error('down');
    });
    const { http, res, sessionId } = await endWith(cortex);
    const again = await http.post('/api/session/end').send({ session_id: sessionId }).expect(200);
    expect(again.body).toEqual(res.body);
    expect(again.body.fallback).toBe(true);
    expect(cortex.calls).toBe(1);
  });

  it('passes a coach-purpose prompt that demands JSON only', async () => {
    let seen = '';
    await endWith(
      new FnCortex(async (prompt, opts) => {
        expect(opts.purpose).toBe('coach');
        seen = prompt;
        return JSON.stringify(CARD);
      }),
    );
    expect(seen).toMatch(/ONLY one JSON object/);
    expect(seen).toContain('"tips"');
    expect(seen).toContain('"score":22');
  });
});
