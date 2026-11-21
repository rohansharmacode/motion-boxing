// The front end's contract (src/api/CONTRACT.md): client-generated ids, {events:[...]} bodies,
// text/plain beacons, section-5 column names, and the richer /api/session/end request/response.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mapFrontendEvent, splitDrill } from '../src/frontend';
import { FnCortex, makeApp, type TestApp } from './helpers';

const apps: TestApp[] = [];
function app(opts: Parameters<typeof makeApp>[0] = {}): TestApp {
  const a = makeApp(opts);
  apps.push(a);
  return a;
}
afterEach(async () => {
  for (const a of apps.splice(0)) a.queue.stop();
});

function fe(sessionId: string, playerId: string, i: number, over: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    session_id: sessionId,
    player_id: playerId,
    sport: 'BOXING',
    event_ts: new Date(Date.UTC(2026, 10, 21, 14, 3, 0) + i * 500).toISOString(),
    round_ms: i * 500,
    event_type: 'PUNCH',
    peak_velocity: 20,
    reaction_ms: 300,
    accuracy_score: 80,
    symmetry_ratio: null,
    metrics: { punchType: i % 2 ? 'HOOK' : 'JAB', hand: i % 2 ? 'L' : 'R', landed: true },
    ...over,
  };
}

function endBody(sessionId: string, playerId: string, name = 'Naman') {
  return {
    session_id: sessionId,
    player_id: playerId,
    display_name: name,
    sport: 'BOXING',
    started_at: '2026-11-21T14:02:00.000Z',
    ended_at: '2026-11-21T14:02:40.000Z',
    final_score: 1840,
    result: 'KO_WIN',
    avg_inference_fps: 28.4,
    stats: { punches: 4, landed: 4 },
  };
}

describe('mapFrontendEvent', () => {
  const base = fe('s1', 'p1', 0);
  it('maps PUNCH + metrics.punchType to our columns (speed in m/s, accuracy 0..1, points)', () => {
    const row = mapFrontendEvent(base, 0.4)!;
    expect(row).toMatchObject({ event_id: base.event_id, event_type: 'jab', hand: 'R', speed_mps: 8, accuracy: 0.8, points: 18, sport: 'boxing' });
    expect(row.payload).toMatchObject({ source: 'frontend', peak_velocity: 20, accuracy_score: 80, round_ms: 0 });
  });
  it('uses metrics.points when sent, 0 for missed punches, 5 for blocks', () => {
    expect(mapFrontendEvent({ ...base, metrics: { punchType: 'CROSS', points: 42 } }, 0.4)!.points).toBe(42);
    expect(mapFrontendEvent({ ...base, metrics: { punchType: 'CROSS', landed: false } }, 0.4)!.points).toBe(0);
    const block = mapFrontendEvent({ ...base, event_type: 'BLOCK', metrics: {} }, 0.4)!;
    expect(block).toMatchObject({ event_type: 'block', points: 5, accuracy: null });
  });
  it('maps DODGE to slip/duck and ignores TICK (SAVE/GOAL/ARROW_RELEASE: test/multisport.test.ts)', () => {
    expect(mapFrontendEvent({ ...base, event_type: 'DODGE', metrics: { kind: 'duck' } }, 0.4)).toMatchObject({ event_type: 'duck', points: 5, accuracy: null });
    expect(mapFrontendEvent({ ...base, event_type: 'DODGE', metrics: { hand: 'R' } }, 0.4)).toMatchObject({ event_type: 'slip', hand: 'R' });
    expect(mapFrontendEvent({ ...base, event_type: 'TICK' }, 0.4)).toBeNull();
    expect(mapFrontendEvent({ ...base, event_type: 'SAVE' }, 0.4)).toMatchObject({ sport: 'goalkeeper', event_type: 'save' });
    expect(mapFrontendEvent({ ...base, event_type: 'GOAL' }, 0.4)).toMatchObject({ sport: 'goalkeeper', event_type: 'goal' });
  });
  it('splits "Name: description" drills', () => {
    expect(splitDrill('Guard-Return Jabs: 3 x 1 min')).toEqual({ name: 'Guard-Return Jabs', description: '3 x 1 min' });
    expect(splitDrill('3 x 1-minute rounds')).toEqual({ name: 'Coach Drill', description: '3 x 1-minute rounds' });
  });
});

