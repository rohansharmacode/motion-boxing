// Grid Smash tennis: the shared racket engine with a court-sized config.
import type { GameContext, GameSession } from '../../shell/types.ts'
import { startRacket } from '../racket/index.ts'
import type { RacketConfig } from '../racket/index.ts'

export const TENNIS: RacketConfig = {
  id: 'tennis',
  title: 'GRID SMASH',
  kicker: 'TENNIS · FIRST TO 2 GAMES',
  blurb: 'Reach your hand toward the ball and swing hard as it arrives. Swing across your body to aim.',
  length: 23.77,
  width: 8.23,
  surfaceY: 0,
  netH: 0.914,
  ballR: 0.05,
  slowmo: 0.75,
  flight: [0.95, 1.7],
  reach: 1.4,
  travel: 4.6,
  arc: 0.7,
  bounce: 0.72,
  camera: { y: 2.4, back: 5.5, lookZ: -3, fov: 56 },
  aiSpeed: 7.5,
  aiError: 0.06,
  score: 'tennis',
  surfaceColor: 0x16408a,
  floorColor: 0x0a0d1f,
}

export const startTennis = (ctx: GameContext): Promise<GameSession> => startRacket(ctx, TENNIS)
