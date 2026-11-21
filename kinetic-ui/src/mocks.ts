// All mock data lives here. Replace with real API data when wiring up.
import type { CoachCard, HudState, LeaderboardRow, Percentiles, RoundStats } from './types';

export const MOCK_PLAYER_ID = 'p_you';
export const MOCK_PLAYER_NAME = 'NOVA';

export const mockHud: HudState = {
  playerHp: 100,
  opponentHp: 100,
  timeLeftMs: 90_000,
  round: 1,
  combo: 0,
  guardPct: 80,
};

export const mockStats: RoundStats = {
  punches: 142,
  accuracyPct: 68,
  fastestPunch: 4.2,
  bestReactionMs: 212,
  guardPct: 74,
};

export const mockFinalScore = 18_420;

export const mockCoach: CoachCard = {
  headline: 'Fast hands. Now make them pay off.',
  tips: [
    'Your cross is 18% faster than your jab. Lead with the jab to set it up.',
    'Guard drops after each hook. Snap the hand back to your chin.',
    'Reactions slow by 40 ms in the last 20 s. Breathe out on every punch.',
  ],
  drill: { name: 'Jab-Cross Ladder', description: '3 rounds of 30 s: 1-2, 1-1-2, 1-2-1-2, guard up between sets.' },
  badge: { name: 'Lightning Cross', description: 'Threw a cross above 4.0 SW/s.' },
  formScore: 78,
  fallback: false,
};

export const mockCoachFallback: CoachCard = {
  headline: 'Solid round. Keep your fundamentals sharp.',
  tips: [
    'Keep both hands up between punches.',
    'Throw in combinations, not single shots.',
    'Move your head off the centre line after you punch.',
  ],
  drill: { name: 'Shadow Basics', description: '2 minutes of jab-cross with a guard reset after every pair.' },
  badge: { name: 'First Bell', description: 'Finished a full round.' },
  formScore: 60,
  fallback: true,
};

export const mockCoachLoadingLines = [
  'Crunching 142 punches in Snowflake',
  'Comparing you to pro benchmarks',
  'Asking the coach',
];

export const mockPercentiles: Percentiles = {
  punch_speed_mps: 72,
  reaction_ms: 81,
  accuracy_pct: 64,
  guard_pct: 55,
  symmetry_pct: 47,
  fatigue_drop_pct: 38,
};

const NAMES = ['VOLTA', 'KAI.EXE', 'RIZE', 'MOMO', 'SABLE', 'JETT', 'ORBIT', 'PIXEL', 'DRIFT', 'TANK', 'LUMA', 'ZERO', 'FLUX'];

export const mockLeaderboard: LeaderboardRow[] = NAMES.map((name, i) => ({
  rank: i + 1,
  player_id: `p_${i}`,
  name,
  score: 24_800 - i * 1_150 - (i % 3) * 90,
  fastest_punch: Math.round((4.8 - i * 0.12) * 10) / 10,
  best_reaction_ms: 168 + i * 9,
}));

/** Leaderboard with the player inside the top 10 (rank 4). */
export const mockLeaderboardWithPlayer: LeaderboardRow[] = (() => {
  const rows = mockLeaderboard.slice(0, 10).map((r) => ({ ...r }));
  rows.splice(3, 0, { rank: 4, player_id: MOCK_PLAYER_ID, name: MOCK_PLAYER_NAME, score: 21_500, fastest_punch: 4.2, best_reaction_ms: 212 });
  return rows.slice(0, 10).map((r, i) => ({ ...r, rank: i + 1 }));
})();

/** Player outside the top 10. */
export const mockPlayerRowOutside: LeaderboardRow = {
  rank: 23, player_id: MOCK_PLAYER_ID, name: MOCK_PLAYER_NAME, score: mockFinalScore, fastest_punch: 4.2, best_reaction_ms: 212,
};

export const mockGlobalStats = { totalPlayers: 1_284, totalPunches: 186_402, fastestPunchEver: 5.1 };

/** Simulate a leaderboard refresh: nudge scores and re-rank. */
export function shuffleLeaderboard(rows: LeaderboardRow[]): LeaderboardRow[] {
  const next = rows.map((r) => ({ ...r, score: r.score + (Math.random() < 0.35 ? Math.round(Math.random() * 1800) : 0) }));
  next.sort((a, b) => b.score - a.score);
  return next.map((r, i) => ({ ...r, rank: i + 1 }));
}
