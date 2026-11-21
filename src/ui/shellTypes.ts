// =====================================================================================
// TODO: replace with `import type { GameContext, GameSession } from '../shell/types'`
//       once src/shell lands (the home dashboard lives on a teammate's machine).
// =====================================================================================
// Minimal assumed shape. UI components only touch `root`, `exit()` and optional `player`,
// so swapping in the real types should be a one-line import change.

export interface GameContext {
  /** Element the game / screen mounts into. */
  root: HTMLElement;
  /** Return to the home dashboard. */
  exit(): void;
  player?: { id?: string; name: string };
}

export interface GameSession {
  dispose(): void;
}
