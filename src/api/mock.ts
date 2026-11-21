// Mock backend used when VITE_API_URL is empty, VITE_USE_MOCK=true, or the live API fails.
// The coach card is built from the player's real round stats, so it still feels personal.
// The mock leaderboard lives in localStorage and includes the player's own best scores.

import type {
  CoachCard,
  Highlight,
  HighlightsResponse,
  LeaderboardEntry,
  LeaderboardResponse,
  Player,
  SessionEndRequest,
  SessionEndResponse,
  Sport,
} from './types';

const LB_KEY = 'kr.mockLeaderboard.v2';
const BOARD_CAP = 50;

const SEED_NAMES = [
  'VoltJab',
  'Mx. Quickstep',
  'NeonNana',
  'Byte Brawler',
  'Kestrel',
  'Glitchfist',
  'Lumen',
  'Static Sam',
  'Orbit',
  'Juniper',
  'Paper Tiger',
  'Low Orbit Lou',
];

/** Per-sport scale so the seeded boards look different. */
const SPORT_BASE: Record<Sport, { top: number; step: number; speed: number }> = {
  BOXING: { top: 2460, step: 170, speed: 4.7 },
  GOALKEEPER: { top: 1980, step: 140, speed: 3.9 },
  ARCHERY: { top: 1720, step: 120, speed: 2.4 },
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

function seedBoard(sport: Sport): LeaderboardEntry[] {
  const b = SPORT_BASE[sport];
  return SEED_NAMES.map((name, i) => ({
    rank: i + 1,
    player_id: `seed-${sport.toLowerCase()}-${i}`,
    display_name: name,
    sport,
    // Deterministic wobble so the seed looks hand-made, not linear.
    score: Math.round(b.top - i * b.step + Math.sin(i * 7.3) * 45),
    max_speed: +(b.speed - i * 0.19 + Math.cos(i * 3.1) * 0.12).toFixed(1),
  }));
}

function readAll(): Partial<Record<Sport, LeaderboardEntry[]>> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LB_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Partial<Record<Sport, LeaderboardEntry[]>>) : {};
  } catch {
    return {};
  }
}

function loadBoard(sport: Sport): LeaderboardEntry[] {
  const board = readAll()[sport];
  return Array.isArray(board) && board.length ? board : seedBoard(sport);
}

function saveBoard(sport: Sport, board: LeaderboardEntry[]) {
  try {
    const all = readAll();
    all[sport] = board.slice(0, BOARD_CAP);
    localStorage.setItem(LB_KEY, JSON.stringify(all));
  } catch {
    /* storage full or disabled: fine for a mock */
  }
}

function rank(board: LeaderboardEntry[]): LeaderboardEntry[] {
  board.sort((a, b) => b.score - a.score || (b.max_speed ?? 0) - (a.max_speed ?? 0));
  board.forEach((e, i) => (e.rank = i + 1));
  return board;
}

/** Record a score on the local mock board, keeping only each player's best. */
export function recordMockScore(entry: Omit<LeaderboardEntry, 'rank'>): LeaderboardEntry[] {
  const board = loadBoard(entry.sport);
  const prev = board.find((e) => e.player_id === entry.player_id);
  if (!prev) board.push({ ...entry, rank: 0 });
  else {
    prev.display_name = entry.display_name;
    if (entry.score > prev.score) prev.score = entry.score;
    if ((entry.max_speed ?? 0) > (prev.max_speed ?? 0)) prev.max_speed = entry.max_speed;
  }
  rank(board);
  saveBoard(entry.sport, board);
  return board;
}

export async function mockLeaderboard(sport: Sport, limit = 10): Promise<LeaderboardResponse> {
  await sleep(jitter(150, 350));
  const entries = rank(loadBoard(sport)).slice(0, Math.max(1, limit));
  return { entries: entries.map((e) => ({ ...e })), source: 'mock' };
}

