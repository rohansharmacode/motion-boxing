import { describe, expect, it } from 'vitest';
import { EventQueue, QueueFullError } from '../src/eventQueue';
import { silentLogger } from '../src/logger';
import { MemoryRepo } from '../src/repo/memory';
import type { MotionEvent } from '../src/types';
import { FlakyRepo, apiEvents, makeApp, newSession, waitFor } from './helpers';

const QCFG = { chunkSize: 500, maxQueue: 1000, retryBaseMs: 5, retryMaxMs: 20, maxAttemptsBeforeDrop: 1000 };

function events(n: number, sessionId = 's1'): MotionEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    event_id: `${sessionId}-${i}-${Math.random()}`,
    session_id: sessionId,
    player_id: 'p1',
    sport: 'boxing',
    event_ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    event_type: 'jab',
    hand: 'L',
    speed_mps: 7,
    accuracy: 0.7,
    reaction_ms: 250,
    guard_up: true,
    points: 10,
    payload: null,
  }));
}

describe('EventQueue', () => {
  it('retries with backoff while the repo is down, then drains', async () => {
    const repo = new FlakyRepo();
    const q = new EventQueue(repo, QCFG, silentLogger);
    const done = q.enqueue(events(5));
    expect(q.depth).toBe(5);
    await waitFor(() => repo.insertCalls.length >= 3);
    expect(q.depth).toBe(5);
    expect(q.stats().consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(q.stats().lastError).toMatch(/outage/);

    repo.down = false;
    await expect(done).resolves.toBe('written');
    expect(q.depth).toBe(0);
    expect(repo.events).toHaveLength(5);
    expect(q.stats()).toMatchObject({ written: 5, dropped: 0, consecutiveFailures: 0, lastError: null });
    // first attempt is a plain INSERT, retries use the dedupe INSERT
    expect(repo.insertCalls[0]!.dedupe).toBe(false);
    expect(repo.insertCalls.slice(1).every((c) => c.dedupe)).toBe(true);
  });

  it('does not duplicate rows when a "failed" attempt actually committed', async () => {
    const repo = new MemoryRepo();
    let calls = 0;
    const orig = repo.insertEvents.bind(repo);
    repo.insertEvents = async (evs, opts) => {
      calls++;
      await orig(evs, opts);
      if (calls === 1) throw new Error('timeout after commit');
    };
    const q = new EventQueue(repo, QCFG, silentLogger);
    await q.enqueue(events(4));
    expect(calls).toBe(2);
    expect(repo.events).toHaveLength(4);
  });

  it('combines whole batches into chunks no larger than chunkSize', async () => {
    const repo = new FlakyRepo();
    const q = new EventQueue(repo, { ...QCFG, chunkSize: 4 }, silentLogger);
    const all = [q.enqueue(events(2, 'a')), q.enqueue(events(2, 'b')), q.enqueue(events(2, 'c'))];
    await waitFor(() => repo.insertCalls.length >= 2);
    repo.down = false;
    await Promise.all(all);
    expect(repo.events).toHaveLength(6);
    const successful = repo.insertCalls.slice(-2).map((c) => c.n);
    expect(successful).toEqual([2, 4]);
    expect(repo.insertCalls.every((c) => c.n <= 4)).toBe(true);
  });

  it('rejects new batches when the buffer is full', () => {
    const repo = new FlakyRepo();
    const q = new EventQueue(repo, { ...QCFG, maxQueue: 5 }, silentLogger);
    void q.enqueue(events(3));
    expect(() => q.enqueue(events(3))).toThrow(QueueFullError);
    q.stop();
  });

  it('drops a poison chunk only when Snowflake itself is reachable', async () => {
    const repo = new FlakyRepo();
    repo.down = false; // ping OK
    repo.insertEvents = async () => {
      throw new Error('Numeric value out of range');
    };
    const q = new EventQueue(repo, { ...QCFG, maxAttemptsBeforeDrop: 3 }, silentLogger);
    await expect(q.enqueue(events(2))).resolves.toBe('dropped');
    expect(q.stats()).toMatchObject({ dropped: 2, depth: 0 });
  });

  it('keeps retrying (never drops) while Snowflake is down', async () => {
    const repo = new FlakyRepo();
    const q = new EventQueue(repo, { ...QCFG, maxAttemptsBeforeDrop: 2 }, silentLogger);
    const done = q.enqueue(events(2));
    await waitFor(() => repo.insertCalls.length >= 6);
    expect(q.depth).toBe(2);
    repo.down = false;
    await expect(done).resolves.toBe('written');
  });

  it('waitForSession is bounded and session-scoped', async () => {
    const repo = new FlakyRepo();
    const q = new EventQueue(repo, QCFG, silentLogger);
    void q.enqueue(events(2, 'x'));
    expect(await q.waitForSession('other', 10)).toBe(true);
    expect(await q.waitForSession('x', 30)).toBe(false);
    repo.down = false;
    expect(await q.waitForSession('x', 1000)).toBe(true);
  });

  it('stop() keeps unwritten events buffered', async () => {
    const repo = new FlakyRepo();
    const q = new EventQueue(repo, QCFG, silentLogger);
    void q.enqueue(events(3));
    await waitFor(() => repo.insertCalls.length >= 1);
    q.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(q.depth).toBe(3);
  });
});

describe('POST /api/events with Snowflake down', () => {
  it('answers 202 queued:true, reports queueDepth, and drains when Snowflake returns', async () => {
    const repo = new FlakyRepo();
    const { http, queue } = makeApp({ repo });
    repo.down = false;
    const { playerId, sessionId } = await newSession(http);
    repo.down = true;

    const t0 = Date.now();
    const res = await http.post('/api/events').send(apiEvents(sessionId, playerId, [{}, {}, {}])).expect(202);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.body).toEqual({ accepted: 3, queued: true });

    const health = await http.get('/api/health').expect(200);
    expect(health.body.queueDepth).toBe(3);

    repo.down = false;
    await waitFor(() => queue.depth === 0);
    expect(repo.events).toHaveLength(3);
    expect((await http.get('/api/health')).body.queueDepth).toBe(0);
  });

  it('returns 503 queue_full when the buffer is exhausted', async () => {
    const repo = new FlakyRepo();
    const { http } = makeApp({ repo, config: { events: { maxQueue: 2 } as never } });
    repo.down = false;
    const { playerId, sessionId } = await newSession(http);
    repo.down = true;
    await http.post('/api/events').send(apiEvents(sessionId, playerId, [{}, {}])).expect(202);
    const res = await http.post('/api/events').send(apiEvents(sessionId, playerId, [{}])).expect(503);
    expect(res.body.error).toBe('queue_full');
  });

  it('session/end waits for that session\'s queued events before aggregating', async () => {
    const repo = new FlakyRepo();
    const { http } = makeApp({ repo, config: { sessionEndFlushWaitMs: 2000 } });
    repo.down = false;
    const { playerId, sessionId } = await newSession(http);
    repo.down = true;
    await http.post('/api/events').send(apiEvents(sessionId, playerId, [{}, {}, {}, {}])).expect(202);
    setTimeout(() => (repo.down = false), 100);
    const res = await http.post('/api/session/end').send({ session_id: sessionId }).expect(200);
    expect(res.body.stats.total_punches).toBe(4);
    expect(res.body.stats.score).toBe(40);
  });
});
