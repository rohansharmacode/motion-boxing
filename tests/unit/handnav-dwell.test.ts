import { describe, expect, it } from 'vitest'
import { DwellTracker } from '../../src/handnav/dwell.ts'

const cfg = { dwellMs: 1200, cooldownMs: 700, graceMs: 220, maxStepMs: 100 }

/** Feeds target every frameMs from t0 to t1 (inclusive) and returns every result. */
function hold<T>(d: DwellTracker<T>, target: T | null, t0: number, t1: number, frameMs = 16) {
  const out = []
  for (let t = t0; t <= t1; t += frameMs) out.push({ t, ...d.update(target, t) })
  return out
}

describe('DwellTracker', () => {
  it('fills over dwellMs and fires exactly once', () => {
    const d = new DwellTracker<string>(cfg)
    const res = hold(d, 'start', 0, 1400)
    const fired = res.filter((r) => r.fired)
    expect(fired).toHaveLength(1)
    expect(fired[0].fired).toBe('start')
    expect(fired[0].t).toBeGreaterThanOrEqual(1200)
    expect(fired[0].t).toBeLessThan(1230)
  })

  it('reports rising progress while hovering', () => {
    const d = new DwellTracker<string>(cfg)
    const res = hold(d, 'a', 0, 600, 20)
    expect(res.find((r) => r.t === 300)?.progress).toBeCloseTo(0.25, 2)
    expect(res.find((r) => r.t === 600)?.progress).toBeCloseTo(0.5, 2)
  })

  it('restarts when the target changes', () => {
    const d = new DwellTracker<string>(cfg)
    hold(d, 'a', 0, 900)
    const r = d.update('b', 916)
    expect(r.target).toBe('b')
    expect(r.progress).toBe(0)
    const res = hold(d, 'b', 932, 2300)
    expect(res.find((x) => x.fired)?.t).toBeGreaterThanOrEqual(916 + 1200)
  })

  it('keeps progress through a brief tracking dropout', () => {
    const d = new DwellTracker<string>(cfg)
    hold(d, 'a', 0, 600)
    const lost = d.update(null, 700)
    expect(lost.target).toBe('a')
    expect(lost.progress).toBeGreaterThan(0.4)
    const back = d.update('a', 800)
    expect(back.target).toBe('a')
    expect(back.progress).toBeGreaterThan(0.4)
  })

  it('drops progress when the target is lost longer than graceMs', () => {
    const d = new DwellTracker<string>(cfg)
    hold(d, 'a', 0, 600)
    d.update(null, 610)
    expect(d.update(null, 900).target).toBeNull()
    expect(d.update('a', 916).progress).toBe(0)
  })

  it('does not count time while lost', () => {
    const d = new DwellTracker<string>(cfg)
    hold(d, 'a', 0, 1000)
    d.update(null, 1016)
    d.update(null, 1150)
    // 1 s on target, 150 ms lost: not done yet.
    expect(d.update('a', 1166).fired).toBeNull()
  })

  it('waits for the cooldown and for the cursor to leave before the same target fires again', () => {
    const d = new DwellTracker<string>(cfg)
    const first = hold(d, 'a', 0, 1300).find((r) => r.fired)
    expect(first).toBeDefined()
    // Still on 'a' long after the cooldown: never fires again without leaving.
    const stay = hold(d, 'a', 1316, 4000)
    expect(stay.some((r) => r.fired)).toBe(false)
    expect(stay.every((r) => r.progress === 0)).toBe(true)
    // Leave, come back: fills again.
    d.update(null, 4016)
    d.update(null, 4300)
    const again = hold(d, 'a', 4316, 5600)
    expect(again.filter((r) => r.fired)).toHaveLength(1)
  })

  it('ignores a new target during the cooldown', () => {
    const d = new DwellTracker<string>(cfg)
    const fired = hold(d, 'a', 0, 1300).find((r) => r.fired)!
    const r = d.update('b', fired.t + 100)
    expect(r.target).toBeNull()
    const res = hold(d, 'b', fired.t + 116, fired.t + 700 + 1300)
    expect(res.find((x) => x.fired)?.t).toBeGreaterThanOrEqual(fired.t + 700 + 1200)
  })

  it('caps one long frame so a stalled tab cannot complete a dwell', () => {
    const d = new DwellTracker<string>(cfg)
    d.update('a', 0)
    expect(d.update('a', 5000).fired).toBeNull()
  })

  it('reset clears progress', () => {
    const d = new DwellTracker<string>(cfg)
    hold(d, 'a', 0, 800)
    d.reset()
    expect(d.update('a', 816).progress).toBe(0)
  })
})
