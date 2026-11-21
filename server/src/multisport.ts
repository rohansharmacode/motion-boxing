// Goalkeeper and archery rows in MOTION_EVENTS (sql/PLUS_CONTRACT.md "Multi-sport").
//
// MOTION_EVENTS already has `sport` and a `payload` VARIANT, so no DDL changes:
//   goalkeeper: sport 'goalkeeper', event_type 'save' | 'goal'
//   archery:    sport 'archery',    event_type 'arrow'
// The raw event stays in payload; the few fields the SQL views read are copied to the top level
// of payload by both API shapes (front-end shape and original API), so sql/multisport.sql reads
//   payload:zone  (goalkeeper, 0..8, row * 3 + col, row 0 = top, col 0 = screen left)
//   payload:ring  (archery, 0..10 ring score)
//   payload:dx, payload:dy (archery, hit offset from the target centre, game units)
// Boxing never goes through this module.

import type { FrontendEventInput } from './frontend';
import { MULTI_SPORTS, SPORT, SPORTS, type MotionEvent, type MultiSport, type SportName } from './types';
import { mean, round } from './util';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 'GOALKEEPER' / 'Goalkeeper' / 'goalkeeper' -> 'goalkeeper'; anything unknown -> null. */
export function parseSport(v: unknown): SportName | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (SPORTS as readonly string[]).includes(s) ? (s as SportName) : null;
}

/** Sport of a stored row or session; unknown / missing is boxing (same rule as the SQL COALESCE). */
export function sportOf(v: unknown): SportName {
  return parseSport(v) ?? SPORT;
}

export function isMultiSport(v: unknown): v is MultiSport {
  return (MULTI_SPORTS as readonly string[]).includes(String(v));
}

/** Front-end event type -> sport for the types boxing does not model. */
export function sportForFrontendType(eventType: string): MultiSport | null {
  const t = eventType.toUpperCase();
  if (t === 'SAVE' || t === 'GOAL') return 'goalkeeper';
  if (t === 'ARROW_RELEASE' || t === 'ARROW') return 'archery';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Payload fields read by sql/multisport.sql
// ---------------------------------------------------------------------------------------------

/** 9-grid zone 0..8 from {zone} or {row, col}; null when the event has neither. */
export function keeperZone(m: Record<string, unknown>): number | null {
  const z = finite(m.zone);
  if (z !== null && Number.isInteger(z) && z >= 0 && z <= 8) return z;
  const row = finite(m.row);
  const col = finite(m.col);
  if (row !== null && col !== null && [row, col].every((x) => Number.isInteger(x) && x >= 0 && x <= 2)) return row * 3 + col;
  return null;
}

const RING_KEYS = ['ring', 'ringScore', 'rings', 'arrowScore', 'score'] as const;
const DX_KEYS = ['dx', 'hitX', 'offsetX', 'x'] as const;
const DY_KEYS = ['dy', 'hitY', 'offsetY', 'y'] as const;

function firstFinite(m: Record<string, unknown>, keys: readonly string[], ok: (v: number) => boolean = () => true): number | null {
  for (const k of keys) {
    const v = finite(m[k]);
    if (v !== null && ok(v)) return v;
  }
  return null;
}

/** Archery ring 0..10 (first of ring, ringScore, rings, arrowScore, score that is within 0..10). */
export function archeryRing(m: Record<string, unknown>, accuracyScore?: number | null): number | null {
  const r = firstFinite(m, RING_KEYS, (v) => v >= 0 && v <= 10);
  if (r !== null) return r;
  // No ring sent: approximate it from accuracy_score (0..100).
  const a = finite(accuracyScore);
  return a === null ? null : Math.round(clamp(a, 0, 100) / 10);
}

/** Top-level payload fields for one sport (merged into payload; never overwrites what is there). */
export function sportPayloadFields(sport: MultiSport, m: Record<string, unknown>, accuracyScore?: number | null): Record<string, unknown> {
  if (sport === 'goalkeeper') return { zone: keeperZone(m) };
  return { ring: archeryRing(m, accuracyScore), dx: firstFinite(m, DX_KEYS), dy: firstFinite(m, DY_KEYS) };
}

/** Same bonuses as the goalkeeper engine's arcade score (src/sports/goalkeeper/engine.ts endShootout). */
export const KEEPER_POINTS = { save: 1000, fastReactionMs: 450, fastReactionBonus: 250, punchBonus: 150 } as const;

/**
 * Default points when the client sends none. Goalkeeper: save = 1000 (+250 if reaction < 450 ms,
 * +150 for a punch clearance, + accuracy/2), goal = 0, so SUM(points) per session is the shootout
 * score the game shows (rounded per kick). Archery: the ring score (0..10).
 */
export function defaultSportPoints(
  sport: MultiSport,
  eventType: string,
  e: { reaction_ms?: number | null; accuracy_score?: number | null },
  m: Record<string, unknown>,
): number {
  if (sport === 'goalkeeper') {
    if (eventType !== 'save') return 0;
    let p: number = KEEPER_POINTS.save;
    if (typeof e.reaction_ms === 'number' && e.reaction_ms < KEEPER_POINTS.fastReactionMs) p += KEEPER_POINTS.fastReactionBonus;
    if (m.punch === true) p += KEEPER_POINTS.punchBonus;
    p += Math.round(clamp(finite(e.accuracy_score) ?? 0, 0, 100) / 2);
    return p;
  }
  const ring = archeryRing(m, e.accuracy_score);
  return ring === null ? 0 : Math.round(ring);
}

function handFrom(v: unknown): 'L' | 'R' | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'l' || s === 'left') return 'L';
  if (s === 'r' || s === 'right') return 'R';
  return null;
}

