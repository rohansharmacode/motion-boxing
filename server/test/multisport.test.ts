// Goalkeeper + archery (sql/PLUS_CONTRACT.md "Multi-sport"): event mapping, session end,
// sport-aware coach card and per-sport leaderboard, in mock mode.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mapFrontendEvent } from '../src/frontend';
import { archerySummary, goalkeeperSummary } from '../src/multisport';
import { FnCortex, apiEvents, makeApp, newSession, type TestApp } from './helpers';

const apps: TestApp[] = [];
function app(opts: Parameters<typeof makeApp>[0] = {}): TestApp {
  const a = makeApp(opts);
  apps.push(a);
  return a;
}
afterEach(async () => {
  for (const a of apps.splice(0)) a.queue.stop();
});

const T0 = Date.UTC(2026, 10, 21, 15, 0, 0);

/** One goalkeeper event exactly as src/sports/goalkeeper/telemetry.ts dispatches it. */
function keeper(sid: string, pid: string, i: number, outcome: 'SAVE' | 'GOAL', zone: number, over: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    session_id: sid,
    player_id: pid,
    sport: 'GOALKEEPER',
    event_ts: new Date(T0 + i * 9000).toISOString(),
    round_ms: i * 9000,
    event_type: outcome,
    peak_velocity: 10,
    reaction_ms: 300,
    accuracy_score: 80,
    symmetry_ratio: 0.5,
    metrics: {
      kick: i,
      zone,
      row: Math.floor(zone / 3),
      col: zone % 3,
      part: outcome === 'SAVE' ? 'left' : null,
      punch: false,
      ballSpeed: 21.5,
      spin: 3.2,
      flightTime: 0.62,
      offTarget: false,
      source: 'mouse',
    },
    ...over,
  };
}

/** ARROW_RELEASE as the archery team is expected to send it (fields optional). */
function arrow(sid: string, pid: string, i: number, metrics: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    session_id: sid,
    player_id: pid,
    sport: 'ARCHERY',
    event_ts: new Date(T0 + i * 6000).toISOString(),
    round_ms: i * 6000,
    event_type: 'ARROW_RELEASE',
    peak_velocity: 5,
    reaction_ms: null,
    accuracy_score: null,
    symmetry_ratio: null,
    metrics,
    ...over,
  };
}

function endBody(sid: string, pid: string, sport: string, name: string, score: number) {
  return {
    session_id: sid,
    player_id: pid,
    display_name: name,
    sport,
    started_at: new Date(T0).toISOString(),
    ended_at: new Date(T0 + 50_000).toISOString(),
    final_score: score,
    result: score > 0 ? 'WIN' : 'LOSS',
    avg_inference_fps: null,
    stats: {},
  };
}

/** A 5-kick shootout: saves in zones 0, 4, 8; goals in zones 2 and 2 (weakest: top right). */
function shootout(sid: string, pid: string) {
  return [
    keeper(sid, pid, 0, 'SAVE', 0),
    keeper(sid, pid, 1, 'GOAL', 2, { reaction_ms: 520 }),
    keeper(sid, pid, 2, 'SAVE', 4, { metrics: { zone: 4, part: 'right', punch: true } }),
    keeper(sid, pid, 3, 'GOAL', 2, { reaction_ms: null }),
    keeper(sid, pid, 4, 'SAVE', 8, { metrics: { row: 2, col: 2, part: 'torso' } }),
  ];
}

