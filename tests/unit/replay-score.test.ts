// Scoring logic of the detector replay tool (tools/replay/score.ts) and the recording format.
import { describe, expect, test } from 'vitest'
import { GAMES, RECORDING_VERSION, gameOf, packPose, parseRecording, recordingFileName, unpackPose, type Recording, type RecordingSegment } from '../../src/dev/recordingFormat.ts'
import { autoTuneBoxing, emptyScores, formatScores, objective, replayTake, scoreTake, type DetectedEvent, type TakeEvents } from '../../tools/replay/score.ts'

const rec = (segments: RecordingSegment[]): Recording => ({
  version: RECORDING_VERSION, person: 'test', distanceM: 1.5, lighting: 'room', note: '', recordedAt: '2026-11-21T10:00:00.000Z',
  aspect: 4 / 3, inferenceMs: 12, frames: [], segments,
})
const take = (events: DetectedEvent[]): TakeEvents => ({ calibration: null, calibratedAt: 0, events, poseFrames: 0, frames: 0, fps: 30 })
const ev = (t: number, type: DetectedEvent['type'], detail: string = type): DetectedEvent => ({ t, type, detail })

describe('scoreTake', () => {
  test('count-based: reps vs same-type events, extras are false positives', () => {
    const r = rec([{ label: 'hook', startT: 0, endT: 10_000, reps: 3, marks: [] }])
    const s = scoreTake(r, take([ev(1000, 'hook'), ev(2000, 'hook'), ev(3000, 'hook'), ev(4000, 'hook')]))
    const m = s.byLabel.get('hook')!
    expect([m.reps, m.tp, m.fn, m.fp]).toEqual([3, 3, 0, 1])
  })

  test('marked reps match the nearest event within the window and record latency', () => {
    const r = rec([{ label: 'jab-L', startT: 0, endT: 10_000, reps: 3, marks: [1000, 3000, 5000] }])
    // 3000 has no event within 800 ms -> missed; the 9000 event is an extra.
    const s = scoreTake(r, take([ev(1120, 'jab-L', 'jab/left'), ev(5050, 'jab-L', 'cross/left'), ev(9000, 'jab-L', 'jab/left')]))
    const m = s.byLabel.get('jab-L')!
    expect([m.tp, m.fn, m.fp]).toEqual([2, 1, 1])
    expect(m.latencies).toEqual([120, 50])
    expect(m.kinds).toEqual({ jab: 2, cross: 1 })
  })

  test('other motions firing during a set are false positives for that motion and show in the confusion', () => {
    const r = rec([{ label: 'jab-R', startT: 0, endT: 5000, reps: 2, marks: [] }, { label: 'idle', startT: 6000, endT: 66_000, reps: 0, marks: [] }])
    const s = scoreTake(r, take([ev(1000, 'jab-R'), ev(1500, 'hook'), ev(2000, 'jab-R'), ev(30_000, 'duck'), ev(5800, 'uppercut')]))
    expect(s.byLabel.get('jab-R')!.tp).toBe(2)
    expect(s.byLabel.get('hook')!.fp).toBe(1)
    expect(s.byLabel.get('duck')!.fp).toBe(1)
    expect(s.confusion.get('jab-R')!.get('hook')).toBe(1)
    expect(s.confusion.get('idle')!.get('duck')).toBe(1)
    expect(s.idleMinutes).toBeCloseTo(1, 5)
    expect(s.unlabelled).toBe(1) // the 5800 uppercut is between sets
  })

  test('scores add up across takes and format as a table', () => {
    const s = emptyScores()
    scoreTake(rec([{ label: 'block', startT: 0, endT: 1000, reps: 1, marks: [] }]), take([ev(500, 'block')]), s)
    scoreTake(rec([{ label: 'block', startT: 0, endT: 1000, reps: 1, marks: [] }]), take([]), s)
    expect(s.byLabel.get('block')!.tp).toBe(1)
    expect(s.byLabel.get('block')!.fn).toBe(1)
    expect(formatScores(s)).toMatch(/\| block ⚠ \| 2 \| 1 \(50%\)/)
  })

  test('labels without a detector are listed as such', () => {
    const s = scoreTake(rec([{ label: 'bowl-swing', startT: 0, endT: 1000, reps: 5, marks: [] }]), take([]))
    expect(formatScores(s)).toMatch(/bowl-swing \| 5 \| no detector yet/)
  })
})

