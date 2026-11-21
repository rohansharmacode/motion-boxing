import request from 'supertest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { MockCortex, type Cortex, type CompleteOptions } from '../src/cortex';
import { silentLogger } from '../src/logger';
import { MemoryRepo } from '../src/repo/memory';
import type { MotionEvent } from '../src/types';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({ SNOWFLAKE_MOCK: '1', LOG_LEVEL: 'silent' });
  return {
    ...base,
    coachTimeoutMs: 200,
    sessionEndFlushWaitMs: 1000,
    ...overrides,
    events: {
      ...base.events,
      ackWaitMs: 50,
      retryBaseMs: 5,
      retryMaxMs: 20,
      maxAttemptsBeforeDrop: 1000,
      ...(overrides.events ?? {}),
    },
  };
}

export interface TestApp extends AppHandle {
  repo: MemoryRepo;
  cortex: Cortex;
  http: ReturnType<typeof request>;
}

export function makeApp(opts: { repo?: MemoryRepo; cortex?: Cortex; config?: Partial<AppConfig> } = {}): TestApp {
  const repo = opts.repo ?? new MemoryRepo();
  const cortex = opts.cortex ?? new MockCortex();
  const handle = createApp({ repo, cortex, config: testConfig(opts.config), log: silentLogger });
  return { ...handle, repo, cortex, http: request(handle.app) };
}

/** MemoryRepo whose writes (and ping) fail while `down` is true. */
export class FlakyRepo extends MemoryRepo {
  down = true;
  insertCalls: { n: number; dedupe: boolean }[] = [];

  override async insertEvents(events: MotionEvent[], opts: { dedupe?: boolean } = {}): Promise<void> {
    this.insertCalls.push({ n: events.length, dedupe: Boolean(opts.dedupe) });
    if (this.down) throw new Error('simulated Snowflake outage');
    return super.insertEvents(events, opts);
  }

  override async ping(): Promise<boolean> {
    return !this.down;
  }
}

/** Cortex test double driven by a function. */
export class FnCortex implements Cortex {
  readonly model = 'test-model';
  calls = 0;
  constructor(private readonly fn: (prompt: string, opts: CompleteOptions) => Promise<string>) {}
  complete(prompt: string, opts: CompleteOptions): Promise<string> {
    this.calls++;
    return this.fn(prompt, opts);
  }
}

export interface EventSpec {
  type?: MotionEvent['event_type'];
  hand?: 'L' | 'R';
  speed?: number;
  accuracy?: number | null;
  reaction?: number | null;
  guard?: boolean | null;
  points?: number;
}

/** Build API event bodies for a session; one event every 500 ms from a fixed start. */
export function apiEvents(sessionId: string, playerId: string, specs: EventSpec[], startMs = Date.UTC(2026, 10, 21, 12, 0, 0)) {
  return specs.map((s, i) => {
    const type = s.type ?? 'jab';
    return {
      session_id: sessionId,
      player_id: playerId,
      sport: 'boxing',
      event_ts: new Date(startMs + i * 500).toISOString(),
      event_type: type,
      hand: s.hand ?? (i % 2 ? 'L' : 'R'),
      speed_mps: s.speed ?? (type === 'block' ? 0 : 8),
      accuracy: s.accuracy === undefined ? (type === 'block' ? null : 0.8) : s.accuracy,
      reaction_ms: s.reaction === undefined ? 250 : s.reaction,
      guard_up: s.guard === undefined ? true : s.guard,
      points: s.points ?? (type === 'block' ? 2 : 10),
    };
  });
}

/** Create a player + session through the API. */
export async function newSession(http: TestApp['http'], name = 'Tester') {
  const p = await http.post('/api/players').send({ name }).expect(201);
  const s = await http.post('/api/session/start').send({ player_id: p.body.player_id, sport: 'boxing' }).expect(201);
  return { playerId: p.body.player_id as string, sessionId: s.body.session_id as string };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor: condition not met in time');
}