describe('goalkeeper / archery event mapping', () => {
  it('maps SAVE to a goalkeeper save row (glove hand, m/s, accuracy 0..1, engine points, zone in payload)', () => {
    const e = keeper('s1', 'p1', 0, 'SAVE', 2, { metrics: { zone: 2, part: 'left', punch: true } });
    const row = mapFrontendEvent(e, 0.4)!;
    expect(row).toMatchObject({
      sport: 'goalkeeper',
      event_type: 'save',
      hand: 'L',
      speed_mps: 4,
      accuracy: 0.8,
      reaction_ms: 300,
      guard_up: null,
      // 1000 save + 250 (reaction < 450 ms) + 150 punch clearance + 80 / 2 accuracy
      points: 1440,
    });
    expect(row.payload).toMatchObject({ source: 'frontend', event_type: 'SAVE', zone: 2, peak_velocity: 10, metrics: { zone: 2, punch: true } });
  });

  it('maps GOAL to 0 points with no hand, zone from row/col when zone is missing', () => {
    const e = keeper('s1', 'p1', 1, 'GOAL', 0, { metrics: { row: 1, col: 2, part: null } });
    const row = mapFrontendEvent(e, 0.4)!;
    expect(row).toMatchObject({ sport: 'goalkeeper', event_type: 'goal', hand: null, points: 0 });
    expect(row.payload?.zone).toBe(5);
    expect(mapFrontendEvent(keeper('s1', 'p1', 2, 'SAVE', 0, { metrics: { points: 77 } }), 0.4)!.points).toBe(77);
  });

  it('maps ARROW_RELEASE to an archery arrow row and tolerates missing fields', () => {
    const full = mapFrontendEvent(arrow('s2', 'p2', 0, { ring: 9, dx: 0.04, dy: -0.02, rmsSway: 0.01, bowHand: 'left' }), 0.4)!;
    expect(full).toMatchObject({ sport: 'archery', event_type: 'arrow', hand: 'L', points: 9, accuracy: 0.9, speed_mps: 2 });
    expect(full.payload).toMatchObject({ ring: 9, dx: 0.04, dy: -0.02, metrics: { rmsSway: 0.01 } });
    const bare = mapFrontendEvent(arrow('s2', 'p2', 1, {}, { peak_velocity: null }), 0.4)!;
    expect(bare).toMatchObject({ sport: 'archery', event_type: 'arrow', hand: null, points: 0, accuracy: null, speed_mps: 0 });
    expect(bare.payload).toMatchObject({ ring: null, dx: null, dy: null });
    // A running total in metrics.score (> 10) is not mistaken for the ring; accuracy_score is used instead.
    const fromAcc = mapFrontendEvent(arrow('s2', 'p2', 2, { score: 37 }, { accuracy_score: 72 }), 0.4)!;
    expect(fromAcc).toMatchObject({ points: 7, accuracy: 0.72 });
  });

  it('summaries: save %, weakest zone, grouping', () => {
    const rows = shootout('s3', 'p3').map((e) => mapFrontendEvent(e, 0.4)!);
    const k = goalkeeperSummary(rows);
    expect(k).toMatchObject({ shots: 5, saves: 3, goals: 2, save_pct: 60, best_reaction_ms: 300, punch_clearances: 1 });
    expect(k.weakest_zone).toMatchObject({ zone: 2, label: 'top right', shots: 2, saves: 0 });
    const a = archerySummary(
      [
        { ring: 10, dx: 0, dy: 0 },
        { ring: 8, dx: 0.1, dy: 0 },
        { ring: 10, dx: 0, dy: 0.1 },
      ].map((m, i) => mapFrontendEvent(arrow('s4', 'p4', i, m), 0.4)!),
    );
    expect(a).toMatchObject({ arrows: 3, score: 28, best_points: 10, bullseyes: 2 });
    expect(a.grouping).toBeGreaterThan(0);
  });
});

