// Coach card for goalkeeper and archery sessions. The boxing prompt (coach.ts) is untouched; this
// uses the same JSON card shape, the same parser and the same fallback rules.

import { parseCoachCard, type CoachResult } from './coach';
import type { Cortex } from './cortex';
import type { Logger } from './logger';
import type { ArcherySummary, GoalkeeperSummary, SportSummary } from './multisport';
import type { CoachCard, CoachMeta } from './types';
import { TimeoutError, errorMessage, withTimeout } from './util';

const JSON_RULES = [
  'Reply with ONLY one JSON object. No markdown, no code fences, no text before or after it.',
  'It must have exactly these keys and types:',
  '{"tips": ["<tip 1>", "<tip 2>", "<tip 3>"], "drill": "<Drill Name>: <drill>", "badge": "<badge>", "summary": "<summary>"}',
  'Rules:',
  '- "tips": exactly 3 specific, actionable tips (max 25 words each), weakest areas first, each tied to a number above.',
  '- "drill": a short drill name (2-4 words), a colon, then one concrete drill with reps or time (max 30 words).',
  '- "badge": a fun 1-3 word title earned this round (max 24 characters, no emoji).',
];

function keeperData(s: GoalkeeperSummary) {
  return {
    score: s.score,
    shots_faced: s.shots,
    saves: s.saves,
    goals_conceded: s.goals,
    save_pct: s.save_pct,
    avg_reaction_ms: s.avg_reaction_ms,
    best_reaction_ms: s.best_reaction_ms,
    avg_glove_speed_mps: s.avg_glove_speed_mps,
    punch_clearances: s.punch_clearances,
    weakest_zone: s.weakest_zone ? { label: s.weakest_zone.label, saves: s.weakest_zone.saves, shots: s.weakest_zone.shots } : null,
    zones: s.zones.map((z) => ({ zone: z.label, shots: z.shots, saves: z.saves })),
  };
}

function archeryData(s: ArcherySummary) {
  return {
    score: s.score,
    arrows: s.arrows,
    avg_points_per_arrow: s.avg_points,
    best_arrow: s.best_points,
    avg_ring_0_to_10: s.avg_ring,
    bullseyes: s.bullseyes,
    grouping_rms: s.grouping,
    aim_bias_dx: s.mean_dx,
    aim_bias_dy: s.mean_dy,
    avg_accuracy_pct: s.avg_accuracy_pct,
  };
}

