import '../theme/index.ts';
import '../theme/bright/ui.css';
import './styles.css';
import './components.css';

// Legacy function-style API (used by src/main.ts and src/dev/*).
export { showStartScreen, DEFAULT_SPORTS } from './startScreen';
export type { StartResult, SportOption } from './startScreen';
export { showCalibration, showCountdown } from './calibration';
export { createHud } from './hud';
export type { Hud, HudState, HudOptions } from './hud';
export { showPostMatch } from './postMatch';
export type { PostMatchAction, PostMatchOptions } from './postMatch';

// Class-based components.
export { CalibrationOverlay } from './CalibrationOverlay';
export type { CalibrationOverlayOptions, CalibrationState, CalibrationWarning } from './CalibrationOverlay';
export { BoxingHUD } from './BoxingHUD';
export type { BoxingHUDOptions, BoxingHUDState, PunchInfo, PopKind } from './BoxingHUD';
export { PostMatchScreen } from './PostMatchScreen';
export type { PostMatchScreenOptions } from './PostMatchScreen';
export { LeaderboardScreen, startLeaderboard } from './LeaderboardScreen';
export type { LeaderboardScreenOptions } from './LeaderboardScreen';
export type { GameContext, GameSession } from './shellTypes';

// Drop-in for the real game: implements src/sports/boxing/types.ts BoxingHud.
export { createKineticHud } from './KineticHud';
export type { KineticHudOptions } from './KineticHud';