describe('goalkeeper / archery sessions (front-end shape)', () => {
  it('stores goalkeeper events with sport goalkeeper and ends the session with a keeper coach card', async () => {
    const { http, repo } = app();
    const sid = randomUUID();
    const pid = randomUUID();
    const ev = await http.post('/api/events').send({ events: shootout(sid, pid) });
    expect(ev.status).toBe(202);
    expect(ev.body).toMatchObject({ accepted: 5, ignored: 0, rejected: 0 });

    const res = await http.post('/api/session/end').send(endBody(sid, pid, 'GOALKEEPER', 'Keeper Kim', 3000));
    expect(res.status).toBe(200);
    expect(repo.sessions.get(sid)?.sport).toBe('goalkeeper');
    expect(repo.events.filter((e) => e.session_id === sid).every((e) => e.sport === 'goalkeeper')).toBe(true);
    const { coach, leaderboard, stats } = res.body;
    expect(stats.score).toBe(1290 + 1440 + 1290);
    expect(coach.tips).toHaveLength(3);
    expect(coach.tips[0]).toContain('top right');
    expect(coach.summary).toContain('3 of 5 saved');
    expect(coach.badge.description).toContain('3 of 5 saved');
    expect(coach.grounding).toEqual({ source: 'fallback', drills: [] });
    expect(leaderboard[0]).toMatchObject({ rank: 1, player_id: pid, display_name: 'Keeper Kim', sport: 'GOALKEEPER', score: stats.score });
    // The stored card reads back the same way (GET /api/session/:id/coach).
    const poll = await http.get(`/api/session/${sid}/coach`);
    expect(poll.body.coach_card.badge.description).toContain('3 of 5 saved');
  });

  it('ends an archery session with an archery card', async () => {
    const { http } = app();
    const sid = randomUUID();
    const pid = randomUUID();
    const metrics = [
      { ring: 10, dx: 0, dy: 0 },
      { ring: 9, dx: 0.05, dy: 0.01 },
      { ring: 7, dx: 0.12, dy: -0.03 },
    ];
    await http.post('/api/events').send({ events: metrics.map((m, i) => arrow(sid, pid, i, m)) }).expect(202);
    const res = await http.post('/api/session/end').send(endBody(sid, pid, 'ARCHERY', 'Robin', 26));
    expect(res.status).toBe(200);
    expect(res.body.stats.score).toBe(26);
    expect(res.body.coach.summary).toContain('3 arrows');
    expect(res.body.leaderboard[0]).toMatchObject({ sport: 'ARCHERY', score: 26 });
  });

  it('the coach prompt is sport-aware; Cortex failure gives the keeper fallback card', async () => {
    const prompts: string[] = [];
    const ok = app({
      cortex: new FnCortex(async (p) => {
        prompts.push(p);
        return JSON.stringify({ tips: ['a', 'b', 'c'], drill: 'Corner Dive: 10 reps', badge: 'Wall', summary: 'Nice shootout.' });
      }),
    });
    const sid = randomUUID();
    const pid = randomUUID();
    await ok.http.post('/api/events').send({ events: shootout(sid, pid) });
    const res = await ok.http.post('/api/session/end').send(endBody(sid, pid, 'GOALKEEPER', 'K', 0));
    expect(res.body).toMatchObject({ fallback: false, coach: { drill: { name: 'Corner Dive' } } });
    expect(prompts[0]).toContain('goalkeeping coach');
    expect(prompts[0]).toContain('"save_pct":60');
    expect(prompts[0]).toContain('"weakest_zone":{"label":"top right"');
    expect(prompts[0]).not.toContain('boxing');

    const down = app({ cortex: new FnCortex(async () => { throw new Error('cortex down'); }) });
    const sid2 = randomUUID();
    await down.http.post('/api/events').send({ events: shootout(sid2, pid) });
    const fb = await down.http.post('/api/session/end').send(endBody(sid2, pid, 'GOALKEEPER', 'K', 0));
    expect(fb.body.fallback).toBe(true);
    expect(fb.body.coach.drill.name).toBe('Corner Reflex Ladder');
    expect(fb.body.coach.tips[0]).toContain('top right');
  });
});