/** One front-end SAVE / GOAL / ARROW_RELEASE event -> MOTION_EVENTS row. */
export function mapMultiSportFrontendEvent(e: FrontendEventInput, sport: MultiSport, shoulderWidthM: number): MotionEvent {
  const m = e.metrics ?? {};
  const t = e.event_type.toUpperCase();
  const event_type = sport === 'goalkeeper' ? (t === 'GOAL' ? 'goal' : 'save') : 'arrow';
  const speed_mps = e.peak_velocity == null ? 0 : Math.round(clamp(e.peak_velocity * shoulderWidthM, 0, 100) * 1000) / 1000;
  const fields = sportPayloadFields(sport, m, e.accuracy_score);
  let accuracy: number | null = e.accuracy_score == null ? null : clamp(e.accuracy_score / 100, 0, 1);
  if (accuracy === null && sport === 'archery' && typeof fields.ring === 'number') accuracy = clamp(fields.ring / 10, 0, 1);
  const pts = finite(m.points);
  return {
    event_id: e.event_id,
    session_id: e.session_id,
    player_id: e.player_id,
    sport,
    event_ts: new Date(e.event_ts).toISOString(),
    event_type,
    // Goalkeeper: the glove that made the save (torso saves and goals have none). Archery: bow hand.
    hand: sport === 'goalkeeper' ? handFrom(m.part ?? m.hand) : handFrom(m.bowHand ?? m.hand),
    speed_mps,
    accuracy,
    reaction_ms: e.reaction_ms ?? null,
    guard_up: null,
    points: pts !== null ? Math.round(clamp(pts, -10_000, 10_000)) : defaultSportPoints(sport, event_type, e, m),
    payload: {
      source: 'frontend',
      event_type: e.event_type,
      round_ms: e.round_ms ?? null,
      peak_velocity: e.peak_velocity ?? null,
      accuracy_score: e.accuracy_score ?? null,
      symmetry_ratio: e.symmetry_ratio ?? null,
      ...fields,
      metrics: m,
    },
  };
}

