import { METRICS, type Benchmark, type Percentiles, type PlayerMetrics } from './types';

/**
 * Percentile of `value` against a PRO_BENCHMARKS row (sql/CONTRACT.md):
 * piecewise-linear through (p25->25, p50->50, p75->75, p90->90); below p25 the first
 * segment's slope is extended toward 0, above p90 the last segment's slope is extended
 * toward 100; the result is clamped to [1, 99]; then flipped (100 - x) when the metric is
 * NOT higher_is_better. Returns an integer, or null when value/benchmark is unusable.
 */
export function percentileFor(value: number | null | undefined, bm: Benchmark | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || !bm) return null;
  const xs = [bm.p25, bm.p50, bm.p75, bm.p90];
  const ys = [25, 50, 75, 90];
  if (xs.some((x) => typeof x !== 'number' || !Number.isFinite(x))) return null;

  let pct: number;
  if (value < xs[0]!) {
    pct = 25 - (xs[0]! - value) * slope(xs[0]!, xs[1]!, 25, 50);
  } else if (value > xs[3]!) {
    pct = 90 + (value - xs[3]!) * slope(xs[2]!, xs[3]!, 75, 90);
  } else {
    pct = 50;
    for (let i = 0; i < 3; i++) {
      const x0 = xs[i]!;
      const x1 = xs[i + 1]!;
      if (value >= x0 && value <= x1) {
        pct = x1 === x0 ? ys[i + 1]! : ys[i]! + ((value - x0) / (x1 - x0)) * (ys[i + 1]! - ys[i]!);
        break;
      }
    }
  }
  pct = Math.min(99, Math.max(1, pct));
  if (!bm.higher_is_better) pct = 100 - pct;
  return Math.round(pct);
}

/** Percent-points per unit; a degenerate (flat) segment counts as a cliff (jump straight to the clamp). */
function slope(x0: number, x1: number, y0: number, y1: number): number {
  return x1 > x0 ? (y1 - y0) / (x1 - x0) : Number.POSITIVE_INFINITY;
}

/** All six contract metrics are always present (null when there is no data). */
export function computePercentiles(metrics: PlayerMetrics, benchmarks: Benchmark[]): Percentiles {
  const byMetric = new Map(benchmarks.map((b) => [b.metric, b]));
  const out = {} as Percentiles;
  for (const m of METRICS) out[m] = percentileFor(metrics[m], byMetric.get(m));
  return out;
}
