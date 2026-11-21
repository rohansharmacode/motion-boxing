// Coach drill catalogue (sql/PLUS_CONTRACT.md: COACH_DRILLS / COACH_DRILL_SEARCH).
// Real mode queries the Cortex Search service; mock mode does a keyword search over
// sql/data/coach_drills.json when it exists, otherwise over a small built-in list.

import fs from 'node:fs';
import path from 'node:path';
import { dollarQuotedJson } from './sqlLiteral';

export const FOCUSES = ['speed', 'reaction', 'accuracy', 'guard', 'symmetry', 'endurance', 'combos', 'footwork'] as const;
export type Focus = (typeof FOCUSES)[number];

export function isFocus(v: unknown): v is Focus {
  return typeof v === 'string' && (FOCUSES as readonly string[]).includes(v);
}

export interface Drill {
  drill_id: string;
  title: string;
  focus: string;
  level: string;
  description: string;
  cues: string;
}

export interface DrillSearchResult {
  available: boolean;
  source: 'cortex_search' | 'mock';
  results: Drill[];
}

export interface DrillSearchOptions {
  focus?: Focus | null;
  limit: number;
  timeoutMs?: number;
}

export const DRILL_SEARCH_SERVICE = 'MOTION_DB.PUBLIC.COACH_DRILL_SEARCH';
export const DRILL_COLUMNS = ['drill_id', 'title', 'focus', 'level', 'description', 'cues'] as const;

/** SEARCH_PREVIEW needs constant arguments, so the request is a dollar-quoted JSON literal. */
export function drillSearchSql(query: string, opts: DrillSearchOptions): string {
  const request: Record<string, unknown> = {
    query,
    columns: [...DRILL_COLUMNS],
    limit: opts.limit,
  };
  if (opts.focus) request.filter = { '@eq': { focus: opts.focus } };
  return `SELECT SNOWFLAKE.CORTEX.SEARCH_PREVIEW('${DRILL_SEARCH_SERVICE}', ${dollarQuotedJson(request)}) AS response`;
}

function text(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join('; ');
  return v === null || v === undefined ? '' : String(v);
}

export function toDrill(o: Record<string, unknown>): Drill | null {
  const get = (k: string) => o[k] ?? o[k.toUpperCase()];
  const drill_id = text(get('drill_id'));
  const title = text(get('title'));
  if (!drill_id || !title) return null;
  return {
    drill_id,
    title,
    focus: text(get('focus')),
    level: text(get('level')),
    description: text(get('description')),
    cues: text(get('cues')),
  };
}

/** SEARCH_PREVIEW returns a JSON string {"results": [...]} (an object if the driver parsed it). */
export function parseSearchResponse(raw: unknown): Drill[] {
  let obj: unknown = raw;
  if (typeof raw === 'string') obj = JSON.parse(raw);
  const results = obj && typeof obj === 'object' ? (obj as { results?: unknown }).results : undefined;
  if (!Array.isArray(results)) throw new Error('Cortex Search reply has no results array');
  return results
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
    .map(toDrill)
    .filter((d): d is Drill => d !== null);
}

/** Original drills used when sql/data/coach_drills.json is not there. */
export const BUILTIN_DRILLS: Drill[] = [
  {
    drill_id: 'builtin-speed-1', title: 'Snap-Back Jabs', focus: 'speed', level: 'beginner',
    description: '3 x 1 min of single jabs at 70% power, pulling the fist back faster than it went out. 30 s rest.',
    cues: 'Relax the shoulder; exhale on contact; fist returns to the cheek',
  },
  {
    drill_id: 'builtin-reaction-1', title: 'Call-Out Counters', focus: 'reaction', level: 'intermediate',
    description: 'A partner or timer calls a random number every 2-4 s; throw that combo instantly. 4 x 1 min.',
    cues: 'Stay light on the feet; eyes forward; first punch straight',
  },
  {
    drill_id: 'builtin-accuracy-1', title: 'Target Ladder', focus: 'accuracy', level: 'beginner',
    description: 'Pick three targets (head, chest, body) and hit them in order with jab-cross. 3 x 90 s at controlled speed.',
    cues: 'Aim through the target; full extension; reset stance each time',
  },
  {
    drill_id: 'builtin-guard-1', title: 'Glove-to-Chin Rounds', focus: 'guard', level: 'beginner',
    description: '3 x 1 min of jab-cross-hook where the non-punching glove must touch the chin before every punch.',
    cues: 'Elbows in; rear glove on the cheek; chin down',
  },
  {
    drill_id: 'builtin-symmetry-1', title: 'Mirror Combos', focus: 'symmetry', level: 'intermediate',
    description: 'Throw every combo twice, the second time leading with the other hand. 4 x 1 min, 30 s rest.',
    cues: 'Same speed on both sides; switch stance cleanly; count the punches',
  },
  {
    drill_id: 'builtin-endurance-1', title: 'Last-Ten Sprints', focus: 'endurance', level: 'intermediate',
    description: '3 x 2 min rounds of steady shadow boxing with an all-out 10 s punch sprint at the end of each minute.',
    cues: 'Breathe out on every punch; keep form when tired; guard stays up',
  },
  {
    drill_id: 'builtin-combos-1', title: 'One-Two-Hook Builder', focus: 'combos', level: 'beginner',
    description: 'Build the combo one punch at a time: jab, then jab-cross, then jab-cross-hook. 5 reps each, 3 sets.',
    cues: 'Pivot the rear foot on the cross; hook from the hip; return to guard',
  },
  {
    drill_id: 'builtin-footwork-1', title: 'Box-Step Shadow', focus: 'footwork', level: 'beginner',
    description: 'Step forward, right, back, left in a square, throwing a jab after each step. 3 x 1 min.',
    cues: 'Lead foot moves first; never cross the feet; stay on the balls of the feet',
  },
];

let catalog: Drill[] | null = null;

/** Loads sql/data/coach_drills.json once (array or {drills: [...]}); falls back to BUILTIN_DRILLS. */
export function drillCatalog(file = path.resolve(__dirname, '..', '..', 'sql', 'data', 'coach_drills.json')): Drill[] {
  if (catalog) return catalog;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (parsed as { drills?: unknown })?.drills;
    const drills = Array.isArray(list)
      ? list.filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === 'object').map(toDrill).filter((d): d is Drill => d !== null)
      : [];
    catalog = drills.length > 0 ? drills : BUILTIN_DRILLS;
  } catch {
    catalog = BUILTIN_DRILLS;
  }
  return catalog;
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

/** Mock Cortex Search: focus filter, then rank by keyword overlap (stable for ties). */
export function mockDrillSearch(query: string, opts: DrillSearchOptions, drills: Drill[] = drillCatalog()): Drill[] {
  const q = new Set(words(query));
  const pool = opts.focus ? drills.filter((d) => d.focus === opts.focus) : drills;
  return pool
    .map((d, i) => {
      const hay = words(`${d.title} ${d.focus} ${d.level} ${d.description} ${d.cues}`);
      return { d, i, score: hay.filter((w) => q.has(w)).length };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, Math.max(0, opts.limit))
    .map((x) => x.d);
}
