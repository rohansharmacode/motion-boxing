import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_COACH_REPLY } from '../src/cortex';
import { FnCortex, apiEvents, makeApp, newSession, waitFor, type TestApp } from './helpers';

const apps: TestApp[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.queue.stop();
});
const slowCortex = (ms: number) => new FnCortex(() => new Promise((r) => setTimeout(() => r(MOCK_COACH_REPLY), ms)));

describe('coach card warming-up path (COACH_FAST_MS)', () => {
  it('answers fast with a provisional card, then serves the real Cortex card via /api/session/:id/coach', async () => {
    const a = makeApp({ cortex: slowCortex(300), config: { coachTimeoutMs: 3000, coachFastMs: 50 } });
    apps.push(a);
    const { playerId: player_id, sessionId: session_id } = await newSession(a.http);
    await a.http.post('/api/events').send(apiEvents(session_id, player_id, [{ type: 'jab' }, { type: 'cross' }]));
    const t = Date.now();
    const end = await a.http.post('/api/session/end').send({ session_id });
    expect(Date.now() - t).toBeLessThan(250);
    expect(end.body).toMatchObject({ warming_up: true, fallback: true });
    expect(end.body.coach.tips).toHaveLength(3);
    // a repeated end call does not start a second Cortex call
    expect((await a.http.post('/api/session/end').send({ session_id })).body.warming_up).toBe(true);
    expect((await a.http.get(`/api/session/${session_id}/coach`)).body).toMatchObject({ ready: false, warming_up: true });
    let body: any;
    await waitFor(async () => {
      body = (await a.http.get(`/api/session/${session_id}/coach`)).body;
      return body.ready === true;
    }, 3000, 25);
    expect(body.fallback).toBe(false);
    expect(body.coach.badge).toBe('Sharp Shooter');
    expect(body.coach_card.drill).toEqual({ name: expect.any(String), description: expect.any(String) });
    expect((a.cortex as FnCortex).calls).toBe(1);
    // later session/end calls now return the stored real card
    expect((await a.http.post('/api/session/end').send({ session_id })).body).toMatchObject({ fallback: false });
  });

  it('returns the real card directly when Cortex is faster than COACH_FAST_MS', async () => {
    const a = makeApp({ cortex: slowCortex(10), config: { coachTimeoutMs: 3000, coachFastMs: 500 } });
    apps.push(a);
    const { sessionId: session_id } = await newSession(a.http);
    const end = await a.http.post('/api/session/end').send({ session_id });
    expect(end.body.fallback).toBe(false);
    expect(end.body.warming_up).toBeUndefined();
  });

  it('coach status 404s for unknown sessions', async () => {
    const a = makeApp();
    apps.push(a);
    expect((await a.http.get('/api/session/nope-123/coach')).status).toBe(404);
  });
});