describe('front-end flow', () => {
  it('accepts {events:[...]} without /api/players or /api/session/start, and creates the rows', async () => {
    const { http, repo } = app();
    const sid = randomUUID();
    const pid = randomUUID();
    const events = [0, 1, 2, 3].map((i) => fe(sid, pid, i)).concat([fe(sid, pid, 4, { event_type: 'TICK', metrics: {} })]);
    const res = await http.post('/api/events').send({ events });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: 4, ignored: 1, rejected: 0, duplicates: 0 });
    await new Promise((r) => setTimeout(r, 30));
    expect(repo.events.filter((e) => e.session_id === sid)).toHaveLength(4);
    expect(repo.sessions.get(sid)?.player_id).toBe(pid);
    expect(repo.players.has(pid)).toBe(true);
  });

  it('accepts text/plain beacons and skips resent event_ids', async () => {
    const { http, repo } = app();
    const sid = randomUUID();
    const pid = randomUUID();
    const events = [0, 1].map((i) => fe(sid, pid, i));
    const first = await http.post('/api/events').set('Content-Type', 'text/plain;charset=UTF-8').send(JSON.stringify({ events }));
    expect(first.status).toBe(202);
    const again = await http.post('/api/events').send({ events });
    expect(again.body).toMatchObject({ accepted: 0, duplicates: 2 });
    await new Promise((r) => setTimeout(r, 30));
    expect(repo.events.filter((e) => e.session_id === sid)).toHaveLength(2);
  });

  it('drops invalid events one by one instead of failing the batch', async () => {
    const { http } = app();
    const sid = randomUUID();
    const pid = randomUUID();
    const res = await http.post('/api/events').send({ events: [fe(sid, pid, 0), fe(sid, pid, 1, { event_ts: 'yesterday' })] });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: 1, rejected: 1 });
  });

  it('session/end returns the front-end coach card, leaderboard and form score', async () => {
    const { http, repo } = app();
    const sid = randomUUID();
    const pid = randomUUID();
    await http.post('/api/events').send({ events: [0, 1, 2, 3].map((i) => fe(sid, pid, i)) });
    const res = await http.post('/api/session/end').send(endBody(sid, pid));
    expect(res.status).toBe(200);
    const { coach, leaderboard, form_score, stats } = res.body;
    expect(coach.headline).toEqual(expect.any(String));
    expect(coach.tips).toHaveLength(3);
    expect(coach.drill).toEqual({ name: expect.any(String), description: expect.any(String) });
    expect(coach.badge).toEqual({ name: expect.any(String), description: expect.any(String) });
    expect(stats.total_punches).toBe(4);
    expect(leaderboard[0]).toMatchObject({ rank: 1, player_id: pid, display_name: 'Naman', sport: 'BOXING', score: stats.score });
    expect(form_score === null || (form_score >= 0 && form_score <= 100)).toBe(true);
    expect(repo.players.get(pid)?.name).toBe('Naman');
    expect(repo.sessions.get(sid)?.coach?.client).toMatchObject({ final_score: 1840, result: 'KO_WIN' });
  });

  it('session/end works even if no events arrived (creates player + session)', async () => {
    const { http, repo } = app();
    const sid = randomUUID();
    const pid = randomUUID();
    const res = await http.post('/api/session/end').send(endBody(sid, pid, 'Late Larry'));
    expect(res.status).toBe(200);
    expect(res.body.stats.total_punches).toBe(0);
    expect(repo.players.get(pid)?.name).toBe('Late Larry');
  });

  it('falls back to a structured card when Cortex fails', async () => {
    const { http } = app({ cortex: new FnCortex(async () => { throw new Error('cortex down'); }) });
    const res = await http.post('/api/session/end').send(endBody(randomUUID(), randomUUID()));
    expect(res.body.fallback).toBe(true);
    expect(res.body.coach.drill.name).toBe('Guard-Return Combos');
  });

  it("original API: Naman's serverAdapter payloads (client_event_id dedupe, SW/s speed, slip, text/plain bare array)", async () => {
    const { http, repo } = app();
    const p = await http.post('/api/players').send({ name: 'Adapter' });
    const s = await http.post('/api/session/start').send({ player_id: p.body.player_id, sport: 'boxing' });
    const sid = s.body.session_id;
    const pid = p.body.player_id;
    const ev = (i: number, over: Record<string, unknown> = {}) => ({
      session_id: sid, player_id: pid, sport: 'boxing', event_ts: new Date(Date.UTC(2026, 10, 21, 15, 0, i)).toISOString(),
      event_type: 'jab', hand: 'R', speed_mps: 20, accuracy: 0.8, reaction_ms: 300, guard_up: null, points: 18,
      payload: { client_event_id: randomUUID(), round_ms: i * 1000, speed_unit: 'SW/s' }, ...over,
    });
    const batch = [ev(0), ev(1), ev(2, { event_type: 'slip', points: 0 })];
    const first = await http.post('/api/events').send(batch);
    expect(first.status).toBe(202);
    expect(first.body.accepted).toBe(3);
    // the same batch again, as sendBeacon sends it (bare array, text/plain)
    const beacon = await http.post('/api/events').set('Content-Type', 'text/plain;charset=UTF-8').send(JSON.stringify(batch));
    expect(beacon.status).toBe(202);
    expect(beacon.body).toMatchObject({ accepted: 0, duplicates: 3 });
    await new Promise((r) => setTimeout(r, 30));
    const rows = repo.events.filter((e) => e.session_id === sid);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.event_id).toBe(batch[0]!.payload.client_event_id);
    expect(rows[0]!.speed_mps).toBe(8); // 20 shoulder-widths/s x 0.4 m
    expect(rows[0]!.payload).toMatchObject({ speed_sw_s: 20 });
    const end = await http.post('/api/session/end').send({ session_id: sid });
    expect(end.body.stats.total_punches).toBe(2); // the slip is stored but is not a punch
    expect(end.body.stats.max_speed).toBe(8);
  });

  it('keeps the original API unchanged (session_id-only end body still returns string drill)', async () => {
    const { http } = app();
    const p = await http.post('/api/players').send({ name: 'Legacy' });
    const s = await http.post('/api/session/start').send({ player_id: p.body.player_id });
    const res = await http.post('/api/session/end').send({ session_id: s.body.session_id });
    expect(res.status).toBe(200);
    expect(typeof res.body.coach.drill).toBe('string');
    expect(res.body.leaderboard).toBeUndefined();
  });
});
