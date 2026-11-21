import { describe, expect, it } from 'vitest';
import { MockCortex } from '../src/cortex';
import { apiEvents, makeApp, newSession } from './helpers';

const ROUND = [
  { type: 'jab', hand: 'L', speed: 6, accuracy: 0.5, reaction: 200, guard: true, points: 10 },
  { type: 'cross', hand: 'R', speed: 8, accuracy: 0.9, reaction: 300, guard: false, points: 20 },
  { type: 'hook', hand: 'L', speed: 10, accuracy: 1.0, reaction: null, guard: true, points: 30 },
  { type: 'block', hand: 'R', speed: 0, accuracy: null, reaction: 150, guard: true, points: 5 },
] as const;

describe('GET /api/health', () => {
  it('reports mock mode and queue depth', async () => {
    const { http } = makeApp();
    const res = await http.get('/api/health').expect(200);
    expect(res.body).toEqual({ ok: true, mode: 'mock', snowflake: 'mock', queueDepth: 0 });
  });
});

describe('POST /api/players', () => {
  it('creates a player', async () => {
    const { http, repo } = makeApp();
    const res = await http.post('/api/players').send({ name: '  Ada  ' }).expect(201);
    expect(res.body).toEqual({ player_id: expect.any(String) });
    expect(repo.players.get(res.body.player_id)?.name).toBe('Ada');
  });

  it.each([[{}], [{ name: '' }], [{ name: 'x'.repeat(51) }], [{ name: 42 }], [[]]])('rejects %j with 400', async (body) => {
    const { http } = makeApp();
    const res = await http.post('/api/players').send(body).expect(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.details?.length).toBeGreaterThan(0);
  });

  it('rejects malformed JSON with 400 invalid_json', async () => {
    const { http } = makeApp();
    const res = await http.post('/api/players').set('content-type', 'application/json').send('{"name":').expect(400);
    expect(res.body).toEqual({ error: 'invalid_json', message: expect.any(String) });
  });
});

describe('POST /api/session/start', () => {
  it('starts a session for a known player', async () => {
    const { http, repo } = makeApp();
    const { playerId, sessionId } = await newSession(http);
    expect(repo.sessions.get(sessionId)).toMatchObject({ player_id: playerId, sport: 'boxing', ended_at: null });
  });

  it('defaults sport to boxing', async () => {
    const { http } = makeApp();
    const p = await http.post('/api/players').send({ name: 'A' });
    await http.post('/api/session/start').send({ player_id: p.body.player_id }).expect(201);
  });

  it('404s for an unknown player and 400s for a bad body', async () => {
    const { http } = makeApp();
    const r1 = await http.post('/api/session/start').send({ player_id: 'nope', sport: 'boxing' }).expect(404);
    expect(r1.body.error).toBe('player_not_found');
    const p = await http.post('/api/players').send({ name: 'A' });
    await http.post('/api/session/start').send({ player_id: p.body.player_id, sport: 'tennis' }).expect(400);
    await http.post('/api/session/start').send({ player_id: "x'; DROP TABLE PLAYERS" }).expect(400);
  });
});

