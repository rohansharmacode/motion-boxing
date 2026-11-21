import { FOCUS_QUERY, parseStructuredCard, pickWeakestFocus } from './coachStructured';
import { StructuredUnsupportedError, type Cortex } from './cortex';
import { FOCUSES, type Drill, type DrillSearchOptions, type DrillSearchResult, type Focus } from './drills';
import type { Logger } from './logger';
import type { CoachCard, CoachGrounding, CoachMeta, Percentiles, SessionAggregate, SessionStats } from './types';
import { TimeoutError, errorMessage, withTimeout } from './util';

const LIMITS = { tip: 240, drill: 300, badge: 40, summary: 400 };

/** Hardcoded card used whenever Cortex errors, times out or returns unusable JSON. */
export const FALLBACK_TIPS: [string, string, string] = [
  'Keep your rear hand glued to your chin while the lead hand works.',
  'Snap every punch back as fast as you threw it: relaxed shoulders mean faster hands.',
  'Pace yourself so your last 30 seconds are as sharp as your first.',
];

export function fallbackCard(stats?: SessionStats | null): CoachCard {
  const parts: string[] = [];
  if (stats) {
    parts.push(`Round complete: ${stats.score} points from ${stats.total_punches} punches`);
    if (stats.avg_speed !== null) parts[0] += ` at ${stats.avg_speed} m/s average`;
    parts[0] += '.';
  } else {
    parts.push('Round complete.');
  }
  parts.push('Here is a classic plan to sharpen your speed and guard.');
  return {
    tips: [...FALLBACK_TIPS],
    drill: 'Guard-Return Combos: 3 x 1-minute rounds of jab-cross-hook at 80% power, 30 s rest, guard back up after every combo.',
    badge: 'Iron Will',
    summary: parts.join(' '),
  };
}

/** Focus + Cortex Search drills put into the prompt. */
export interface CoachContext {
  focus: Focus;
  drills: Drill[];
}

function contextLines(ctx?: CoachContext): string[] {
  if (!ctx) return [];
  const lines = ['', `FOCUS: ${ctx.focus} (the weakest area this round; put it first)`];
  if (ctx.drills.length > 0) {
    lines.push('DRILL LIBRARY (from our drill catalogue). Base the drill on ONE of these and keep its title as the drill name:');
    ctx.drills.forEach((d, i) => {
      lines.push(`${i + 1}. ${JSON.stringify({ title: d.title, focus: d.focus, level: d.level, description: d.description, cues: d.cues })}`);
    });
  }
  return lines;
}

function roundData(agg: SessionAggregate) {
  return {
    score: agg.stats.score,
    total_punches: agg.stats.total_punches,
    avg_speed_mps: agg.stats.avg_speed,
    max_speed_mps: agg.stats.max_speed,
    avg_reaction_ms: agg.stats.avg_reaction_ms,
    best_reaction_ms: agg.stats.best_reaction_ms,
    accuracy_0_to_1: agg.stats.accuracy,
    guard_up_pct: agg.extras.guard_pct,
    left_right_symmetry_pct: agg.extras.symmetry_pct,
    speed_drop_first_to_last_quarter_pct: agg.extras.fatigue_drop_pct,
    punch_mix_counts: agg.extras.punch_mix,
  };
}

/** Prompt for AI_COMPLETE with response_format: the schema enforces the shape, the prompt sets the content rules. */
export function buildStructuredCoachPrompt(agg: SessionAggregate, percentiles: Partial<Percentiles>, ctx?: CoachContext): string {
  return [
    'You are an upbeat, expert boxing coach reviewing one round of a webcam boxing game.',
    'Use ONLY the data below. Null means not measured. Reaction time and speed drop: lower is better.',
    'Percentiles compare this round with a benchmark population (50 = median, 99 = elite).',
    '',
    `ROUND STATS: ${JSON.stringify(roundData(agg))}`,
    `PERCENTILES: ${JSON.stringify(percentiles)}`,
    ...contextLines(ctx),
    '',
    'Fill in the coach card:',
    '- "headline": one punchy line, max 12 words.',
    '- "summary": one or two encouraging sentences (max 40 words) that mention the score.',
    '- "tips": exactly 3 specific, actionable tips (max 25 words each), weakest areas first, each tied to a number above.',
    '- "drill": "name" is a short drill name (2-4 words); "description" is one concrete drill with reps or time (max 30 words).',
    '- "badge": "name" is a fun 1-3 word title earned this round (max 24 characters, no emoji); "description" is one short sentence.',
    `- "focus": exactly one of ${FOCUSES.join(', ')}${ctx ? ` (normally "${ctx.focus}")` : ''}.`,
  ].join('\n');
}