describe('goalkeeper / archery (original API) and per-sport leaderboard', () => {
  it('session/start + events + session/end work with sport goalkeeper; the original response shape is unchanged', async () => {
    const { http, repo } = app();
    const p = await http.post('/api/players').send({ name: 'Orig Keeper' }).expect(201);
    const s = await http.post('/api/session/start').send({ player_id: p.body.player_id, sport: 'goalkeeper' }).expect(201);
    const sid = s.body.session_id as string;
    const base = { session_id: sid, player_id: p.body.player_id, sport: 'goalkeeper' };
    const events = [
      { ...base, event_ts: new Date(T0).toISOString(), event_type: 'save', hand: 'R', speed_mps: 9, accuracy: 0.6, reaction_ms: 400, points: 1280, payload: { zone: 3, part: 'right', speed_unit: 'SW/s' } },
      { ...base, event_ts: new Date(T0 + 9000).toISOString(), event_type: 'goal', hand: null, speed_mps: 2, accuracy: 0.2, reaction_ms: null, payload: { row: 0, col: 0 } },
    ];
    const ev = await http.post('/api/events').send(events);
    expect(ev.status).toBe(202);
    expect(ev.body.accepted).toBe(2);
    await new Promise((r) => setTimeout(r, 30));
    const rows = repo.events.filter((e) => e.session_id === sid);
    expect(rows.map((e) => [e.sport, e.event_type, e.hand, e.points, e.payload?.zone])).toEqual([
      ['goalkeeper', 'save', 'R', 1280, 3],
      ['goalkeeper', 'goal', null, 0, 0],
    ]);
    expect(rows[0]!.speed_mps).toBeCloseTo(3.6);

    const end = await http.post('/api/session/end').send({ session_id: sid });
    expect(end.status).toBe(200);
    expect(Object.keys(end.body).sort()).toEqual(['coach', 'fallback', 'session_id', 'stats']);
    expect(typeof end.body.coach.drill).toBe('string');
    expect(end.body.stats).toMatchObject({ score: 1280, total_punches: 0 });
    expect(repo.sessions.get(sid)?.sport).toBe('goalkeeper');
  });

  it('rejects event types that do not belong to the sport; boxing validation is unchanged', async () => {
    const { http } = app();
    const { playerId, sessionId } = await newSession(http);
    const bad = await http.post('/api/events').send([
      { session_id: sessionId, player_id: playerId, sport: 'goalkeeper', event_ts: new Date(T0).toISOString(), event_type: 'jab' },
    ]);
    expect(bad.status).toBe(400);
    const [ok] = apiEvents(sessionId, playerId, [{ type: 'jab' }]);
    const { hand: _hand, ...noHand } = ok!;
    expect((await http.post('/api/events').send([noHand])).status).toBe(400);
    const arrowOk = await http.post('/api/events').send([
      { session_id: sessionId, player_id: playerId, sport: 'ARCHERY', event_ts: new Date(T0).toISOString(), event_type: 'arrow_release', payload: { ring: 8 } },
    ]);
    expect(arrowOk.status).toBe(202);
    expect(arrowOk.body.accepted).toBe(1);
  });

  it('GET /api/leaderboard?sport= ranks each sport separately (default boxing, same row shape)', async () => {
    const { http } = app();
    // Boxing player.
    const box = await newSession(http, 'Boxer Bo');
    await http.post('/api/events').send(apiEvents(box.sessionId, box.playerId, [{}, {}, {}]));
    // Two keepers: one 3/5 shootout, one 1-save shootout.
    const k1 = randomUUID();
    await http.post('/api/events').send({ events: shootout(randomUUID(), k1) });
    await http.post('/api/session/end').send(endBody(randomUUID(), k1, 'GOALKEEPER', 'Keeper One', 0));
    const k2 = randomUUID();
    const s2 = randomUUID();
    await http.post('/api/events').send({ events: [keeper(s2, k2, 0, 'SAVE', 1), keeper(s2, k2, 1, 'GOAL', 7)] });
    await http.post('/api/session/end').send(endBody(s2, k2, 'GOALKEEPER', 'Keeper Two', 0));
    await new Promise((r) => setTimeout(r, 30));

    const boxing = (await http.get('/api/leaderboard').expect(200)).body;
    expect(boxing.map((r: { player_id: string }) => r.player_id)).toEqual([box.playerId]);
    expect((await http.get('/api/leaderboard?sport=boxing').expect(200)).body).toEqual(boxing);

    const keepers = (await http.get('/api/leaderboard?sport=GOALKEEPER').expect(200)).body;
    expect(keepers.map((r: { player_id: string; rank: number }) => [r.rank, r.player_id])).toEqual([
      [1, k1],
      [2, k2],
    ]);
    expect(Object.keys(keepers[0]).sort()).toEqual(Object.keys(boxing[0]).sort());
    expect(keepers[0]).toMatchObject({ sport: 'GOALKEEPER', score: 4020, best_reaction_ms: 300, fastest_punch: 4, max_speed: 4 });

    expect((await http.get('/api/leaderboard?sport=archery').expect(200)).body).toEqual([]);
    expect((await http.get('/api/leaderboard?sport=tennis')).status).toBe(400);
  });

  it('goalkeeper rows do not leak into boxing highlights or player metrics (mock mirrors the SQL filters)', async () => {
    const { http } = app();
    const pid = randomUUID();
    await http.post('/api/events').send({ events: shootout(randomUUID(), pid).map((e) => ({ ...e, reaction_ms: 120 })) });
    await new Promise((r) => setTimeout(r, 30));
    const hl = (await http.get('/api/highlights?limit=20').expect(200)).body;
    expect(hl.highlights.filter((h: { player_id: string }) => h.player_id === pid)).toEqual([]);
  });
});
