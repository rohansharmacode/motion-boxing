import { describe, expect, test } from 'vitest'
import { createQualityGovernor } from '../../src/pose/qualityGovernor.ts'

const feed = (g: ReturnType<typeof createQualityGovernor>, n: number, frameMs: number, inf = 10): string[] => {
  const changes: string[] = []
  for (let i = 0; i < n; i++) {
    const c = g.update(frameMs, inf)
    if (c) changes.push(c)
  }
  return changes
}

describe('quality governor', () => {
  test('stays high at 60 fps with fast tracking', () => {
    expect(feed(createQualityGovernor(), 600, 16.7)).toEqual([])
  })

  test('drops under 50 fps once the window fills', () => {
    const g = createQualityGovernor()
    expect(feed(g, 300, 25)).toEqual(['low'])
    expect(g.level).toBe('low')
  })

  test('drops when inference is over 45 ms even at 60 fps', () => {
    const g = createQualityGovernor()
    feed(g, 100, 16.7)
    expect(g.update(16.7, 50)).toBe('low')
  })

  test('climbs back after 30 fast frames, then needs twice as many next time', () => {
    const g = createQualityGovernor({ warmupMs: 0 })
    g.update(16, 60)
    expect(g.level).toBe('low')
    expect(feed(g, 29, 16)).toEqual([])
    expect(feed(g, 1, 16)).toEqual(['high'])
    g.update(16, 60)
    expect(feed(g, 59, 16)).toEqual([])
    expect(feed(g, 1, 16)).toEqual(['high'])
  })

  test('a slow frame resets the recovery run', () => {
    const g = createQualityGovernor({ warmupMs: 0 })
    g.update(16, 60)
    feed(g, 20, 16)
    feed(g, 1, 40)
    expect(feed(g, 29, 16)).toEqual([])
    expect(g.level).toBe('low')
  })

  test('ignores the warm-up (shader compiles)', () => {
    const g = createQualityGovernor()
    expect(feed(g, 20, 70)).toEqual([])
  })
})
