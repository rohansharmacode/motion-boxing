// @vitest-environment happy-dom
// Goalkeeper keyboard fallback: arrow keys glide a goal-plane target and switch fallback mode on.
import { afterEach, describe, expect, test } from 'vitest'
import {
  KEY_FAST,
  KEY_HOME,
  KEY_SPEED,
  KEY_X_MAX,
  KEY_Y_MAX,
  KEY_Y_MIN,
  createKeeperInput,
  stepKeyTarget,
} from '../../src/sports/goalkeeper/input.ts'
import type { KeeperInput, KeyState } from '../../src/sports/goalkeeper/input.ts'

const none: KeyState = { left: false, right: false, up: false, down: false, fast: false }

describe('stepKeyTarget', () => {
  test('right arrow moves +x at KEY_SPEED', () => {
    const t = { x: 0, y: 1 }
    stepKeyTarget(t, { ...none, right: true }, 0.1)
    expect(t.x).toBeCloseTo(KEY_SPEED * 0.1)
    expect(t.y).toBe(1)
  })

  test('shift is faster', () => {
    const t = { x: 0, y: 1 }
    stepKeyTarget(t, { ...none, left: true, fast: true }, 0.1)
    expect(t.x).toBeCloseTo(-KEY_FAST * 0.1)
  })

  test('diagonals are normalised', () => {
    const t = { x: 0, y: 1 }
    stepKeyTarget(t, { ...none, right: true, up: true }, 0.1)
    expect(Math.hypot(t.x, t.y - 1)).toBeCloseTo(KEY_SPEED * 0.1)
  })

  test('opposite keys cancel, no time means no move', () => {
    const t = { x: 0.5, y: 1 }
    stepKeyTarget(t, { ...none, left: true, right: true }, 0.1)
    stepKeyTarget(t, { ...none, up: true }, 0)
    expect(t).toEqual({ x: 0.5, y: 1 })
  })

  test('clamped to the goal', () => {
    const t = { x: 0, y: 1 }
    stepKeyTarget(t, { ...none, right: true, up: true }, 10)
    expect(t.x).toBe(KEY_X_MAX)
    expect(t.y).toBe(KEY_Y_MAX)
    stepKeyTarget(t, { ...none, left: true, down: true }, 10)
    expect(t.x).toBe(-KEY_X_MAX)
    expect(t.y).toBe(KEY_Y_MIN)
  })
})

describe('createKeeperInput keyboard', () => {
  let input: KeeperInput | null = null
  afterEach(() => input?.dispose())

  function make(onToggle?: (on: boolean) => void): KeeperInput {
    const canvas = document.createElement('canvas')
    document.body.append(canvas)
    input = createKeeperInput({ canvas, screenToGoal: (x, y) => ({ x: x * 3, y: 1 + y }), onToggle })
    return input
  }
  const key = (type: 'keydown' | 'keyup', code: string) => window.dispatchEvent(new KeyboardEvent(type, { code }))

  test('an arrow key turns fallback mode on and starts at home', () => {
    const toggles: boolean[] = []
    const inp = make((on) => toggles.push(on))
    expect(inp.mouseOn).toBe(false)
    key('keydown', 'ArrowRight')
    expect(inp.mouseOn).toBe(true)
    expect(toggles).toEqual([true])
    expect(inp.target()).toEqual({ x: KEY_HOME.x, y: KEY_HOME.y })
  })

  test('held keys move the target each update, released keys stop it', () => {
    const inp = make()
    key('keydown', 'ArrowRight')
    inp.update(100)
    const after = inp.target()?.x ?? 0
    expect(after).toBeCloseTo(KEY_SPEED * 0.1)
    key('keyup', 'ArrowRight')
    inp.update(100)
    expect(inp.target()?.x).toBeCloseTo(after)
  })

  test('target() reuses one object (no per-frame allocation)', () => {
    const inp = make()
    key('keydown', 'ArrowUp')
    const a = inp.target()
    inp.update(16)
    expect(inp.target()).toBe(a)
  })
})