describe('recording format', () => {
  test('pack/unpack keeps stored joints to 3 decimals and drops the rest', () => {
    const f = {
      t: 1234.56,
      image: Array.from({ length: 33 }, (_, i) => ({ x: i / 40, y: 0.5, z: -0.12345, visibility: 0.876 })),
      world: Array.from({ length: 33 }, (_, i) => ({ x: i / 100, y: -0.2, z: 0.05, visibility: 0.9 })),
    }
    const back = unpackPose(packPose(f))!
    expect(back.t).toBeCloseTo(1234.6, 5)
    expect(back.image[15].x).toBeCloseTo(15 / 40, 3)
    expect(back.image[15].visibility).toBeCloseTo(0.88, 5)
    expect(back.image[5].visibility).toBe(0) // face joints are not stored
    expect(unpackPose(packPose(null))).toBeNull()
  })

  test('parse rejects other versions and unknown labels; file names are safe', () => {
    expect(() => parseRecording(JSON.stringify({ ...rec([]), version: 9 }))).toThrow(/version/)
    expect(() => parseRecording(JSON.stringify(rec([{ label: 'cartwheel' as never, startT: 0, endT: 1, reps: 1, marks: [] }])))).toThrow(/label/)
    expect(recordingFileName({ person: 'Ana Ito!', recordedAt: '2026-11-21T10:00:00.000Z', segments: [{ label: 'jab-L', startT: 0, endT: 1, reps: 1, marks: [] }] }))
      .toBe('ana-ito_jab-L_2026-11-21T10-00-00.json')
  })

  test('a take with no pose never calibrates and detects nothing', () => {
    const t = replayTake({ ...rec([]), frames: [null, null, null] })
    expect(t.calibration).toBeNull()
    expect(t.events).toEqual([])
  })
})

describe('games and training', () => {
  test('gameOf uses the game field, else infers it from the labels', () => {
    expect(gameOf({ game: 'bowling', segments: [] })).toBe('bowling')
    expect(gameOf({ segments: [{ label: 'idle', startT: 0, endT: 1, reps: 0, marks: [] }, { label: 'archery-draw', startT: 0, endT: 1, reps: 1, marks: [] }] })).toBe('archery')
    expect(gameOf({ segments: [{ label: 'idle', startT: 0, endT: 1, reps: 0, marks: [] }] })).toBeNull()
    expect(recordingFileName({ game: 'archery', person: 'Bo', recordedAt: '2026-11-21T10:00:00.000Z', segments: [] })).toBe('archery_bo_empty_2026-11-21T10-00-00.json')
  })

  test('scoring with a game type filter ignores other games\' detections', () => {
    const r = rec([{ label: 'idle', startT: 0, endT: 60_000, reps: 0, marks: [] }])
    const s = scoreTake(r, take([ev(1000, 'archery-draw'), ev(2000, 'hook')]), emptyScores(), GAMES.boxing.labels)
    expect(s.confusion.get('idle')!.get('hook')).toBe(1)
    expect(s.confusion.get('idle')!.has('archery-draw')).toBe(false)
  })

  test('objective: mean F1 over scored motions minus an idle penalty', () => {
    const r = rec([{ label: 'hook', startT: 0, endT: 5000, reps: 2, marks: [] }, { label: 'idle', startT: 6000, endT: 66_000, reps: 0, marks: [] }])
    const perfect = scoreTake(r, take([ev(1000, 'hook'), ev(2000, 'hook')]))
    expect(objective(perfect, GAMES.boxing.labels)).toBeCloseTo(1, 5)
    const noisy = scoreTake(r, take([ev(1000, 'hook'), ev(2000, 'hook'), ev(30_000, 'hook')]))
    expect(objective(noisy, GAMES.boxing.labels)).toBeLessThan(1)
  })

  test('auto-tune keeps the config when nothing improves (no pose in the take)', async () => {
    const r = { ...rec([{ label: 'jab-L', startT: 0, endT: 100, reps: 3, marks: [] }]), frames: [null, null] }
    const steps: string[] = []
    const res = await autoTuneBoxing([r], GAMES.boxing.labels, {}, 1, (s) => { steps.push(s.key) })
    expect(res.config).toEqual({})
    expect(res.after).toBe(res.before)
    expect(steps.length).toBeGreaterThan(10)
  })
})
