import { describe, expect, test } from 'vitest'
import { createFrameClock, createMediaPipeClock } from '../../src/pose/frameClock.ts'

describe('frame clock', () => {
  test('uses the camera capture time when the browser gives one', () => {
    const c = createFrameClock()
    expect(c.stamp(1050, { captureTime: 1010, mediaTime: 3 })).toBe(1010)
  })

  test('maps mediaTime so uneven delivery keeps even spacing', () => {
    const c = createFrameClock()
    // Camera frames every 33.3 ms; the callback runs 5 to 25 ms late, unevenly.
    const lates = [5, 25, 8, 20, 6, 24]
    const stamps = lates.map((late, i) => c.stamp(1000 + i * 33.3 + late, { mediaTime: (i * 33.3) / 1000 }))
    const gaps = stamps.slice(2).map((s, i) => s - stamps[i + 1])
    for (const g of gaps) expect(g).toBeCloseTo(33.3, 1)
  })

  test('falls back to the callback time and stays strictly increasing', () => {
    const c = createFrameClock()
    expect(c.stamp(100)).toBe(100)
    expect(c.stamp(100)).toBeGreaterThan(100)
    expect(c.stamp(90, { captureTime: 95 })).toBeGreaterThan(100)
  })

  test('ignores a capture time from another clock', () => {
    const c = createFrameClock()
    expect(c.stamp(5000, { captureTime: 10 })).toBe(5000)
  })
})

describe('createMediaPipeClock', () => {
  test('whole milliseconds, strictly increasing, even for stamps 0.001 ms apart', () => {
    const c = createMediaPipeClock()
    // Same camera frame twice (FrameClock bumps it by 0.001 ms), then a normal next frame.
    const out = [6318.0004, 6318.0014, 6318.4, 6333.7, 6333.2].map((t) => c.next(t))
    expect(out).toEqual([6318, 6319, 6320, 6333, 6334])
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1])
    expect(out.every(Number.isInteger)).toBe(true)
  })

  test('a non-finite stamp still advances; reset starts over', () => {
    const c = createMediaPipeClock()
    expect(c.next(100)).toBe(100)
    expect(c.next(Number.NaN)).toBe(101)
    c.reset()
    expect(c.next(5)).toBe(5)
  })
})
