import { describe, expect, it } from 'vitest';
import { aggregatePlayer, aggregateSession, ntile, symmetryPct } from '../src/metrics';
import type { MotionEvent } from '../src/types';

function ev(i: number, over: Partial<MotionEvent> = {}): MotionEvent {
  return {
    event_id: `e${String(i).padStart(3, '0')}`,
    session_id: 's1',
    player_id: 'p1',
    sport: 'boxing',
    event_ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    event_type: 'jab',
    hand: 'L',
    speed_mps: 8,
    accuracy: 0.5,
    reaction_ms: 250,
    guard_up: true,
    points: 1,
    payload: null,
    ...over,
  };
}

describe('ntile', () => {
  it('matches SQL NTILE bucket sizes', () => {
    expect(ntile(10, 4)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 4, 4]);
    expect(ntile(8, 4)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(ntile(3, 4)).toEqual([1, 2, 3]);
    expect(ntile(0, 4)).toEqual([]);
  });
});

describe('aggregateSession', () => {
  it('fatigue needs >= 8 punches and ignores blocks', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ev(i, { speed_mps: 10 - i }));
    expect(aggregateSession(seven).extras.fatigue_drop_pct).toBeNull();

    // 8 punches (10..3 m/s) with blocks interleaved: Q1 = (10+9)/2 = 9.5, Q4 = (4+3)/2 = 3.5
    const eight = [
      ...Array.from({ length: 8 }, (_, i) => ev(i * 2, { speed_mps: 10 - i })),
      ...Array.from({ length: 4 }, (_, i) => ev(i * 2 + 1, { event_type: 'block', speed_mps: 0 })),
    ];
    const agg = aggregateSession(eight);
    expect(agg.extras.fatigue_drop_pct).toBe(63.2); // 100 * (9.5 - 3.5) / 9.5
    expect(agg.stats.total_punches).toBe(8);
    expect(agg.extras.punch_mix).toEqual({ jab: 8, cross: 0, hook: 0, uppercut: 0, block: 4 });
  });

  it('ignores reaction_ms <= 0 and null accuracy', () => {
    const agg = aggregateSession([ev(0, { reaction_ms: 0 }), ev(1, { reaction_ms: 300, accuracy: null }), ev(2, { reaction_ms: 200, accuracy: 1 })]);
    expect(agg.stats.avg_reaction_ms).toBe(250);
    expect(agg.stats.best_reaction_ms).toBe(200);
    expect(agg.stats.accuracy).toBe(0.75);
  });

  it('guard_pct counts punches with known guard state only', () => {
    const agg = aggregateSession([ev(0, { guard_up: true }), ev(1, { guard_up: false }), ev(2, { guard_up: null }), ev(3, { event_type: 'block', guard_up: false })]);
    expect(agg.extras.guard_pct).toBe(50);
  });
});

describe('symmetry', () => {
  it('one-handed = 0, balanced = 100, null without punches', () => {
    expect(symmetryPct([ev(0, { hand: 'L' }), ev(1, { hand: 'L' })])).toBe(0);
    expect(symmetryPct([ev(0, { hand: 'L', speed_mps: 6 }), ev(1, { hand: 'R', speed_mps: 6 })])).toBe(100);
    // counts 1:1 (100), speeds 6 vs 8 (75) -> 87.5
    expect(symmetryPct([ev(0, { hand: 'L', speed_mps: 6 }), ev(1, { hand: 'R', speed_mps: 8 })])).toBe(87.5);
    expect(symmetryPct([])).toBeNull();
  });
});

describe('aggregatePlayer', () => {
  it('pools quartiles across sessions (like PLAYER_FORM)', () => {
    const a = Array.from({ length: 8 }, (_, i) => ev(i, { session_id: 'a', speed_mps: 10 }));
    const b = Array.from({ length: 8 }, (_, i) => ev(i, { session_id: 'b', speed_mps: i < 4 ? 8 : 4 }));
    const small = Array.from({ length: 3 }, (_, i) => ev(i, { session_id: 'c', speed_mps: 1 })); // < 8 punches: ignored for fatigue
    const m = aggregatePlayer([...a, ...b, ...small]);
    // Q1 pooled = (10,10,8,8) = 9 ; Q4 pooled = (10,10,4,4) = 7 -> 22.2 %
    expect(m.fatigue_drop_pct).toBe(22.2);
    expect(m.accuracy_pct).toBe(50);
    expect(m.guard_pct).toBe(100);
  });
});
