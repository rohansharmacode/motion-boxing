// Motion recordings for detector tuning: the JSON format written by the ?record=1 recorder (src/dev/recorder.ts)
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

/** File-safe name: person-label-date. */
export function recordingFileName(r: Pick<Recording, 'person' | 'recordedAt' | 'segments'>): string {
  const who = r.person.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'anon'
  const labels = [...new Set(r.segments.map((s) => s.label))].join('+') || 'empty'
  const stamp = r.recordedAt.replace(/[:.]/g, '-').slice(0, 19)
  return `${who}_${labels}_${stamp}.json`.slice(0, 120)
}
