// Hands off to the real camera-based game (repo root app), which opens the sport from ?play=.
export type RealGame = 'boxing' | 'goalkeeper' | 'leaderboard';
const BASE: string = import.meta.env.VITE_GAME_URL ?? '/';
export function realGameUrl(game: RealGame): string {
  return `${BASE}?play=${game}&theme=bright&style=mii`;
}
export function launchRealGame(game: RealGame): void {
  location.assign(realGameUrl(game));
}
