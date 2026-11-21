// Structured coach card (AI_COMPLETE response_format) and the focus used for Cortex Search grounding.
// Schema: sql/PLUS_CONTRACT.md "Structured coach card JSON schema".

import { isFocus, type Focus } from './drills';
import { toObjectLiteral, type LiteralValue } from './sqlLiteral';
import type { CoachCard, Percentiles, SessionAggregate } from './types';

const str = { type: 'string' } as const;
const nameDescription = {
  type: 'object',
  properties: { name: str, description: str },
  required: ['name', 'description'],
};

/** JSON schema of the structured card. Kept to basic keywords so every model accepts it. */
export const COACH_CARD_SCHEMA: LiteralValue = {
  type: 'object',
  properties: {
    headline: str,
    summary: str,
    tips: { type: 'array', items: str },
    drill: nameDescription,
    badge: nameDescription,
    focus: str,
  },
  required: ['headline', 'summary', 'tips', 'drill', 'badge', 'focus'],
};

export const COACH_MODEL_PARAMETERS: LiteralValue = { temperature: 0.3, max_tokens: 700 };

export function coachResponseFormatLiteral(): string {
  return toObjectLiteral({ type: 'json', schema: COACH_CARD_SCHEMA });
}

export interface StructuredCard {
  card: CoachCard;
  headline: string | null;
  focus: Focus | null;
}

const LIMITS = { tip: 240, drill: 300, badge: 40, summary: 400, headline: 140 };

function clean(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function nameOf(v: unknown): { name: string | null; description: string | null } {
  if (typeof v === 'string') return { name: null, description: v };
  if (!v || typeof v !== 'object') return { name: null, description: null };
  const o = v as Record<string, unknown>;
  return { name: typeof o.name === 'string' ? o.name : null, description: typeof o.description === 'string' ? o.description : null };
}

/**
 * AI_COMPLETE with response_format returns an OBJECT; the driver may hand it over parsed or as
 * JSON text, and show_details wraps it in structured_output. Null if no valid card.
 */
export function parseStructuredCard(raw: unknown): StructuredCard | null {
  let v: unknown = raw;
  for (let i = 0; i < 2 && typeof v === 'string'; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  let o = v as Record<string, unknown>;
  if (o.structured_output && typeof o.structured_output === 'object') o = o.structured_output as Record<string, unknown>;
  if (!Array.isArray(o.tips)) return null;
  const tips = o.tips.map((t) => clean(t, LIMITS.tip)).filter((t): t is string => t !== null);
  if (tips.length < 3) return null;

  const d = nameOf(o.drill);
  const drillName = clean(d.name, 40);
  const drillText = clean(d.description, LIMITS.drill);
  if (!drillText) return null;
  // "Name: description" is how the original card carries the drill name (frontend.splitDrill reads it back).
  const drill = clean(drillName ? `${drillName}: ${drillText}` : drillText, LIMITS.drill);
  const badge = clean(nameOf(o.badge).name ?? nameOf(o.badge).description, LIMITS.badge);
  const summary = clean(o.summary, LIMITS.summary);
  if (!drill || !badge || !summary) return null;
  const focus = typeof o.focus === 'string' ? o.focus.trim().toLowerCase() : null;
  return {
    card: { tips: [tips[0]!, tips[1]!, tips[2]!], drill, badge, summary },
    headline: clean(o.headline, LIMITS.headline),
    focus: isFocus(focus) ? focus : null,
  };
}

export const WEAKNESS_FOCUSES = ['speed', 'reaction', 'accuracy', 'guard', 'symmetry', 'endurance'] as const satisfies readonly Focus[];

function clamp100(x: number): number {
  return Math.min(100, Math.max(0, x));
}

/**
 * 0..100 score per focus for this round: the benchmark percentile when known, otherwise the
 * PLAYER_FORM component formula (sql/analytics.sql). Null when the round did not measure it.
 */
export function roundFocusScores(agg: SessionAggregate, p: Partial<Percentiles>): Record<(typeof WEAKNESS_FOCUSES)[number], number | null> {
  const s = agg.stats;
  const x = agg.extras;
  const pick = (pct: number | null | undefined, raw: number | null) => (typeof pct === 'number' ? pct : raw === null ? null : clamp100(raw));
  return {
    speed: pick(p.punch_speed_mps, s.avg_speed === null ? null : (s.avg_speed / 10) * 100),
    reaction: pick(p.reaction_ms, s.avg_reaction_ms === null ? null : ((500 - s.avg_reaction_ms) / 320) * 100),
    accuracy: pick(p.accuracy_pct, s.accuracy === null ? null : s.accuracy * 100),
    guard: pick(p.guard_pct, x.guard_pct),
    symmetry: pick(p.symmetry_pct, x.symmetry_pct),
    endurance: pick(p.fatigue_drop_pct, x.fatigue_drop_pct === null ? null : 100 - 2 * x.fatigue_drop_pct),
  };
}

/** Weakest measured area; 'guard' when the round measured nothing (the classic beginner fix). */
export function pickWeakestFocus(agg: SessionAggregate, p: Partial<Percentiles>): Focus {
  const scores = roundFocusScores(agg, p);
  let best: Focus | null = null;
  let low = Infinity;
  for (const f of WEAKNESS_FOCUSES) {
    const v = scores[f];
    if (v !== null && v < low) {
      low = v;
      best = f;
    }
  }
  return best ?? 'guard';
}

export const FOCUS_QUERY: Record<Focus, string> = {
  speed: 'faster hand speed snap punches',
  reaction: 'react faster to openings and counters',
  accuracy: 'punch accuracy and target precision',
  guard: 'keep the guard up and protect the chin',
  symmetry: 'balance left and right hands',
  endurance: 'keep punch speed late in the round, stamina',
  combos: 'punch combinations',
  footwork: 'footwork and movement',
};
