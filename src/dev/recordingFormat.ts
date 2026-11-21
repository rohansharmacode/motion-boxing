// Motion recordings for detector tuning: the JSON format written by the motion lab (/record.html, src/dev/recordPage.ts)
// and read by the replay tool (tools/replay-detectors.ts). Pure: no DOM, safe to import from Node.
//
// A recording is one "take": raw PoseFrames from camera start (so the replay runs the real calibrator too),
// plus labelled segments. Each segment says what the person was doing between startT and endT, how many reps
// they did, and (optionally) the time of each rep, marked by the operator with a key.
import type { Joint, PoseFrame } from '../pose/types.ts'

export const RECORDING_VERSION = 1

/** Labels the recorder can mark. 'idle' means: no detector should fire. */
export const MOTION_LABELS = [
  'jab-L', 'jab-R', 'hook', 'uppercut', 'block', 'dodge-L', 'dodge-R', 'duck',
  'keeper-dive-L', 'keeper-dive-R', 'archery-draw', 'archery-release', 'bowl-swing', 'idle',
] as const
export type MotionLabel = (typeof MOTION_LABELS)[number]

export type GameId = 'boxing' | 'goalkeeper' | 'archery' | 'bowling'

/** Games on the record/train page, the motions to record for each, and whether a detector exists to train. */
export const GAMES: Record<GameId, { name: string; labels: MotionLabel[]; detector: boolean; howTo: Partial<Record<MotionLabel, string>> }> = {
  boxing: {
    name: 'Boxing',
    labels: ['jab-L', 'jab-R', 'hook', 'uppercut', 'block', 'dodge-L', 'dodge-R', 'duck', 'idle'],
    detector: true,
    howTo: {
      'jab-L': 'Straight punch with your own LEFT hand (jab or cross both count)',
      'jab-R': 'Straight punch with your own RIGHT hand',
      hook: 'Hook, either hand',
      uppercut: 'Uppercut, either hand',
      block: 'Drop the hands, then raise the guard to your face',
      'dodge-L': 'Slip your head to your own left, then back',
      'dodge-R': 'Slip your head to your own right, then back',
      duck: 'Duck down, then back up',
      idle: '30 to 60 s of NOT punching: shift weight, talk, touch your face, adjust the laptop',
    },
  },
  goalkeeper: {
    name: 'Goalkeeper',
    labels: ['keeper-dive-L', 'keeper-dive-R', 'idle'],
    detector: false,
    howTo: {
      'keeper-dive-L': 'Lunge / reach to your own left as if saving a shot',
      'keeper-dive-R': 'Lunge / reach to your own right',
      idle: '30 to 60 s of normal standing and shuffling, no saves',
    },
  },
  archery: {
    name: 'Archery',
    labels: ['archery-draw', 'archery-release', 'idle'],
    detector: true,
    howTo: {
      'archery-draw': 'Raise the bow arm and draw back to full draw (then let down or release)',
      'archery-release': 'Full draw, hold, then release by snapping the draw hand back',
      idle: '30 to 60 s of arms moving normally, no drawing',
    },
  },
  bowling: {
    name: 'Bowling',
    labels: ['bowl-swing', 'idle'],
    detector: false,
    howTo: {
      'bowl-swing': 'Full bowling arm swing and release',
      idle: '30 to 60 s of normal movement, no swings',
    },
  },
}

/**
 * Joints stored per frame (MediaPipe indices): nose, then shoulders down to ankles. Every detector and the
 * calibrator use only these; faces, hands and feet are dropped to keep files small. Others unpack as invisible.
 */
export const STORED_JOINTS = [0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28] as const

/** [t ms, image joints, world joints], joints as integers: x, y, z * 1000 and visibility * 100. null = no pose. */
export type PackedPose = [number, number[], number[]] | null

export interface RecordingSegment {
  label: MotionLabel
  /** ms, same clock as the frames. */
  startT: number
  endT: number
  /** Reps the person actually did (typed in at the end of the segment). 0 for idle. */
  reps: number
  /** Optional rep moments (ms), marked with a key right as each rep happens. */
  marks: number[]
}

export interface Recording {
  version: typeof RECORDING_VERSION
  /** Game the take was recorded for (older takes: inferred from their labels). */
  game?: GameId
  /** Who and how: free text, used to group results. */
  person: string
  distanceM: number
  lighting: string
  note: string
  recordedAt: string
  /** Video width / height. */
  aspect: number
  /** Mean pose inference time while recording, ms. */
  inferenceMs: number
  frames: PackedPose[]
  segments: RecordingSegment[]
}

function packJoints(js: Joint[]): number[] {
  const out: number[] = []
  for (const i of STORED_JOINTS) {
    const p = js[i]
    out.push(Math.round((p?.x ?? 0) * 1000), Math.round((p?.y ?? 0) * 1000), Math.round((p?.z ?? 0) * 1000), Math.round((p?.visibility ?? 0) * 100))
  }
  return out
}

function unpackJoints(flat: number[]): Joint[] {
  const out: Joint[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }))
  STORED_JOINTS.forEach((idx, k) => {
    out[idx] = { x: flat[k * 4] / 1000, y: flat[k * 4 + 1] / 1000, z: flat[k * 4 + 2] / 1000, visibility: flat[k * 4 + 3] / 100 }
  })
  return out
}

export function packPose(f: PoseFrame | null): PackedPose {
  return f ? [Math.round(f.t * 10) / 10, packJoints(f.image), packJoints(f.world)] : null
}

/** null frames carry no time, so the caller passes the previous frame's t (the replay only needs order). */
export function unpackPose(p: PackedPose): PoseFrame | null {
  return p ? { t: p[0], image: unpackJoints(p[1]), world: unpackJoints(p[2]) } : null
}

export function parseRecording(json: string): Recording {
  const r = JSON.parse(json) as Recording
  if (r.version !== RECORDING_VERSION) throw new Error(`recording version ${String(r.version)}, expected ${RECORDING_VERSION}`)
  if (!Array.isArray(r.frames) || !Array.isArray(r.segments)) throw new Error('recording needs frames and segments')
  for (const s of r.segments) {
    if (!(MOTION_LABELS as readonly string[]).includes(s.label)) throw new Error(`unknown label ${s.label}`)
  }
  return r
}

/** The take's game: its own field, else the first game whose labels include a non-idle segment label. */
export function gameOf(r: Pick<Recording, 'game' | 'segments'>): GameId | null {
  if (r.game) return r.game
  for (const s of r.segments) {
    if (s.label === 'idle') continue
    for (const [id, g] of Object.entries(GAMES)) if (g.labels.includes(s.label)) return id as GameId
  }
  return null
}

/** File-safe name: game_person_labels_date. */
export function recordingFileName(r: Pick<Recording, 'game' | 'person' | 'recordedAt' | 'segments'>): string {
  const who = r.person.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'anon'
  const labels = [...new Set(r.segments.map((s) => s.label))].join('+') || 'empty'
  const stamp = r.recordedAt.replace(/[:.]/g, '-').slice(0, 19)
  return `${r.game ? `${r.game}_` : ''}${who}_${labels}_${stamp}.json`.slice(0, 120)
}