export function mockPlayer(displayName: string, playerId: string): Player {
  return { player_id: playerId, display_name: displayName, created_at: new Date().toISOString() };
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function buildCoach(req: SessionEndRequest, formScore: number): CoachCard {
  const s = req.stats;
  const accuracy = pct(s.landed, s.punches);
  const types = Object.entries(s.byType).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const top = types[0]?.[0]?.toLowerCase() ?? 'jab';
  const unused = (['JAB', 'CROSS', 'HOOK', 'UPPERCUT'] as const).filter((t) => !s.byType[t]);
  const guard = s.guardPct ?? null;
  const fatigue = s.fatigueTrend ?? null;
  const slips = s.slips ?? s.dodges;

  // Candidate tips, most important first; we keep the first 3.
  const tips: string[] = [];
  if (s.punches === 0) {
    tips.push('Throw first. Even a soft jab every second keeps the drone honest.');
  } else if (accuracy < 60) {
    tips.push(`Only ${accuracy}% of your punches landed. Wait for the red ring to fade before you fire.`);
  } else {
    tips.push(`${accuracy}% accuracy. Your ${top} is your best weapon, so build combos off it.`);
  }

  if (guard !== null && guard < 55) {
    tips.push(`Your guard was up ${guard}% of the round. Bring both gloves back to your cheeks after every punch.`);
  } else if (s.blocks < 3) {
    tips.push(`You blocked ${plural(s.blocks, 'time')}. Bring both gloves to your face when the drone charges.`);
  } else {
    tips.push(`${s.blocks} blocks${guard !== null ? ` and ${guard}% guard uptime` : ''}. Now counter straight after each block for the 1.5x window.`);
  }

  if (fatigue !== null && fatigue > 0.15) {
    tips.push(`Your late punches were ${Math.round(fatigue * 100)}% slower than your early ones. Breathe out on every punch and keep the pace even.`);
  }
  if (s.leftRightRatio !== null && (s.leftRightRatio < 0.7 || s.leftRightRatio > 1.4)) {
    const weak = s.leftRightRatio < 1 ? 'left' : 'right';
    tips.push(`Your ${weak} hand is doing less work. Aim for an even split between left and right.`);
  }
  if (slips === 0 && s.punches > 0) {
    tips.push('You never slipped. Move your head off the centre line when the drone winds up.');
  } else if (s.avgReactionMs !== null && s.avgReactionMs > 450) {
    tips.push(`Average reaction ${s.avgReactionMs} ms. Watch the drone's shoulders, not its fist, to react earlier.`);
  }
  if (unused.length >= 2 && s.punches >= 8) {
    tips.push(`No ${unused.map((t) => t.toLowerCase()).slice(0, 2).join(' or ')} this round. Mix levels so the drone can't read you.`);
  }
  if (s.maxSpeed > 0) {
    tips.push(`Peak speed ${s.maxSpeed.toFixed(1)} SW/s, average ${s.avgSpeed.toFixed(1)}. Snap back to guard to keep it up late in the round.`);
  }
  tips.push('Snap each punch back to your guard. Returning fast is as important as going out fast.');
  tips.push('Stay on the balls of your feet so you can slip and punch in the same beat.');

  const drill =
    guard !== null && guard < 55
      ? { name: 'Glove-Kiss Jabs', description: '3 x 30 s: jab, touch both gloves to your cheeks, repeat. Only count jabs that come back to guard.' }
      : slips === 0
        ? { name: 'Slip Ladder', description: '3 x 30 s: slip left, slip right, jab-cross. Keep your eyes on the drone the whole time.' }
        : fatigue !== null && fatigue > 0.15
          ? { name: 'Tempo Ladder', description: '5 x 20 s at a steady 2 punches per second, 10 s rest. Last set should be as fast as the first.' }
          : s.leftRightRatio !== null && (s.leftRightRatio < 0.7 || s.leftRightRatio > 1.4)
            ? { name: 'Mirror Combos', description: '3 x 30 s of 1-2-1-2 (jab-cross). Match the speed of both hands.' }
            : { name: 'Guard-Return Jabs', description: '3 x 30 s: jab, return both gloves to your cheeks, repeat. Count only jabs that come back to guard.' };

  const badge =
    s.maxSpeed >= 4
      ? { name: 'Neon Hammer', description: 'Top-tier hand speed.' }
      : guard !== null && guard >= 75
        ? { name: 'Iron Visor', description: 'Gloves up, chin down, all round long.' }
        : s.blocks >= 6
          ? { name: 'Iron Visor', description: 'Defence first, always.' }
          : s.bestCombo >= 5
            ? { name: 'Chain Reactor', description: 'Combos for days.' }
            : slips >= 5
              ? { name: 'Ghost Step', description: 'Hard to hit, harder to pin down.' }
              : { name: 'Spark Rookie', description: 'First steps in the Kinetic Ring.' };

  const headline = !s.punches
    ? 'A quiet round. Next time, let your hands go.'
    : formScore >= 80
      ? `Sharp round: ${s.punches} punches, ${accuracy}% landed, best combo x${s.bestCombo}.`
      : guard !== null && guard < 55
        ? `Fast hands, low guard: ${s.punches} punches but gloves up only ${guard}% of the time.`
        : `${s.punches} punches, ${s.landed} landed, best combo x${s.bestCombo}.`;

  return { headline, tips: tips.slice(0, 3), drill, badge };
}

export function mockFormScore(req: SessionEndRequest): number {
  const s = req.stats;
  const acc = s.punches ? s.landed / s.punches : 0;
  const guard = s.guardPct ?? null;
  const fatigue = s.fatigueTrend ?? 0;
  const balance = s.leftRightRatio === null ? 0.7 : Math.min(s.leftRightRatio, 1 / s.leftRightRatio);
  const score =
    30 +
    acc * 25 +
    Math.min(s.maxSpeed, 5) * 3 +
    (guard !== null ? (guard / 100) * 15 : Math.min(s.blocks, 6) * 2) +
    balance * 10 -
    Math.max(0, fatigue) * 20 +
    (s.punches ? 0 : -20);
  return Math.round(Math.max(5, Math.min(99, score)));
}

export async function mockSessionEnd(req: SessionEndRequest): Promise<SessionEndResponse> {
  await sleep(jitter(1200, 1800)); // pretend Cortex is thinking
  const board = recordMockScore({
    player_id: req.player_id,
    display_name: req.display_name,
    sport: req.sport,
    score: req.final_score,
    max_speed: req.stats.maxSpeed ? +req.stats.maxSpeed.toFixed(1) : null,
  });
  const form = mockFormScore(req);
  return {
    coach: buildCoach(req, form),
    leaderboard: board.slice(0, 10).map((e) => ({ ...e })),
    form_score: form,
    source: 'mock',
  };
}

// ---------- highlights feed ----------

/** Plausible highlights from the mock leaderboard (and this browser's own best), newest first. */
export async function mockHighlights(limit = 10): Promise<HighlightsResponse> {
  // No fake latency here: the home ticker remounts on every visit, and a pending timer per mount
  // would read as a leak (tests/unit/shell-lifecycle.test.ts counts timers).
  const board = rank(loadBoard('BOXING'));
  const now = Date.now();
  const kinds = ['speed_record', 'punch_milestone', 'reaction_record', 'personal_best_speed'] as const;
  const highlights: Highlight[] = board.slice(0, Math.max(1, limit)).map((e, i) => {
    const kind = kinds[i % kinds.length];
    const value =
      kind === 'punch_milestone' ? 100 * (5 - (i % 4)) : kind === 'reaction_record' ? 205 + i * 17 : Math.max(2.5, (e.max_speed ?? 4) - i * 0.05);
    return {
      highlight_id: `mock-${kind}-${e.player_id}`,
      created_at: new Date(now - (i * 4 + 1) * 60_000).toISOString(),
      kind,
      player_id: e.player_id,
      name: e.display_name,
      session_id: `mock-${i}`,
      value: Math.round(value * 100) / 100,
      unit: kind === 'punch_milestone' ? 'punches' : kind === 'reaction_record' ? 'ms' : 'SW/s',
      message: '',
    };
  });
  return { available: true, highlights, source: 'mock' };
}