describe('POST /api/events', () => {
  it('accepts a batch with 202 and writes it', async () => {
    const { http, repo } = makeApp();
    const { playerId, sessionId } = await newSession(http);
    const res = await http.post('/api/events').send(apiEvents(sessionId, playerId, [...ROUND])).expect(202);
    expect(res.body).toEqual({ accepted: 4, queued: false });
    expect(repo.events).toHaveLength(4);
    expect(new Set(repo.events.map((e) => e.event_id)).size).toBe(4);
    expect(repo.events[3]).toMatchObject({ event_type: 'block', accuracy: null, points: 5 });
  });

  it('defaults optional fields', async () => {
    const { http, repo } = makeApp();
    const { playerId, sessionId } = await newSession(http);
    await http
      .post('/api/events')
      .send([{ session_id: sessionId, player_id: playerId, event_ts: '2026-11-21T12:00:00+01:00', event_type: 'jab', hand: 'L', speed_mps: 7 }])
      .expect(202);
    expect(repo.events[0]).toMatchObject({
      sport: 'boxing',
      accuracy: null,
      reaction_ms: null,
      guard_up: null,
      points: 0,
      event_ts: '2026-11-21T11:00:00.000Z',
    });
  });

  it('rejects a non-array body', async () => {
    const { http } = makeApp();
    const res = await http.post('/api/events').send({ not: 'an array' }).expect(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('rejects invalid events with the failing path', async () => {
    const { http, repo } = makeApp();
    const { playerId, sessionId } = await newSession(http);
    const batch = apiEvents(sessionId, playerId, [{}, {}]) as Record<string, unknown>[];
    batch[1]!.event_type = 'kick';
    batch[0]!.event_ts = 'yesterday';
    const res = await http.post('/api/events').send(batch).expect(400);
    const paths = res.body.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['0.event_ts', '1.event_type']));
    expect(repo.events).toHaveLength(0);
  });

  it('caps the batch size with 413', async () => {
    const { http } = makeApp({ config: { events: { maxBatch: 3 } as never } });
    const { playerId, sessionId } = await newSession(http);
    const res = await http.post('/api/events').send(apiEvents(sessionId, playerId, [{}, {}, {}, {}])).expect(413);
    expect(res.body.error).toBe('batch_too_large');
  });

  it('accepts an empty batch', async () => {
    const { http } = makeApp();
    const res = await http.post('/api/events').send([]).expect(202);
    expect(res.body).toEqual({ accepted: 0, queued: false });
  });
});

describe('POST /api/session/end', () => {
  it('aggregates the round, returns a coach card and stores it', async () => {
    const cortex = new MockCortex();
    const { http, repo } = makeApp({ cortex });
    const { playerId, sessionId } = await newSession(http);
    await http.post('/api/events').send(apiEvents(sessionId, playerId, [...ROUND])).expect(202);

    const res = await http.post('/api/session/end').send({ session_id: sessionId }).expect(200);
    expect(res.body).toEqual({
      session_id: sessionId,
      stats: {
        score: 65, // blocks score too
        total_punches: 3, // blocks excluded
        avg_speed: 8,
        max_speed: 10,
        avg_reaction_ms: 216.7, // only reaction_ms > 0
        best_reaction_ms: 150,
        accuracy: 0.8, // 0..1 mean over punches
      },
      coach: {
        tips: [expect.any(String), expect.any(String), expect.any(String)],
        drill: expect.any(String),
        badge: expect.any(String),
        summary: expect.any(String),
      },
      fallback: false,
    });
    const stored = repo.sessions.get(sessionId)!;
    expect(stored.ended_at).not.toBeNull();
    expect(stored.stats?.score).toBe(65);
    expect(stored.coach).toMatchObject({ ...res.body.coach, fallback: false, model: 'mock' });
    expect(cortex.calls).toHaveLength(1);
    expect(cortex.calls[0]!.prompt).toContain('"total_punches":3');
    expect(cortex.calls[0]!.prompt).toContain('PERCENTILES');
  });

  it('is idempotent: a second call returns the stored result without calling Cortex', async () => {
    const cortex = new MockCortex();
    const { http } = makeApp({ cortex });
    const { playerId, sessionId } = await newSession(http);
    await http.post('/api/events').send(apiEvents(sessionId, playerId, [...ROUND]));
    const a = await http.post('/api/session/end').send({ session_id: sessionId }).expect(200);
    // more events arriving late must not change the stored result
    await http.post('/api/events').send(apiEvents(sessionId, playerId, [{ points: 999 }]));
    const b = await http.post('/api/session/end').send({ session_id: sessionId }).expect(200);
    expect(b.body).toEqual(a.body);
    expect(cortex.calls).toHaveLength(1);
  });

  it('shares one computation between concurrent calls', async () => {
    const cortex = new MockCortex();
    const { http } = makeApp({ cortex });
    const { playerId, sessionId } = await newSession(http);
    await http.post('/api/events').send(apiEvents(sessionId, playerId, [...ROUND]));
    const [a, b] = await Promise.all([
      http.post('/api/session/end').send({ session_id: sessionId }),
      http.post('/api/session/end').send({ session_id: sessionId }),
    ]);
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(cortex.calls).toHaveLength(1);
  });

  it('never returns a malformed stored card', async () => {
    const cortex = new MockCortex();
    const { http, repo } = makeApp({ cortex });
    const { sessionId } = await newSession(http);
    const s = repo.sessions.get(sessionId)!;
    s.stats = { score: 5, total_punches: 1, avg_speed: 7, max_speed: 7, avg_reaction_ms: null, best_reaction_ms: null, accuracy: 0.5 };
    s.coach = { tips: ['only one'] } as never;
    const res = await http.post('/api/session/end').send({ session_id: sessionId }).expect(200);
    expect(res.body.fallback).toBe(true);
    expect(res.body.coach.tips).toHaveLength(3);
    expect(res.body.stats.score).toBe(5);
    expect(cortex.calls).toHaveLength(0);
  });

  it('handles a round with no events', async () => {
    const { http } = makeApp();
    const { sessionId } = await newSession(http);
    const res = await http.post('/api/session/end').send({ session_id: sessionId }).expect(200);
    expect(res.body.stats).toEqual({
      score: 0,
      total_punches: 0,
      avg_speed: null,
      max_speed: null,
      avg_reaction_ms: null,
      best_reaction_ms: null,
      accuracy: null,
    });
    expect(res.body.coach.tips).toHaveLength(3);
  });

  it('404s for an unknown session and 400s for a bad body', async () => {
    const { http } = makeApp();
    expect((await http.post('/api/session/end').send({ session_id: 'missing' }).expect(404)).body.error).toBe('session_not_found');
    await http.post('/api/session/end').send({}).expect(400);
  });
});

describe('GET /api/leaderboard', () => {
  it('returns at most 10 rows ranked by best session score', async () => {
    const { http } = makeApp();
    for (let i = 0; i < 12; i++) {
      const { playerId, sessionId } = await newSession(http, `P${i}`);
      await http.post('/api/events').send(apiEvents(sessionId, playerId, [{ points: 10 * (i + 1), speed: 5 + i * 0.1 }]));
    }
    const res = await http.get('/api/leaderboard').expect(200);
    expect(res.body).toHaveLength(10);
    expect(res.body.map((r: { rank: number }) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(res.body[0]).toEqual({
      rank: 1,
      player_id: expect.any(String),
      name: 'P11',
      score: 120,
      fastest_punch: 6.1,
      best_reaction_ms: 250,
      // aliases for the front end (src/api/types.ts LeaderboardEntry)
      display_name: 'P11',
      sport: 'BOXING',
      max_speed: 6.1,
    });
    const scores = res.body.map((r: { score: number }) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('uses the best single session, not the total', async () => {
    const { http } = makeApp();
    const { playerId, sessionId } = await newSession(http, 'A');
    await http.post('/api/events').send(apiEvents(sessionId, playerId, [{ points: 40 }]));
    const s2 = await http.post('/api/session/start').send({ player_id: playerId });
    await http.post('/api/events').send(apiEvents(s2.body.session_id, playerId, [{ points: 30 }]));
    const res = await http.get('/api/leaderboard').expect(200);
    expect(res.body[0].score).toBe(40);
  });
});

describe('GET /api/player/:id/stats', () => {
  it('returns history and percentiles vs PRO_BENCHMARKS', async () => {
    const { http } = makeApp();
    const { playerId, sessionId } = await newSession(http, 'Ada');
    await http.post('/api/events').send(apiEvents(sessionId, playerId, [...ROUND]));
    await http.post('/api/session/end').send({ session_id: sessionId }).expect(200);

    const res = await http.get(`/api/player/${playerId}/stats`).expect(200);
    expect(res.body.player).toEqual({ player_id: playerId, name: 'Ada' });
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0]).toMatchObject({ session_id: sessionId, score: 65, total_punches: 3, badge: expect.any(String) });
    expect(res.body.sessions[0].started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // speed 8 m/s -> between p50 7 and p75 8.5 -> 66.7; reaction 216.7 ms -> 29.2 flipped -> 71;
    // accuracy 80% -> 84; guard 66.7% -> 53; symmetry (50+100)/2=75 -> 37.5 -> 38; fatigue n/a (<8 punches)
    expect(res.body.percentiles).toEqual({
      punch_speed_mps: 67,
      reaction_ms: 71,
      accuracy_pct: 84,
      guard_pct: 53,
      symmetry_pct: 38,
      fatigue_drop_pct: null,
    });
  });

  it('returns all six percentile keys (null) for a player with no events', async () => {
    const { http } = makeApp();
    const p = await http.post('/api/players').send({ name: 'New' });
    const res = await http.get(`/api/player/${p.body.player_id}/stats`).expect(200);
    expect(Object.keys(res.body.percentiles).sort()).toEqual(
      ['accuracy_pct', 'fatigue_drop_pct', 'guard_pct', 'punch_speed_mps', 'reaction_ms', 'symmetry_pct'],
    );
    expect(res.body.sessions).toEqual([]);
  });

  it('404s for unknown players and 400s for malformed ids', async () => {
    const { http } = makeApp();
    await http.get('/api/player/unknown-id/stats').expect(404);
    await http.get(`/api/player/${encodeURIComponent("1' OR '1'='1")}/stats`).expect(400);
  });
});

describe('misc', () => {
  it('returns JSON 404 for unknown routes', async () => {
    const { http } = makeApp();
    const res = await http.get('/api/nope').expect(404);
    expect(res.body.error).toBe('not_found');
  });

  it('allows CORS only from the configured origin', async () => {
    const { http } = makeApp();
    const ok = await http.get('/api/health').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const bad = await http.get('/api/health').set('Origin', 'http://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});
