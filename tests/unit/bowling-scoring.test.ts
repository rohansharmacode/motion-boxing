import { describe, expect, it } from 'vitest'
import { frameMarks, frameTotals, recordRoll } from '../../src/sports/bowling/game.ts'
import type { Frames } from '../../src/sports/bowling/game.ts'

function play(rolls: number[]): Frames {
  const frames: Frames = []
  let rack = 0
  let standing = 10
  for (const k of rolls) {
    const r = recordRoll(frames, k, rack, standing, false)
    if (r.resetPins) {
      rack = 0
      standing = 10
    } else {
      rack++
      standing -= k
    }
  }
  return frames
}

describe('bowling scoring (3 frames)', () => {
  it('perfect game is 90', () => {
    const f = play([10, 10, 10, 10, 10])
    expect(frameTotals(f)).toEqual([30, 60, 90])
    expect(frameMarks(f[2], true)).toEqual(['X', 'X', 'X'])
  })
  it('spare then open', () => {
    const f = play([7, 3, 4, 2, 9, 0])
    expect(frameTotals(f)).toEqual([14, 20, 29])
    expect(frameMarks(f[0], false)).toEqual(['7', '/'])
  })
  it('last frame spare gets a bonus ball', () => {
    const f = play([0, 0, 0, 0, 5, 5, 10])
    expect(frameTotals(f)).toEqual([0, 0, 20])
    expect(recordRoll(play([0, 0, 0, 0, 5]), 4, 1, 5, false).gameOver).toBe(true)
  })
  it('strike is pending until two more balls', () => {
    expect(frameTotals(play([10, 3]))).toEqual([null, null, null])
  })
})