export function buildCoachPrompt(agg: SessionAggregate, percentiles: Partial<Percentiles>, ctx?: CoachContext): string {
  const round = roundData(agg);
  return [
    'You are an upbeat, expert boxing coach reviewing one round of a webcam boxing game.',
    'Use ONLY the data below. Null means not measured. Reaction time and speed drop: lower is better.',
    'Percentiles compare this round with a benchmark population (50 = median, 99 = elite).',
    '',
    `ROUND STATS: ${JSON.stringify(round)}`,
    `PERCENTILES: ${JSON.stringify(percentiles)}`,
    ...contextLines(ctx),
    '',
    'Reply with ONLY one JSON object. No markdown, no code fences, no text before or after it.',
    'It must have exactly these keys and types:',
    '{"tips": ["<tip 1>", "<tip 2>", "<tip 3>"], "drill": "<Drill Name>: <drill>", "badge": "<badge>", "summary": "<summary>"}',
    'Rules:',
    '- "tips": exactly 3 specific, actionable tips (max 25 words each), weakest areas first, each tied to a number above.',
    '- "drill": a short drill name (2-4 words), a colon, then one concrete drill with reps or time (max 30 words).',
    '- "badge": a fun 1-3 word title earned this round (max 24 characters, no emoji).',
    '- "summary": one or two encouraging sentences (max 40 words) that mention the score.',
  ].join('\n');
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/** Accepts {tips, drill, badge, summary} (or the same nested under coach/card). */
export function normalizeCard(obj: unknown): CoachCard | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (!('tips' in o)) {
    for (const k of ['coach', 'card', 'coach_card']) {
      if (o[k] && typeof o[k] === 'object') return normalizeCard(o[k]);
    }
    return null;
  }
  if (!Array.isArray(o.tips)) return null;
  const tips = o.tips.map((t) => cleanText(t, LIMITS.tip)).filter((t): t is string => t !== null);
  if (tips.length < 3) return null;
  const drill = cleanText(o.drill, LIMITS.drill);
  const badge = cleanText(o.badge, LIMITS.badge);
  const summary = cleanText(o.summary, LIMITS.summary);
  if (!drill || !badge || !summary) return null;
  return { tips: [tips[0]!, tips[1]!, tips[2]!], drill, badge, summary };
}

/** Balanced top-level {...} substrings, string/escape aware. */
export function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      if (depth > 0) inStr = true;
    } else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/** Defensive parse of whatever Cortex returned. Null if no valid card can be recovered. */
