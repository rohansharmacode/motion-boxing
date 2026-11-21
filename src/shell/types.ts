// Shell contract: the home dashboard, game selection and the hand-off to a sport.
// The shell owns src/shell/* only. Sports plug in through GameLauncher.

export type TileId = 'boxing' | 'goalkeeper' | 'archery' | 'bowling' | 'customise' | 'versus' | 'leaderboard'

/** What the shell gives a game when it starts. */
export interface GameContext {
  /** Empty full-screen layer the game may use. Sports that render into #stage / #ui can ignore it. */
  readonly host: HTMLElement
  /** Aborted when the player goes home. Use it to cancel async startup. */
  readonly signal: AbortSignal
  /** Ask the shell to return to the dashboard (for example from a "Home" button in the game). */
  exit(): void
}

/** A running game. dispose() must stop loops, listeners and the camera if the game owns it. */
export interface GameSession {
  dispose(): void
}

export type GameLauncher = (ctx: GameContext) => GameSession | Promise<GameSession>

export interface TileInfo {
  id: TileId
  title: string
  tagline: string
  /** Short how-to shown on the focused tile. */
  howTo: string
  /** CSS colour for the glow. */
  accent: string
  /** Second gradient stop. */
  accent2: string
  /** Inline SVG markup (static, original art). */
  icon: string
  /** Background artwork URL (public/art, already prefixed with the Vite base). */
  art: string
  /** Big hero tile. */
  featured?: boolean
}

export interface ShellOptions {
  /** Where the shell layer is appended. Default document.body. */
  root?: HTMLElement
  /** A tile is playable only when it has a launcher. Others show "Coming soon". */
  launchers: Partial<Record<TileId, GameLauncher>>
  /** Called after a game is disposed and the dashboard is back. */
  onHome?: () => void
}

export interface CursorPoint {
  /** 0 to 1 of the viewport width, already mirrored for a selfie view. */
  x: number
  /** 0 to 1 of the viewport height. */
  y: number
}

export interface Shell {
  /** Tile id of the running game, null on the dashboard. */
  readonly current: TileId | null
  launch(id: TileId): Promise<void>
  goHome(): void
  /** Feed a hand position to select tiles by hovering (dwell). null hides the cursor. */
  setCursor(p: CursorPoint | null): void
  dispose(): void
}
