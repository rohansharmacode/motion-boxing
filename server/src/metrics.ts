// JavaScript mirror of the SQL definitions in sql/analytics.sql (V_SESSION_STATS, PLAYER_FORM,
// V_LEADERBOARD). MemoryRepo uses these; SnowflakeRepo computes the same thing in SQL.
// Keep the two in sync:
//   * punch = jab|cross|hook|uppercut (blocks excluded); speeds/accuracy averaged over punches
//   * reaction_ms only counts when > 0
//   * score = SUM(points) over ALL events (blocks too)
//   * guard_pct = % of punches (with guard_up known) where guard_up is true
//   * symmetry_pct = mean(count symmetry, speed symmetry); one-handed = 0
//   * fatigue: per session, punches split into NTILE(4) by (event_ts, event_id); only sessions
//     with >= 8 punches; drop = 100 * (Q1 avg - Q4 avg) / Q1 avg over the pooled quartiles.

import {
  EVENT_TYPES,
  PUNCH_TYPES,
  type EventType,
  type MotionEvent,
  type PlayerMetrics,
  type SessionAggregate,
  type SessionStats,
} from './types';
import { mean, round } from './util';

export const MIN_PUNCHES_FOR_FATIGUE = 8;

export function isPunch(e: Pick<MotionEvent, 'event_type'>): boolean {
  return (PUNCH_TYPES as readonly string[]).includes(String(e.event_type).toLowerCase());
}

/** Bucket (1..n) per row, identical to SQL NTILE(n) over rows already in order. */
export function ntile(count: number, buckets: number): number[] {
  const out: number[] = [];
  const base = Math.floor(count / buckets);
  const extra = count % buckets;
  for (let b = 1; b <= buckets; b++) {
    const size = base + (b <= extra ? 1 : 0);
    for (let i = 0; i < size; i++) out.push(b);
  }
  return out;
}

function byTsThenId(a: MotionEvent, b: MotionEvent): number {
  const ta = Date.parse(a.event_ts);
  const tb = Date.parse(b.event_ts);
  if (ta !== tb) return ta - tb;
  return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
}

/** Q1 / Q4 punch speeds of one session, or null if it has too few punches. */
function sessionQuartileSpeeds(events: MotionEvent[]): { q1: number[]; q4: number[] } | null {
  const punches = events.filter((e) => isPunch(e) && e.speed_mps !== null && e.speed_mps !== undefined).sort(byTsThenId);
  if (punches.length < MIN_PUNCHES_FOR_FATIGUE) return null;
  const q = ntile(punches.length, 4);
  return {
    q1: punches.filter((_, i) => q[i] === 1).map((e) => e.speed_mps),
    q4: punches.filter((_, i) => q[i] === 4).map((e) => e.speed_mps),
  };
}

function fatigueFromPooled(q1: number[], q4: number[]): number | null {
  const a = mean(q1);
  const b = mean(q4);
  if (a === null || b === null || a <= 0) return null;
  return (100 * (a - b)) / a;
}

export function symmetryPct(punches: MotionEvent[]): number | null {
  const left = punches.filter((e) => String(e.hand).toUpperCase() === 'L');
  const right = punches.filter((e) => String(e.hand).toUpperCase() === 'R');
  if (left.length + right.length === 0) return null;
  const countSym = (100 * Math.min(left.length, right.length)) / Math.max(left.length, right.length);
  const ls = mean(left.map((e) => e.speed_mps));
  const rs = mean(right.map((e) => e.speed_mps));
  let speedSym: number;
  if (ls === null || rs === null) speedSym = 0;
  else if (Math.max(ls, rs) <= 0) speedSym = 100;
  else speedSym = (100 * Math.max(Math.min(ls, rs), 0)) / Math.max(ls, rs);
  return (countSym + speedSym) / 2;
}

function guardPct(punches: MotionEvent[]): number | null {
  const known = punches.filter((e) => e.guard_up !== null && e.guard_up !== undefined);
  return mean(known.map((e) => (e.guard_up ? 100 : 0)));
}