export function parseCoachCard(raw: unknown): CoachCard | null {
  if (raw && typeof raw === 'object') return normalizeCard(raw);
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  // Double-encoded: the whole reply is a JSON string literal containing the object.
  for (let i = 0; i < 2 && text.startsWith('"'); i++) {
    try {
      const s: unknown = JSON.parse(text);
      if (typeof s !== 'string') break;
      text = s.trim();
    } catch {
      break;
    }
  }
  text = text.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
  const candidates = [text, ...extractJsonObjects(text)];
  for (const c of candidates) {
    try {
      const card = normalizeCard(JSON.parse(c));
      if (card) return card;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export interface CoachResult {
  card: CoachCard;
  fallback: boolean;
  reason?: 'timeout' | 'error' | 'invalid_json';
  meta?: CoachMeta;
}

export interface CoachDeps {
  cortex: Cortex;
  timeoutMs: number;
  log: Logger;
  /** Use AI_COMPLETE structured output when the Cortex supports it (CORTEX_STRUCTURED). Default true. */
  structured?: boolean;
  /** Cortex Search over COACH_DRILLS (COACH_GROUNDING); omitted = no grounding. */
  search?: (query: string, opts: DrillSearchOptions) => Promise<DrillSearchResult>;
  /** Own timeout for the search (COACH_SEARCH_TIMEOUT_MS), capped at a third of timeoutMs. */
  searchTimeoutMs?: number;
}

const NO_GROUNDING: CoachGrounding = { source: 'fallback', drills: [] };
let searchWarned = false;

/** Top 3 drills for the focus. Never throws: any failure means an ungrounded card. */
async function groundingFor(deps: CoachDeps, focus: Focus): Promise<{ grounding: CoachGrounding; drills: Drill[] }> {
  if (!deps.search) return { grounding: NO_GROUNDING, drills: [] };
  const ms = Math.max(1, Math.min(deps.searchTimeoutMs ?? 2500, Math.floor(deps.timeoutMs / 3)));
  try {
    const r = await withTimeout(deps.search(FOCUS_QUERY[focus], { focus, limit: 3, timeoutMs: ms }), ms, 'cortex search (coach)');
    const drills = r.available ? r.results.slice(0, 3) : [];
    if (drills.length === 0) return { grounding: NO_GROUNDING, drills: [] };
    return { grounding: { source: r.source === 'mock' ? 'mock' : 'cortex_search', drills: drills.map((d) => ({ drill_id: d.drill_id, title: d.title })) }, drills };
  } catch (err) {
    // Logged once: a missing search service would otherwise warn on every round.
    if (!searchWarned) deps.log.warn('coach grounding: Cortex Search unavailable, continuing without drills', { error: errorMessage(err) });
    searchWarned = true;
    return { grounding: NO_GROUNDING, drills: [] };
  }
}

export async function generateCoachCard(deps: CoachDeps, agg: SessionAggregate, percentiles: Partial<Percentiles>): Promise<CoachResult> {
  const { cortex, timeoutMs, log } = deps;
  const started = Date.now();
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
  const focus = pickWeakestFocus(agg, percentiles);
  const { grounding, drills } = await groundingFor(deps, focus);
  const ctx: CoachContext = { focus, drills };
  const meta = (structured: boolean, extra: Partial<CoachMeta> = {}): CoachMeta => ({ focus, grounding, structured, ...extra });
  try {
    if (deps.structured !== false && cortex.completeStructured && cortex.structuredAvailable?.() !== false) {
      try {
        const ms = remaining();
        const raw = await withTimeout(
          cortex.completeStructured(buildStructuredCoachPrompt(agg, percentiles, ctx), { purpose: 'coach', timeoutMs: ms }),
          ms,
          'cortex coach card',
        );
        const parsed = parseStructuredCard(raw);
        if (parsed) {
          return { card: parsed.card, fallback: false, meta: meta(true, { focus: parsed.focus ?? focus, headline: parsed.headline }) };
        }
        log.warn('AI_COMPLETE structured coach reply was not a valid card; using fallback', {
          preview: (typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '').slice(0, 200),
        });
        return { card: fallbackCard(agg.stats), fallback: true, reason: 'invalid_json', meta: meta(false) };
      } catch (err) {
        if (!(err instanceof StructuredUnsupportedError)) throw err;
        log.warn('AI_COMPLETE structured output unavailable; using SNOWFLAKE.CORTEX.COMPLETE from now on', { error: errorMessage(err) });
      }
    }
    const ms = remaining();
    const raw = await withTimeout(
      cortex.complete(buildCoachPrompt(agg, percentiles, ctx), { purpose: 'coach', timeoutMs: ms }),
      ms,
      'cortex coach card',
    );
    const card = parseCoachCard(raw);
    if (card) return { card, fallback: false, meta: meta(false) };
    log.warn('Cortex coach reply was not a valid card; using fallback', {
      preview: typeof raw === 'string' ? raw.slice(0, 200) : typeof raw,
    });
    return { card: fallbackCard(agg.stats), fallback: true, reason: 'invalid_json', meta: meta(false) };
  } catch (err) {
    const reason = err instanceof TimeoutError ? 'timeout' : 'error';
    log.warn(`Cortex coach call failed (${reason}); using fallback`, { error: errorMessage(err) });
    return { card: fallbackCard(agg.stats), fallback: true, reason, meta: meta(false) };
  }
}
