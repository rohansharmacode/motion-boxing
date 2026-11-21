// Replays real webcam pose clips (tests/fixtures/boxing/*.json, recorded with /tests/record-boxing.html)
// through the same body tracker + detector chain as the game, and checks the detected punches.
// jab.json, hook.json and idle-sway.json are the required clips; missing ones show up as todo.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import type { PoseFrame } from '../../src/pose/types.ts'
import { FIXTURE_VERSION, packFrame, parseFixture, replayFixture, unpackFrame, type BoxingFixture } from './helpers/boxing-replay.ts'

const DIR = fileURLToPath(new URL('../fixtures/boxing/', import.meta.url))
const REQUIRED = ['jab', 'hook', 'idle-sway']
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : []

describe('recorded webcam clips', () => {
  for (const name of REQUIRED) {
    if (!files.includes(`${name}.json`)) test.todo(`${name}.json: record it with /tests/record-boxing.html`)
  }

  for (const file of files) {
    const fx = parseFixture(readFileSync(DIR + file, 'utf8'))
    const want = fx.expected.punches
    const wantTotal = Object.values(want).reduce((a, b) => a + (b ?? 0), 0)
    test(`${file}: ${wantTotal ? JSON.stringify(want) : 'no punches'} (${fx.lighting}, ${fx.distanceM} m, ${fx.frames.length} frames)`, () => {
      const r = replayFixture(fx)
      const got = r.punches.map((p) => `${p.kind}/${p.hand}@${Math.round(p.t)}`)
      if (wantTotal === 0) {
        expect(got, 'idle movement must not fire punches').toEqual([])
        return
      }
      for (const [kind, n] of Object.entries(want)) expect(r.counts[kind as keyof typeof r.counts], `${kind} count; detected ${got.join(', ')}`).toBe(n)
      expect(r.punches.length, `no extra punches; detected ${got.join(', ')}`).toBe(wantTotal)
    })
  }
})

describe('fixture format', () => {
  const frame: PoseFrame = {
    t: 1234.56789,
    image: Array.from({ length: 33 }, (_, i) => ({ x: i / 33, y: 0.5, z: -0.1, visibility: 0.9 })),
    world: Array.from({ length: 33 }, (_, i) => ({ x: i / 100, y: -0.2, z: 0.05, visibility: 0.9 })),
  }

  test('pack/unpack round-trips to 4 decimals and keeps null frames', () => {
    const back = unpackFrame(packFrame(frame))!
    expect(back.t).toBeCloseTo(frame.t, 4)
    expect(back.image).toHaveLength(33)
    expect(back.world[10].x).toBeCloseTo(0.1, 4)
    expect(back.image[5].visibility).toBeCloseTo(0.9, 4)
    expect(unpackFrame(packFrame(null))).toBeNull()
  })

  test('replay of a clip with no pose detects nothing', () => {
    const fx: BoxingFixture = {
      version: FIXTURE_VERSION,
      label: 'empty',
      expected: { punches: {} },
      lighting: 'none',
      distanceM: 0,
      recordedAt: '2026-11-21T00:00:00Z',
      calibration: { aspect: 4 / 3, shoulderWidth: 0.25, shoulderWidthWorld: 0.36, torsoCenter: { x: 0.667, y: 0.45 }, neutralNose: { x: 0.667, y: 0.3 } },
      frames: [null, null, null],
    }
    const r = replayFixture(fx)
    expect(r.punches).toEqual([])
    expect(r.frames).toBe(3)
  })

  test('rejects a fixture from another format version', () => {
    expect(() => parseFixture(JSON.stringify({ version: 99, calibration: {}, frames: [] }))).toThrow(/version/)
  })
})
