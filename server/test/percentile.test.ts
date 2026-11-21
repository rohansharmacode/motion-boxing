import { describe, expect, it } from 'vitest';
import { computePercentiles, percentileFor } from '../src/percentile';
import { DEFAULT_BENCHMARKS } from '../src/repo/memory';
import type { Benchmark } from '../src/types';

const SPEED: Benchmark = { sport: 'boxing', metric: 'punch_speed_mps', p25: 5.5, p50: 7, p75: 8.5, p90: 10, pro_avg: 9.5, higher_is_better: true };
const REACTION: Benchmark = { sport: 'boxing', metric: 'reaction_ms', p25: 210, p50: 250, p75: 300, p90: 360, pro_avg: 190, higher_is_better: false };

describe('percentileFor', () => {
  it('hits the anchor points exactly', () => {
    expect(percentileFor(5.5, SPEED)).toBe(25);
    expect(percentileFor(7, SPEED)).toBe(50);
    expect(percentileFor(8.5, SPEED)).toBe(75);
    expect(percentileFor(10, SPEED)).toBe(90);
  });

  it('interpolates linearly inside each segment', () => {
    expect(percentileFor(6.25, SPEED)).toBe(38); // 37.5
    expect(percentileFor(7.75, SPEED)).toBe(63); // 62.5
    expect(percentileFor(9.25, SPEED)).toBe(83); // 82.5
  });

  it('extrapolates beyond the ends with the edge slopes, clamped to [1, 99]', () => {
    // below p25: slope 25/1.5 per m/s -> 5.0 m/s = 25 - 8.33 = 16.7
    expect(percentileFor(5, SPEED)).toBe(17);
    // above p90: slope 15/1.5 per m/s -> 10.6 m/s = 96
    expect(percentileFor(10.6, SPEED)).toBe(96);
    expect(percentileFor(0, SPEED)).toBe(1);
    expect(percentileFor(50, SPEED)).toBe(99);
  });

  it('flips lower-is-better metrics (100 - x)', () => {
    expect(percentileFor(210, REACTION)).toBe(75);
    expect(percentileFor(250, REACTION)).toBe(50);
    expect(percentileFor(360, REACTION)).toBe(10);
    expect(percentileFor(100, REACTION)).toBe(99); // very fast -> clamp 1 -> flipped 99
    expect(percentileFor(2000, REACTION)).toBe(1);
  });

  it('returns null when there is no value or benchmark', () => {
    expect(percentileFor(null, SPEED)).toBeNull();
    expect(percentileFor(undefined, SPEED)).toBeNull();
    expect(percentileFor(Number.NaN, SPEED)).toBeNull();
    expect(percentileFor(7, undefined)).toBeNull();
  });

  it('copes with degenerate (flat) benchmark segments', () => {
    const flat: Benchmark = { ...SPEED, p25: 5, p50: 5, p75: 8, p90: 8 };
    expect(percentileFor(5, flat)).toBe(50); // p25 == p50 == value -> upper anchor
    expect(percentileFor(4, flat)).toBe(1);
    expect(percentileFor(9, flat)).toBe(99);
    expect(percentileFor(6.5, flat)).toBe(63);
  });
});

describe('computePercentiles', () => {
  it('always returns the six contract keys', () => {
    const p = computePercentiles(
      { punch_speed_mps: 8.5, reaction_ms: 300, accuracy_pct: 65, guard_pct: null, symmetry_pct: 93, fatigue_drop_pct: 3 },
      DEFAULT_BENCHMARKS,
    );
    expect(p).toEqual({
      punch_speed_mps: 75,
      reaction_ms: 25,
      accuracy_pct: 50,
      guard_pct: null,
      symmetry_pct: 90,
      fatigue_drop_pct: 75,
    });
  });

  it('nulls metrics without a benchmark row', () => {
    const p = computePercentiles(
      { punch_speed_mps: 8.5, reaction_ms: 300, accuracy_pct: 65, guard_pct: 70, symmetry_pct: 93, fatigue_drop_pct: 3 },
      [SPEED],
    );
    expect(p.punch_speed_mps).toBe(75);
    expect(p.reaction_ms).toBeNull();
    expect(Object.keys(p)).toHaveLength(6);
  });
});
