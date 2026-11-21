// JavaScript mirror of sql/pipelines.sql (V_PLAYER_STYLE, V_STYLE_TWINS, SESSION_SUMMARY,
// PLAYER_PROGRESS, T_HIGHLIGHTS). MemoryRepo uses these; SnowflakeRepo reads the real objects.

import { isPunch } from './metrics';
import {
  STYLE_COMPONENTS,
  type Benchmark,
  type Highlight,
  type HighlightKind,
  type MotionEvent,
  type PlayerMetrics,
  type ProgressPoint,
  type StyleComponents,
} from './types';
import { mean, round } from './util';

function comp(v: number | null | undefined, f: (x: number) => number): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return 50;
  return Math.min(100, Math.max(0, f(v)));
}

/** Same formulas as PLAYER_FORM.form_score components; NULL -> 50 (neutral). */
export function styleComponents(m: Partial<PlayerMetrics>): StyleComponents {
  return {
    speed: comp(m.punch_speed_mps, (x) => (x / 10) * 100),
    reaction: comp(m.reaction_ms, (x) => ((500 - x) / 320) * 100),
    accuracy: comp(m.accuracy_pct, (x) => x),
    guard: comp(m.guard_pct, (x) => x),
    symmetry: comp(m.symmetry_pct, (x) => x),
    endurance: comp(m.fatigue_drop_pct, (x) => 100 - 2 * x),
  };
}

export function roundComponents(c: StyleComponents): StyleComponents {
  return Object.fromEntries(STYLE_COMPONENTS.map((k) => [k, round(c[k], 1) ?? 50])) as StyleComponents;
}

/** Centred vector: c / 100 - 0.5 per component, in contract order. */
export function styleVector(c: StyleComponents): number[] {
  return STYLE_COMPONENTS.map((k) => c[k] / 100 - 0.5);
}

/** Cosine similarity, or null when either vector is all zeros (undefined in SQL too). */
export function cosine(a: number[], b: number[]): number | null {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return null;
  return dot / Math.sqrt(na * nb);
}

export const similarityPct = (sim: number) => round(50 * (sim + 1), 1) ?? 50;

/** Pro components from PRO_BENCHMARKS.pro_avg, same formulas. */
export function proComponents(benchmarks: Benchmark[]): StyleComponents {
  const pro = (metric: string) => benchmarks.find((b) => b.metric.toLowerCase() === metric)?.pro_avg ?? null;
  return styleComponents({
    punch_speed_mps: pro('punch_speed_mps'),
    reaction_ms: pro('reaction_ms'),
    accuracy_pct: pro('accuracy_pct'),
    guard_pct: pro('guard_pct'),
    symmetry_pct: pro('symmetry_pct'),
    fatigue_drop_pct: pro('fatigue_drop_pct'),
  });
}

/** Mock stand-in for the AI_CLASSIFY label written by T_SCOUTING. */
export function classifyStyle(c: StyleComponents): string {
  if (c.reaction >= 70 && c.accuracy >= 60) return 'Counter-puncher';
  if (c.speed >= 70 && c.guard >= 60) return 'Boxer-puncher';
  if (c.endurance >= 70 && c.speed >= 55) return 'Swarmer';
  if (c.accuracy >= 65 && c.guard >= 60) return 'Out-boxer';
  return 'Slugger';
}

/** Mock stand-in for the AI_COMPLETE scouting report: strongest and weakest component. */
export function scoutingReport(name: string, style: string, c: StyleComponents): string {
  const sorted = [...STYLE_COMPONENTS].sort((a, b) => c[b] - c[a]);
  const best = sorted[0]!;
  const worst = sorted[sorted.length - 1]!;
  return `${name} fights like a ${style.toLowerCase()}: ${best} is the standout (${Math.round(c[best])}/100). ` +
    `Opponents should test the ${worst} (${Math.round(c[worst])}/100).`;
}

/** REGR_SLOPE(y, x): least squares over pairs where both are non-null; null with < 2 pairs or constant x. */
export function regrSlope(points: { x: number; y: number | null }[]): number | null {
  const p = points.filter((q): q is { x: number; y: number } => q.y !== null && Number.isFinite(q.y));
  if (p.length < 2) return null;
  const mx = p.reduce((a, q) => a + q.x, 0) / p.length;
  const my = p.reduce((a, q) => a + q.y, 0) / p.length;
  let sxx = 0;
  let sxy = 0;
  for (const q of p) {
    sxx += (q.x - mx) ** 2;
    sxy += (q.x - mx) * (q.y - my);
  }
  return sxx === 0 ? null : sxy / sxx;
}

export interface SessionSummaryRow extends ProgressPoint {
  player_id: string;
  session_start_ts: string;
  punches: number;
  avg_reaction_ms: number | null;
}

