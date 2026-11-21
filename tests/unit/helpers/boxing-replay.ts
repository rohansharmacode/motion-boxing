// Recorded webcam pose clips for the boxing detector: the JSON fixture format, (de)serialisation, and a
// replay that runs the same chain as the game (body tracker with BOXING_FILTER -> boxing detector).
// Written by tests/record-boxing.ts, replayed by tests/unit/boxing-replay.test.ts. No vitest imports here.
import { createBodyTracker } from '../../../src/pose/body.ts'
import type { Calibration, Joint, PoseFrame } from '../../../src/pose/types.ts'
import { BOXING_FILTER, createBoxingDetector, type BoxingDetectorConfig } from '../../../src/sports/boxing/detector.ts'
import type { Punch, PunchKind, SlipKind } from '../../../src/sports/boxing/types.ts'

export const FIXTURE_VERSION = 1

/** One raw PoseFrame: [t, image (33 x [x, y, z, visibility]), world (same)], or null when no pose was found. */
export type PackedFrame = [number, number[], number[]] | null

export interface BoxingFixture {
  version: typeof FIXTURE_VERSION
  /** e.g. "jab", "hook", "idle-sway". */
  label: string
  /** What the person actually did in the clip. Omitted kinds are expected to be 0. */
  expected: { punches: Partial<Record<PunchKind, number>> }
  lighting: string
  distanceM: number
  recordedAt: string
  /** The calibration the live game computed for this person before the clip. */
  calibration: Calibration
  frames: PackedFrame[]
}

const round = (v: number): number => Math.round(v * 1e4) / 1e4

function packJoints(js: Joint[]): number[] {
  const out: number[] = []
  for (const p of js) out.push(round(p.x), round(p.y), round(p.z), round(p.visibility ?? 0))
  return out
}

function unpackJoints(flat: number[]): Joint[] {
  const out: Joint[] = []
  for (let i = 0; i < flat.length; i += 4) out.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2], visibility: flat[i + 3] })
  return out
}

export function packFrame(f: PoseFrame | null): PackedFrame {
  return f ? [round(f.t), packJoints(f.image), packJoints(f.world)] : null
}

export function unpackFrame(p: PackedFrame): PoseFrame | null {
  return p ? { t: p[0], image: unpackJoints(p[1]), world: unpackJoints(p[2]) } : null
}

export interface ReplayResult {
  punches: Punch[]
  counts: Record<PunchKind, number>
  /** Frames with the guard held. */
  guardFrames: number
  /** Distinct slip / duck onsets. */
  slips: SlipKind[]
  frames: number
}

/** Replays a fixture through a fresh body tracker and detector (optionally with config overrides). */
export function replayFixture(fx: BoxingFixture, config: Partial<BoxingDetectorConfig> = {}): ReplayResult {
  const tracker = createBodyTracker(fx.calibration, BOXING_FILTER)
  const detector = createBoxingDetector(config)
  const punches: Punch[] = []
  const slips: SlipKind[] = []
  let guardFrames = 0
  let lastSlip: SlipKind | null = null
  for (const packed of fx.frames) {
    const actions = detector.update(tracker.push(unpackFrame(packed)))
    punches.push(...actions.punches)
    if (actions.guard) guardFrames++
    if (actions.slip && actions.slip !== lastSlip) slips.push(actions.slip)
    lastSlip = actions.slip
  }
  const counts = { jab: 0, cross: 0, hook: 0, uppercut: 0 } as Record<PunchKind, number>
  for (const p of punches) counts[p.kind] = (counts[p.kind] ?? 0) + 1
  return { punches, counts, guardFrames, slips, frames: fx.frames.length }
}

export function parseFixture(json: string): BoxingFixture {
  const fx = JSON.parse(json) as BoxingFixture
  if (fx.version !== FIXTURE_VERSION) throw new Error(`fixture version ${String(fx.version)}, expected ${FIXTURE_VERSION}`)
  if (!fx.calibration || !Array.isArray(fx.frames)) throw new Error('fixture needs calibration and frames')
  return fx
}
