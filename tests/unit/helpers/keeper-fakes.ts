// Shared fakes for goalkeeper engine unit tests: a recording KeeperScene, a motion-event recorder,
// and synthetic BodyFrame builders (body space per src/pose/types.ts).
import type { KeeperScene } from '../../../src/sports/goalkeeper/types.ts'
import type { BodyFrame, Calibration, Joint } from '../../../src/pose/types.ts'
import type { KeeperMotionEvent } from '../../../src/sports/goalkeeper/types.ts'
import { GOAL_HALF_WIDTH } from '../../../src/sports/goalkeeper/physics.ts'

export interface SceneCall {
  name: string
  args: unknown[]
}

export type FakeScene = KeeperScene & { calls: SceneCall[]; count(name: string): number; last(name: string): SceneCall | undefined }

export function createFakeScene(): FakeScene {
  const calls: SceneCall[] = []
  const rec =
    (name: string) =>
    (...args: unknown[]): void => {
      // Deep-ish copy object args: the engine reuses its Vec3 / pose objects between frames.
      calls.push({ name, args: args.map((a) => (a && typeof a === 'object' ? JSON.parse(JSON.stringify(a)) : a)) })
    }
  const scene = {
    canvas: {} as HTMLCanvasElement,
    calls,
    count: (name: string) => calls.filter((c) => c.name === name).length,
    last: (name: string) => {
      for (let i = calls.length - 1; i >= 0; i--) if (calls[i].name === name) return calls[i]
      return undefined
    },
    resize: rec('resize'),
    setKeeper: rec('setKeeper'),
    setBall: rec('setBall'),
    setStriker: rec('setStriker'),
    flashSave: rec('flashSave'),
    flashGoal: rec('flashGoal'),
    highlightZone: rec('highlightZone'),
    shake: rec('shake'),
    screenToGoal: (x: number, y: number) => {
      calls.push({ name: 'screenToGoal', args: [x, y] })
      return { x: 0, y: 0 }
    },
    reset: rec('reset'),
    update: rec('update'),
    render: rec('render'),
    dispose: rec('dispose'),
  }
  return scene as FakeScene
}

/** Collects window 'motion-event' details. Call stop() in afterEach. */
export function recordMotionEvents(): { events: KeeperMotionEvent[]; stop(): void } {
  const events: KeeperMotionEvent[] = []
  const onEvent = (e: Event): void => {
    events.push((e as CustomEvent<KeeperMotionEvent>).detail)
  }
  window.addEventListener('motion-event', onEvent)
  return { events, stop: () => window.removeEventListener('motion-event', onEvent) }
}

// ---------- body frames ----------

const REACH_HALF_X = 1.4
const WORLD_Y_MID = (2.44 + 0.2) / 2
const WORLD_Y_HALF = (2.44 - 0.2) / 2

function invCurve(c: number): number {
  return Math.sign(c) * Math.pow(Math.abs(c), 1 / 0.85)
}

/** Inverse of mapping.bodyToGoal inside the reach box: goal-plane metres -> body space. */
export function goalToBody(x: number, y: number): { bx: number; by: number } {
  const ux = invCurve(x / GOAL_HALF_WIDTH)
  const uy = invCurve((y - WORLD_Y_MID) / WORLD_Y_HALF)
  return { bx: ux * REACH_HALF_X, by: 0.5 - ((uy + 1) / 2) * 1.6 }
}

export const TEST_CALIBRATION: Calibration = {
  aspect: 4 / 3,
  shoulderWidth: 0.3,
  shoulderWidthWorld: 0.38,
  torsoCenter: { x: 0.66, y: 0.4 },
  neutralNose: { x: 0.66, y: 0.22 },
}

function J(x: number, y: number, visibility = 1): Joint {
  return { x, y, z: 0, visibility }
}

/** A neutral-stance body with both gloves (wrist + index tip) at the given body-space points. */
export function bodyFrame(
  t: number,
  left: { bx: number; by: number },
  right: { bx: number; by: number },
): BodyFrame {
  const body: Joint[] = Array.from({ length: 33 }, () => J(0, 0, 0))
  body[0] = J(0, -0.6)
  body[11] = J(-0.5, 0)
  body[12] = J(0.5, 0)
  body[13] = J(-0.6, 0.3)
  body[14] = J(0.6, 0.3)
  body[15] = J(left.bx, left.by)
  body[16] = J(right.bx, right.by)
  body[19] = J(left.bx, left.by)
  body[20] = J(right.bx, right.by)
  body[23] = J(-0.35, 1.6)
  body[24] = J(0.35, 1.6)
  return {
    t,
    body,
    world: body.map((j) => ({ ...j })),
    neutralNose: { x: 0, y: -0.6 },
    scale: 1,
    calibration: TEST_CALIBRATION,
  }
}