/** Prompt for SNOWFLAKE.CORTEX.COMPLETE; same JSON card as boxing (buildCoachPrompt). */
export function buildSportCoachPrompt(s: SportSummary): string {
  if (s.sport === 'goalkeeper') {
    return [
      'You are an upbeat, expert goalkeeping coach reviewing one penalty shootout of a webcam goalkeeper game.',
      'Use ONLY the data below. Null means not measured. Reaction time: lower is better (under 450 ms earns a bonus).',
      'Zones are a 3x3 grid of the goal mouth as the keeper sees it on screen (top left ... bottom right).',
      '',
      `SHOOTOUT STATS: ${JSON.stringify(keeperData(s))}`,
      '',
      ...JSON_RULES,
      '- Tip 1 must be about the weakest zone when there is one; mention the save percentage and reaction time.',
      '- "summary": one or two encouraging sentences (max 40 words) that mention saves out of shots and the score.',
    ].join('\n');
  }
  return [
    'You are an upbeat, expert archery coach reviewing one round of a webcam archery game (10-ring target).',
    'Use ONLY the data below. Null means not measured. Grouping is the spread of the hits: lower is tighter.',
    'Aim bias: positive dx = hits right of centre, positive dy = hits above centre.',
    '',
    `ROUND STATS: ${JSON.stringify(archeryData(s))}`,
    '',
    ...JSON_RULES,
    '- Cover grouping (consistency) and aim bias (where to adjust) when they are measured.',
    '- "summary": one or two encouraging sentences (max 40 words) that mention the score and bullseyes.',
  ].join('\n');
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v)}%`);

/** Data-driven card used when Cortex is unavailable (and in mock mode). */
export function sportFallbackCard(s: SportSummary): CoachCard {
  if (s.sport === 'goalkeeper') {
    const w = s.weakest_zone;
    const tips: [string, string, string] = [
      w
        ? `Shots to the ${w.label} beat you most (${w.saves}/${w.shots} saved): start each kick a half step toward that side and push off early.`
        : 'Stay on your toes and centred between kicks so every corner is one push away.',
      s.avg_reaction_ms !== null
        ? `Your average reaction was ${Math.round(s.avg_reaction_ms)} ms: move on the striker's plant foot, not the ball, to get under 450 ms.`
        : "Read the striker's plant foot and hips: they show the side before the ball is struck.",
      'Keep both gloves up at shoulder height: top corners are the hardest to reach from a low guard.',
    ];
    const badge = s.save_pct === null ? 'Brave Keeper' : s.save_pct >= 80 ? 'Brick Wall' : s.save_pct >= 60 ? 'Safe Hands' : s.save_pct >= 40 ? 'Shot Stopper' : 'Brave Keeper';
    return {
      tips,
      drill: 'Corner Reflex Ladder: 3 sets of 10 kicks alternating top corners, reset to centre after every save, 30 s rest between sets.',
      badge,
      summary: `Shootout complete: ${s.saves} of ${s.shots} saved (${pct(s.save_pct)}) for ${s.score} points. Keep the gloves up and own your weakest corner next time.`,
    };
  }
  const tips: [string, string, string] = [
    s.grouping !== null
      ? `Your grouping spread is ${s.grouping}: hold full draw for a 2-count before every release so each arrow leaves the same way.`
      : 'Hold full draw for a 2-count before every release so each arrow leaves the same way.',
    s.mean_dx !== null && Math.abs(s.mean_dx) > 0.05
      ? `Your hits drift ${s.mean_dx > 0 ? 'right' : 'left'} of centre: settle the bow hand and aim slightly ${s.mean_dx > 0 ? 'left' : 'right'}.`
      : 'Breathe out slowly as you release: a still bow arm keeps the arrow on line.',
    s.avg_ring !== null
      ? `You averaged ${s.avg_ring} rings per arrow: pick the exact centre dot, not the gold, before you release.`
      : 'Pick the exact centre dot, not the whole gold, before you release.',
  ];
  const badge = s.bullseyes >= 2 ? 'Eagle Eye' : (s.avg_points ?? 0) >= 8 ? 'Sharpshooter' : (s.avg_points ?? 0) >= 5 ? 'Steady Aim' : 'Rising Archer';
  return {
    tips,
    drill: 'Hold and Release: 3 ends of 5 arrows, hold full draw for 3 s before each release, breathe out as you let go.',
    badge,
    summary: `Round complete: ${s.score} points from ${s.arrows} arrows with ${s.bullseyes} bullseye${s.bullseyes === 1 ? '' : 's'}. Tighten the group and the score follows.`,
  };
}

export function sportBadgeNote(s: SportSummary): string {
  return s.sport === 'goalkeeper'
    ? `Earned this shootout: ${s.score} points, ${s.saves} of ${s.shots} saved.`
    : `Earned this round: ${s.score} points from ${s.arrows} arrows.`;
}

export function sportMeta(s: SportSummary): CoachMeta {
  const focus =
    s.sport === 'goalkeeper'
      ? s.weakest_zone
        ? `zone: ${s.weakest_zone.label}`
        : 'reaction'
      : s.grouping !== null
        ? 'grouping'
        : 'accuracy';
  return { focus, grounding: { source: 'fallback', drills: [] }, structured: false, sport: s.sport, badge_note: sportBadgeNote(s) };
}

export interface SportCoachDeps {
  cortex: Cortex;
  timeoutMs: number;
  log: Logger;
}

export async function generateSportCoachCard(deps: SportCoachDeps, s: SportSummary): Promise<CoachResult> {
  const meta = sportMeta(s);
  // Mock mode: the mock Cortex only knows a boxing card; the data-driven card is the useful answer.
  if (deps.cortex.model === 'mock') return { card: sportFallbackCard(s), fallback: false, meta };
  try {
    const raw = await withTimeout(
      deps.cortex.complete(buildSportCoachPrompt(s), { purpose: 'coach', timeoutMs: deps.timeoutMs }),
      deps.timeoutMs,
      `cortex ${s.sport} coach card`,
    );
    const card = parseCoachCard(raw);
    if (card) return { card, fallback: false, meta };
    deps.log.warn(`Cortex ${s.sport} coach reply was not a valid card; using fallback`, {
      preview: typeof raw === 'string' ? raw.slice(0, 200) : typeof raw,
    });
    return { card: sportFallbackCard(s), fallback: true, reason: 'invalid_json', meta };
  } catch (err) {
    const reason = err instanceof TimeoutError ? 'timeout' : 'error';
    deps.log.warn(`Cortex ${s.sport} coach call failed (${reason}); using fallback`, { error: errorMessage(err) });
    return { card: sportFallbackCard(s), fallback: true, reason, meta };
  }
}