/** SESSION_SUMMARY for one player: sessions with events, numbered by start time. */
export function sessionSummaries(events: MotionEvent[], startedAt: (sessionId: string) => string | null): SessionSummaryRow[] {
  const bySession = new Map<string, MotionEvent[]>();
  for (const e of events) {
    if (String(e.sport ?? 'boxing').toLowerCase() !== 'boxing') continue;
    const list = bySession.get(e.session_id) ?? [];
    list.push(e);
    bySession.set(e.session_id, list);
  }
  const rows = [...bySession.entries()].map(([session_id, evs]) => {
    const punches = evs.filter(isPunch);
    const first = evs.map((e) => e.event_ts).sort()[0]!;
    const acc = mean(punches.map((e) => e.accuracy).filter((v): v is number => typeof v === 'number'));
    return {
      player_id: evs[0]!.player_id,
      session_id,
      session_start_ts: startedAt(session_id) ?? first,
      session_index: 0,
      score: evs.reduce((a, e) => a + (e.points ?? 0), 0),
      punches: punches.length,
      avg_speed: round(mean(punches.map((e) => e.speed_mps)), 2),
      accuracy_pct: round(acc === null ? null : acc * 100, 1),
      avg_reaction_ms: round(mean(evs.map((e) => e.reaction_ms).filter((v): v is number => typeof v === 'number' && v > 0)), 1),
    };
  });
  rows.sort((a, b) => a.session_start_ts.localeCompare(b.session_start_ts) || (a.session_id < b.session_id ? -1 : 1));
  rows.forEach((r, i) => (r.session_index = i + 1));
  return rows;
}

const MILESTONES = [100, 500, 1000, 5000];
const MAX_REAL_SPEED = 20;

function highlightMessage(kind: HighlightKind, name: string, value: number): string {
  switch (kind) {
    case 'speed_record':
      return `New fastest punch: ${value.toFixed(1)} m/s by ${name}`;
    case 'reaction_record':
      return `New fastest reaction: ${Math.round(value)} ms by ${name}`;
    case 'personal_best_speed':
      return `Personal best: ${name} hit ${value.toFixed(1)} m/s`;
    case 'punch_milestone':
      return `${name} reached ${Math.round(value)} punches`;
    case 'suspicious_speed':
      return `Suspicious punch speed: ${value.toFixed(1)} m/s by ${name} (over 20 m/s, not counted for records)`;
  }
}

/**
 * What T_HIGHLIGHTS would have written, treating each session as one stream batch, processed in
 * the order the sessions started. Newest first.
 */
export function deriveHighlights(events: MotionEvent[], nameOf: (playerId: string) => string): Highlight[] {
  const sessions = new Map<string, MotionEvent[]>();
  for (const e of [...events].sort((a, b) => a.event_ts.localeCompare(b.event_ts))) {
    const list = sessions.get(e.session_id) ?? [];
    list.push(e);
    sessions.set(e.session_id, list);
  }
  let globalSpeed: number | null = null;
  let globalReaction: number | null = null;
  const playerSpeed = new Map<string, number>();
  const playerPunches = new Map<string, number>();
  const out: Highlight[] = [];

  for (const [session_id, evs] of sessions) {
    const player_id = evs[0]!.player_id;
    const name = nameOf(player_id);
    const created_at = evs[evs.length - 1]!.event_ts;
    const add = (kind: HighlightKind, value: number, unit: string) =>
      out.push({ highlight_id: `${kind}-${session_id}`, created_at, kind, player_id, name, session_id, value: round(value, 2), unit, message: highlightMessage(kind, name, value) });

    const punches = evs.filter(isPunch);
    const valid = punches.map((e) => e.speed_mps).filter((s) => s > 0 && s <= MAX_REAL_SPEED);
    const top = valid.length ? Math.max(...valid) : null;
    const reactions = evs.map((e) => e.reaction_ms).filter((v): v is number => typeof v === 'number' && v > 0);
    const bestRt = reactions.length ? Math.min(...reactions) : null;

    if (top !== null && (globalSpeed === null || top > globalSpeed)) add('speed_record', top, 'm/s');
    else if (top !== null && playerSpeed.has(player_id) && top > playerSpeed.get(player_id)!) add('personal_best_speed', top, 'm/s');
    if (bestRt !== null && (globalReaction === null || bestRt < globalReaction)) add('reaction_record', bestRt, 'ms');

    const before = playerPunches.get(player_id) ?? 0;
    const after = before + punches.length;
    const crossed = MILESTONES.filter((m) => before < m && after >= m);
    if (crossed.length) add('punch_milestone', Math.max(...crossed), 'punches');

    const fastest = punches.length ? Math.max(...punches.map((e) => e.speed_mps)) : 0;
    if (fastest > MAX_REAL_SPEED) add('suspicious_speed', fastest, 'm/s');

    if (top !== null) {
      globalSpeed = Math.max(globalSpeed ?? -Infinity, top);
      playerSpeed.set(player_id, Math.max(playerSpeed.get(player_id) ?? -Infinity, top));
    }
    if (bestRt !== null) globalReaction = Math.min(globalReaction ?? Infinity, bestRt);
    playerPunches.set(player_id, after);
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at) || (b.highlight_id < a.highlight_id ? -1 : 1));
}
