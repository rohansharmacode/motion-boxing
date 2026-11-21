// Ping Pulse table tennis: the shared racket engine with a table-sized config.
import type { GameContext, GameSession } from '../../shell/types.ts'
import { startRacket } from '../racket/index.ts'
import type { RacketConfig } from '../racket/index.ts'

export const TABLE_TENNIS: RacketConfig = {
  id: 'tabletennis',
  title: 'PING PULSE',
  kicker: 'TABLE TENNIS · FIRST TO 7',
  blurb: 'Move your hand to the ball and flick it as the ball reaches you. Swing sideways to aim.',
  length: 2.74,
  width: 1.525,
  surfaceY: 0.76,
  netH: 0.1525,
  ballR: 0.02,
  slowmo: 0.55,
  flight: [0.45, 0.9],
  reach: 0.32,
  travel: 0.85,
  arc: 0.12,
  bounce: 0.88,
  camera: { y: 1.45, back: 1.25, lookZ: -0.6, fov: 52 },
  aiSpeed: 2.2,
  aiError: 0.12,
  score: 'tabletennis',
  surfaceColor: 0x10235e,
  floorColor: 0x0a0d1f,
}

export const startTableTennis = (ctx: GameContext): Promise<GameSession> => startRacket(ctx, TABLE_TENNIS)
