import { describe, it, expect } from 'vitest';
import { generate, quartileSpeeds, SEED_TAG } from './generator';

const g = generate({ seed: 7 });
describe('generator', () => {
  it('produces 20 players x 3 sessions with 80-200 events', () => {
    expect(g.players).toHaveLength(20);
    expect(g.sessions).toHaveLength(60);
    for (const s of g.sessions) {
      expect(s.events.length).toBeGreaterThanOrEqual(80);
      expect(s.events.length).toBeLessThanOrEqual(200);
    }
    expect(g.players.every((p) => p.name.endsWith(SEED_TAG))).toBe(true);
  });
  it('is deterministic per seed and differs across seeds', () => {
    expect(JSON.stringify(generate({ seed: 7 }))).toBe(JSON.stringify(g));
    expect(JSON.stringify(generate({ seed: 8 }))).not.toBe(JSON.stringify(g));
  });
  it('has valid ranges, ascending timestamps and sane durations', () => {
    for (const s of g.sessions) {
      const dur = Date.parse(s.events.at(-1)!.event_ts) - Date.parse(s.started_at);
      expect(dur).toBeGreaterThan(55_000);
      expect(dur).toBeLessThan(125_000);
      let prev = -1;
      for (const e of s.events) {
        const t = Date.parse(e.event_ts);
        expect(t).toBeGreaterThan(prev);
        prev = t;
        expect(['L', 'R']).toContain(e.hand);
        if (e.event_type === 'block') {
          expect(e.speed_mps).toBe(0);
          expect(e.accuracy).toBeNull();
        } else {
          expect(e.speed_mps).toBeGreaterThanOrEqual(4);
          expect(e.speed_mps).toBeLessThanOrEqual(12);
          expect(e.accuracy!).toBeGreaterThanOrEqual(0);
          expect(e.accuracy!).toBeLessThanOrEqual(1);
          expect(e.points).toBeGreaterThan(0);
        }
        if (e.reaction_ms != null) expect(e.reaction_ms).toBeGreaterThanOrEqual(150);
      }
      expect(s.stats.score).toBe(s.events.reduce((a, e) => a + e.points, 0));
    }
  });
  it('mixes event types, jab faster than uppercut on average', () => {
    const all = g.sessions.flatMap((s) => s.events);
    const avg = (t: string) => { const x = all.filter((e) => e.event_type === t); return x.reduce((a, e) => a + e.speed_mps, 0) / x.length; };
    for (const t of ['jab', 'cross', 'hook', 'uppercut', 'block']) expect(all.some((e) => e.event_type === t)).toBe(true);
    expect(avg('jab')).toBeGreaterThan(avg('uppercut'));
  });
  it('shows fatigue: Q4 slower than Q1 on average by roughly 3-20%', () => {
    const drops = g.sessions.map((s) => { const q = quartileSpeeds(s.events); return (q[0] - q[3]) / q[0]; });
    const mean = drops.reduce((a, b) => a + b, 0) / drops.length;
    expect(mean).toBeGreaterThan(0.03);
    expect(mean).toBeLessThan(0.2);
  });
  it('some players improve across sessions', () => {
    const imp = g.players.filter((p) => p.improving);
    expect(imp.length).toBeGreaterThan(0);
    let better = 0;
    for (const p of imp) {
      const ss = g.sessions.filter((s) => s.player_id === p.player_id);
      if (ss[2].stats.avg_speed > ss[0].stats.avg_speed) better++;
    }
    expect(better).toBeGreaterThanOrEqual(Math.ceil(imp.length / 2));
  });
});
