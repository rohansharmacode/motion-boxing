// Adapter for the front end's contract (src/api/CONTRACT.md + src/api/types.ts, written by the
// front-end team). The front end generates its own player/session/event ids, never calls
// /api/players or /api/session/start, and uses the column names from motion-sports-research.md
// section 5. This module maps that shape onto our MOTION_EVENTS columns (sql/CONTRACT.md) and
// maps our coach card / leaderboard back to the shape the UI renders. The original API is
// unchanged; app.ts picks the shape per request.

import { z } from 'zod';
import { IdSchema } from './schemas';
import { PUNCH_TYPES, SPORT, type CoachCard, type CoachGrounding, type CoachMeta, type LeaderboardRow, type MotionEvent, type SessionStats } from './types';

const num = z.number().finite();

/** One event as the front end sends it (MotionEvent in src/api/types.ts). */
export const FrontendEvent = z.object({
  event_id: IdSchema,
  session_id: IdSchema,
  player_id: IdSchema,
  sport: z.string().max(32).nullish(),
  event_ts: z.iso.datetime({ offset: true, message: 'must be an ISO-8601 timestamp with Z or an offset' }),
  round_ms: num.nullish(),
  event_type: z.string().min(1).max(32),
  peak_velocity: num.min(0).nullish(),
  reaction_ms: num.min(0).max(60_000).nullish(),
  accuracy_score: num.min(0).max(100).nullish(),
  symmetry_ratio: num.nullish(),
  metrics: z.record(z.string(), z.unknown()).nullish(),
});
export type FrontendEventInput = z.infer<typeof FrontendEvent>;

/** POST /api/session/end body from the front end (SessionEndRequest). */
export const FrontendEndBody = z.object({
  session_id: IdSchema,
  player_id: IdSchema,
  display_name: z.string().nullish(),
  sport: z.string().max(32).nullish(),
  started_at: z.iso.datetime({ offset: true }).nullish(),
  ended_at: z.iso.datetime({ offset: true }).nullish(),
  final_score: num.nullish(),
  result: z.string().max(32).nullish(),
  avg_inference_fps: num.nullish(),
  stats: z.record(z.string(), z.unknown()).nullish(),
});
export type FrontendEndInput = z.infer<typeof FrontendEndBody>;

/** A body item is front-end shaped if it uses the section-5 column names or upper-case types. */
export function isFrontendEvent(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return 'metrics' in o || 'peak_velocity' in o || 'accuracy_score' in o || 'round_ms' in o ||
    (typeof o.event_type === 'string' && /^[A-Z_]+$/.test(o.event_type));
}

export function isFrontendEndBody(b: unknown): boolean {
  return Boolean(b && typeof b === 'object' && 'player_id' in (b as object));
}

export function cleanDisplayName(name: string | null | undefined): string | null {
  const s = (name ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 50) : null;
}

/** Points per event when the front end does not send metrics.points. */
export const DEFAULT_POINTS = { landedPunchBase: 10, landedPunchAccuracyBonus: 10, block: 5 } as const;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Maps one front-end event to a MOTION_EVENTS row (DODGE -> 'slip' or 'duck'), or null for types
 * our boxing analytics don't model (TICK, SAVE, GOAL, ARROW_RELEASE).
 */
export function mapFrontendEvent(e: FrontendEventInput, shoulderWidthM: number): MotionEvent | null {
  const m = e.metrics ?? {};
  const type = e.event_type.toUpperCase();
  let event_type: MotionEvent['event_type'];
  if (type === 'PUNCH') {
    const pt = String(m.punchType ?? '').toLowerCase();
    event_type = (PUNCH_TYPES as readonly string[]).includes(pt) ? (pt as MotionEvent['event_type']) : 'jab';
  } else if (type === 'BLOCK') {
    event_type = 'block';
  } else if (type === 'DODGE') {
    event_type = m.kind === 'duck' || m.direction === 'DOWN' ? 'duck' : 'slip';
  } else {
    return null;
  }
  const isBlock = event_type === 'block';
  const isDefense = isBlock || event_type === 'slip' || event_type === 'duck';
  const hand = m.hand === 'L' || m.hand === 'R' ? m.hand : isDefense ? 'L' : 'R';
  // peak_velocity is in shoulder-widths/second; PRO_BENCHMARKS and the leaderboard use m/s.
  const speed_mps = e.peak_velocity == null ? 0 : Math.round(clamp(e.peak_velocity * shoulderWidthM, 0, 100) * 1000) / 1000;
  const accuracy = isDefense || e.accuracy_score == null ? null : clamp(e.accuracy_score / 100, 0, 1);
  const guardRaw = m.guardUp ?? m.guard_up;
  const guard_up = typeof guardRaw === 'boolean' ? guardRaw : null;

  let points: number;
  if (typeof m.points === 'number' && Number.isFinite(m.points)) {
    points = Math.round(clamp(m.points, -10_000, 10_000));
  } else if (isDefense) {
    points = DEFAULT_POINTS.block;
  } else if (m.landed === false) {
    points = 0;
  } else {
    points = DEFAULT_POINTS.landedPunchBase + Math.round(DEFAULT_POINTS.landedPunchAccuracyBonus * (accuracy ?? 0));
  }

  return {
    event_id: e.event_id,
    session_id: e.session_id,
    player_id: e.player_id,
    sport: SPORT,
    event_ts: new Date(e.event_ts).toISOString(),
    event_type,
    hand,
    speed_mps,
    accuracy,
    reaction_ms: e.reaction_ms ?? null,
    guard_up,
    points,
    // Keep the original section-5 fields so nothing the client measured is lost.
    payload: {
      source: 'frontend',
      event_type: e.event_type,
      round_ms: e.round_ms ?? null,
      peak_velocity: e.peak_velocity ?? null,
      accuracy_score: e.accuracy_score ?? null,
      symmetry_ratio: e.symmetry_ratio ?? null,
      metrics: m,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export interface FrontendCoachCard {
  headline: string;
  tips: string[];
  drill: { name: string; description: string };
  badge: { name: string; description: string };
  summary: string;
  /** Optional (sql/PLUS_CONTRACT.md); the UI ignores unknown fields. */
  focus?: string | null;
  grounding?: CoachGrounding;
  structured?: boolean;
}

function firstSentence(text: string, max = 140): string {
  const s = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/** "Guard-Return Jabs: 3 x 1 min ..." -> {name, description}; otherwise a generic name. */
export function splitDrill(drill: string): { name: string; description: string } {
  const m = /^(.{3,40}?)(?::\s+|\s+[—–-]\s+)(.+)$/s.exec(drill);
  if (m) return { name: m[1]!.trim(), description: m[2]!.trim() };
  return { name: 'Coach Drill', description: drill };
}

export function toFrontendCoach(card: CoachCard, stats: SessionStats, meta?: CoachMeta): FrontendCoachCard {
  return {
    headline: meta?.headline || firstSentence(card.summary),
    tips: [...card.tips],
    drill: splitDrill(card.drill),
    badge: {
      name: card.badge,
      description: `Earned this round: ${stats.score} points from ${stats.total_punches} punches.`,
    },
    summary: card.summary,
    ...(meta ? { focus: meta.focus, grounding: meta.grounding, structured: meta.structured } : {}),
  };
}

/** Superset row: original fields plus the names the front end reads. */
export function toLeaderboardRow(r: LeaderboardRow) {
  return { ...r, display_name: r.name, sport: 'BOXING' as const, max_speed: r.fastest_punch };
}