/** Rounding used for the API `stats` object (same as V_SESSION_STATS). */
export function roundStats(s: SessionStats): SessionStats {
  return {
    score: Math.round(s.score),
    total_punches: Math.round(s.total_punches),
    avg_speed: round(s.avg_speed, 2),
    max_speed: round(s.max_speed, 2),
    avg_reaction_ms: round(s.avg_reaction_ms, 1),
    best_reaction_ms: round(s.best_reaction_ms, 1),
    accuracy: round(s.accuracy, 3),
  };
}

export function emptyMix(): Record<EventType, number> {
  return Object.fromEntries(EVENT_TYPES.map((t) => [t, 0])) as Record<EventType, number>;
}

/** Per-session aggregate (V_SESSION_STATS + extras for the coach prompt). */
export function aggregateSession(events: MotionEvent[]): SessionAggregate {
  const punches = events.filter(isPunch);
  const reactions = events.map((e) => e.reaction_ms).filter((v): v is number => typeof v === 'number' && v > 0);
  const accuracies = punches.map((e) => e.accuracy).filter((v): v is number => typeof v === 'number');
  const speeds = punches.map((e) => e.speed_mps).filter((v) => typeof v === 'number');
  const quart = sessionQuartileSpeeds(events);
  const mix = emptyMix();
  for (const e of events) {
    const t = String(e.event_type).toLowerCase() as EventType;
    if (t in mix) mix[t] += 1;
  }
  const stats = roundStats({
    score: events.reduce((a, e) => a + (e.points ?? 0), 0),
    total_punches: punches.length,
    avg_speed: mean(speeds),
    max_speed: speeds.length ? Math.max(...speeds) : null,
    avg_reaction_ms: mean(reactions),
    best_reaction_ms: reactions.length ? Math.min(...reactions) : null,
    accuracy: mean(accuracies),
  });
  return {
    stats,
    extras: {
      guard_pct: round(guardPct(punches), 1),
      symmetry_pct: round(symmetryPct(punches), 1),
      fatigue_drop_pct: round(quart ? fatigueFromPooled(quart.q1, quart.q4) : null, 1),
      punch_mix: mix,
      total_events: events.length,
    },
  };
}

/** Per-player metrics (PLAYER_FORM columns, in PRO_BENCHMARKS units). */
export function aggregatePlayer(events: MotionEvent[]): PlayerMetrics {
  const boxing = events.filter((e) => String(e.sport ?? 'boxing').toLowerCase() === 'boxing');
  const punches = boxing.filter(isPunch);
  const reactions = boxing.map((e) => e.reaction_ms).filter((v): v is number => typeof v === 'number' && v > 0);
  const accuracies = punches.map((e) => e.accuracy).filter((v): v is number => typeof v === 'number');
  const bySession = new Map<string, MotionEvent[]>();
  for (const e of boxing) {
    const list = bySession.get(e.session_id) ?? [];
    list.push(e);
    bySession.set(e.session_id, list);
  }
  const q1: number[] = [];
  const q4: number[] = [];
  for (const evs of bySession.values()) {
    const q = sessionQuartileSpeeds(evs);
    if (q) {
      q1.push(...q.q1);
      q4.push(...q.q4);
    }
  }
  const acc = mean(accuracies);
  return {
    punch_speed_mps: round(mean(punches.map((e) => e.speed_mps)), 2),
    reaction_ms: round(mean(reactions), 1),
    accuracy_pct: round(acc === null ? null : acc * 100, 1),
    guard_pct: round(guardPct(punches), 1),
    symmetry_pct: round(symmetryPct(punches), 1),
    fatigue_drop_pct: round(fatigueFromPooled(q1, q4), 1),
  };
}

/** Metrics for a single session, used to give the coach prompt percentiles. */
export function sessionMetrics(agg: SessionAggregate): PlayerMetrics {
  return {
    punch_speed_mps: agg.stats.avg_speed,
    reaction_ms: agg.stats.avg_reaction_ms,
    accuracy_pct: agg.stats.accuracy === null ? null : round(agg.stats.accuracy * 100, 1),
    guard_pct: agg.extras.guard_pct,
    symmetry_pct: agg.extras.symmetry_pct,
    fatigue_drop_pct: agg.extras.fatigue_drop_pct,
  };
}