/** Original-API payload: add the SQL fields (from the payload itself, where the client flattens metrics). */
export function withSportPayload(sport: MultiSport, payload: Record<string, unknown> | null | undefined, accuracy01: number | null): Record<string, unknown> {
  const p = payload ?? {};
  const src = isRecord(p.metrics) ? { ...p.metrics, ...p } : p;
  const fields = sportPayloadFields(sport, src, accuracy01 === null ? null : Math.round(accuracy01 * 1e4) / 100);
  const out: Record<string, unknown> = { ...p };
  for (const [k, v] of Object.entries(fields)) if (out[k] === undefined || out[k] === null) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Per-session summaries (coach prompt + mock analytics). Same rules as sql/multisport.sql.
// ---------------------------------------------------------------------------------------------

const ZONE_NAMES = ['top left', 'top centre', 'top right', 'middle left', 'centre', 'middle right', 'bottom left', 'bottom centre', 'bottom right'];
export function zoneLabel(z: number): string {
  return ZONE_NAMES[z] ?? `zone ${z}`;
}

function payloadOf(e: MotionEvent): Record<string, unknown> {
  const p = isRecord(e.payload) ? e.payload : {};
  return isRecord(p.metrics) ? { ...p.metrics, ...p } : p;
}

/** Zone of a stored goalkeeper row: payload:zone, else payload:metrics:zone (or row/col). */
export function storedZone(e: MotionEvent): number | null {
  return keeperZone(payloadOf(e));
}

export interface KeeperZoneStat {
  zone: number;
  label: string;
  shots: number;
  saves: number;
  save_pct: number;
}

export interface GoalkeeperSummary {
  sport: 'goalkeeper';
  score: number;
  shots: number;
  saves: number;
  goals: number;
  save_pct: number | null;
  avg_reaction_ms: number | null;
  best_reaction_ms: number | null;
  avg_glove_speed_mps: number | null;
  punch_clearances: number;
  zones: KeeperZoneStat[];
  weakest_zone: { zone: number; label: string; shots: number; saves: number; save_pct: number } | null;
}

export interface ArcherySummary {
  sport: 'archery';
  score: number;
  arrows: number;
  avg_points: number | null;
  best_points: number | null;
  avg_ring: number | null;
  bullseyes: number;
  /** RMS distance of hits from their own centre (needs >= 2 arrows with dx/dy); lower = tighter. */
  grouping: number | null;
  /** Mean hit offset (aim bias); positive dx = right of centre, positive dy = above. */
  mean_dx: number | null;
  mean_dy: number | null;
  avg_accuracy_pct: number | null;
}

export type SportSummary = GoalkeeperSummary | ArcherySummary;

const isLower = (e: MotionEvent, t: string) => String(e.event_type).toLowerCase() === t;

export function goalkeeperSummary(events: MotionEvent[]): GoalkeeperSummary {
  const shots = events.filter((e) => isLower(e, 'save') || isLower(e, 'goal'));
  const saves = shots.filter((e) => isLower(e, 'save')).length;
  const reactions = shots.map((e) => e.reaction_ms).filter((v): v is number => typeof v === 'number' && v > 0);
  const speeds = shots.map((e) => e.speed_mps).filter((v) => typeof v === 'number' && v > 0);
  const zones = new Map<number, { shots: number; saves: number }>();
  for (const e of shots) {
    const z = storedZone(e);
    if (z === null) continue;
    const cur = zones.get(z) ?? { shots: 0, saves: 0 };
    cur.shots++;
    if (isLower(e, 'save')) cur.saves++;
    zones.set(z, cur);
  }
  const zoneStats: KeeperZoneStat[] = [...zones.entries()]
    .sort(([a], [b]) => a - b)
    .map(([zone, z]) => ({ zone, label: zoneLabel(zone), shots: z.shots, saves: z.saves, save_pct: round((100 * z.saves) / z.shots, 1)! }));
  // Weakest = lowest save % among zones that were shot at; ties: more goals conceded, then lower zone.
  const weakest = [...zoneStats].sort((a, b) => a.save_pct - b.save_pct || b.shots - b.saves - (a.shots - a.saves) || a.zone - b.zone)[0];
  return {
    sport: 'goalkeeper',
    score: events.reduce((a, e) => a + (e.points ?? 0), 0),
    shots: shots.length,
    saves,
    goals: shots.length - saves,
    save_pct: shots.length ? round((100 * saves) / shots.length, 1) : null,
    avg_reaction_ms: round(mean(reactions), 1),
    best_reaction_ms: reactions.length ? round(Math.min(...reactions), 1) : null,
    avg_glove_speed_mps: round(mean(speeds), 2),
    punch_clearances: shots.filter((e) => payloadOf(e).punch === true).length,
    zones: zoneStats,
    weakest_zone: weakest && weakest.save_pct < 100 ? { ...weakest } : null,
  };
}

export function archerySummary(events: MotionEvent[]): ArcherySummary {
  const arrows = events.filter((e) => isLower(e, 'arrow'));
  const pts = arrows.map((e) => e.points ?? 0);
  const rings = arrows.map((e) => finite(payloadOf(e).ring)).filter((v): v is number => v !== null);
  const hits = arrows
    .map((e) => ({ dx: finite(payloadOf(e).dx), dy: finite(payloadOf(e).dy) }))
    .filter((h): h is { dx: number; dy: number } => h.dx !== null && h.dy !== null);
  const mx = mean(hits.map((h) => h.dx));
  const my = mean(hits.map((h) => h.dy));
  const grouping =
    hits.length >= 2 && mx !== null && my !== null ? Math.sqrt(mean(hits.map((h) => (h.dx - mx) ** 2 + (h.dy - my) ** 2)) ?? 0) : null;
  const acc = mean(arrows.map((e) => e.accuracy).filter((v): v is number => typeof v === 'number'));
  return {
    sport: 'archery',
    score: events.reduce((a, e) => a + (e.points ?? 0), 0),
    arrows: arrows.length,
    avg_points: round(mean(pts), 2),
    best_points: pts.length ? Math.max(...pts) : null,
    avg_ring: round(mean(rings), 2),
    bullseyes: rings.filter((r) => r >= 10).length,
    grouping: round(grouping, 3),
    mean_dx: round(mx, 3),
    mean_dy: round(my, 3),
    avg_accuracy_pct: round(acc === null ? null : acc * 100, 1),
  };
}

export function sportSummary(sport: MultiSport, events: MotionEvent[]): SportSummary {
  return sport === 'goalkeeper' ? goalkeeperSummary(events) : archerySummary(events);
}
