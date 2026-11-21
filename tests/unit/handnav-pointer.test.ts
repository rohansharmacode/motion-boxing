import { describe, expect, it } from 'vitest'
import { DeadZone, pointerFromPose, rectDistance } from '../../src/handnav/pointer.ts'
import type { Joint } from '../../src/pose/types.ts'

const J = (x: number, y: number, visibility = 1): Joint => ({ x, y, z: 0, visibility })

/** Upper body facing the camera, square video. Shoulders at y 0.5, 0.2 apart. */
function pose(over: Record<number, Joint> = {}): Joint[] {
  const out: Joint[] = Array.from({ length: 33 }, () => J(0, 0, 0))
  out[11] = J(0.4, 0.5) // player's left shoulder (mirrored image: left side of the screen)
  out[12] = J(0.6, 0.5)
  out[15] = J(0.4, 0.95) // wrists down by the sides
  out[16] = J(0.6, 0.95)
  for (const [k, v] of Object.entries(over)) out[Number(k)] = v
  return out
}

describe('pointerFromPose', () => {
  it('returns null when no hand is raised', () => {
    expect(pointerFromPose(pose(), 1, 1, null)).toBeNull()
  })

  it('returns null without both shoulders', () => {
    expect(pointerFromPose(pose({ 11: J(0.4, 0.5, 0.1), 16: J(0.7, 0.4) }), 1, 1, null)).toBeNull()
  })

  it('tracks a raised right hand and moves the cursor with it', () => {
    const a = pointerFromPose(pose({ 16: J(0.7, 0.45) }), 1, 1, null)
    const b = pointerFromPose(pose({ 16: J(0.75, 0.45) }), 1, 1, null)
    expect(a?.hand).toBe('right')
    expect(b!.x).toBeGreaterThan(a!.x)
    const c = pointerFromPose(pose({ 16: J(0.7, 0.35) }), 1, 1, null)
    expect(c!.y).toBeLessThan(a!.y)
  })

  it('puts a hand at the box centre in the middle of the screen', () => {
    // Right box centre: x = 0.5 + 0.7 * 0.2 = 0.64, y = 0.5 + 0.1 * 0.2 = 0.52.
    const p = pointerFromPose(pose({ 16: J(0.64, 0.52) }), 1, 1, null)!
    expect(p.x).toBeCloseTo(0.5, 2)
    expect(p.y).toBeCloseTo(0.5, 2)
  })

  it('clamps to the screen edge', () => {
    const p = pointerFromPose(pose({ 16: J(0.99, 0.05) }), 1, 1, null)!
    expect(p.x).toBe(1)
    expect(p.y).toBe(0)
  })

  it('picks the higher hand, then sticks with it while it stays raised', () => {
    const both = pose({ 15: J(0.35, 0.4), 16: J(0.65, 0.3) })
    expect(pointerFromPose(both, 1, 1, null)?.hand).toBe('right')
    expect(pointerFromPose(both, 1, 1, 'left')?.hand).toBe('left')
  })

  it('leans toward a tracked index fingertip', () => {
    const wristOnly = pointerFromPose(pose({ 16: J(0.64, 0.52) }), 1, 1, null)!
    const withIndex = pointerFromPose(pose({ 16: J(0.64, 0.52), 20: J(0.68, 0.48) }), 1, 1, null)!
    expect(withIndex.x).toBeGreaterThan(wristOnly.x)
    expect(withIndex.y).toBeLessThan(wristOnly.y)
  })
})

describe('DeadZone', () => {
  it('ignores jitter inside the radius', () => {
    const dz = new DeadZone(7)
    dz.apply(100, 100)
    expect(dz.apply(104, 103)).toEqual({ x: 100, y: 100 })
  })

  it('follows bigger moves minus the radius', () => {
    const dz = new DeadZone(7)
    dz.apply(100, 100)
    const p = dz.apply(120, 100)
    expect(p.x).toBeCloseTo(113, 5)
    expect(p.y).toBe(100)
  })

  it('reset jumps to the next point', () => {
    const dz = new DeadZone(7)
    dz.apply(0, 0)
    dz.reset()
    expect(dz.apply(500, 500)).toEqual({ x: 500, y: 500 })
  })
})

describe('rectDistance', () => {
  const r = { left: 10, top: 10, right: 30, bottom: 20 }
  it('is 0 inside', () => expect(rectDistance(r, 15, 15)).toBe(0))
  it('measures to the nearest edge', () => expect(rectDistance(r, 40, 15)).toBe(10))
  it('measures to the nearest corner', () => expect(rectDistance(r, 33, 24)).toBe(5))
})
