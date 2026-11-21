// Online 1v1: two boxing engines wired back to back through an in-memory link (no network).
import { describe, expect, test } from 'vitest'
import { createBoxingEngine } from '../../src/sports/boxing/engine.ts'
import type { BoxingActions, BoxingEngine, BoxingHud, BoxingScene, Punch, RoundResult, SlipKind, Telemetry } from '../../src/sports/boxing/types.ts'
import type { Calibration } from '../../src/pose/types.ts'

/** Any method call is a no-op; resolveHit always lands dead centre on the head. */
function fake<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (t, k) => (k in t ? (t as Record<PropertyKey, unknown>)[k] : () => undefined),
  })
}

const telemetry: Telemetry = { playerId: 'p', sessionId: 's', startRound() {}, emit: (i) => i as never }
const detector = { update: (): BoxingActions => ({ punches: [], guard: false, slip: null, debug: {} }), reset() {} }

interface Side {
  engine: BoxingEngine
  hp: { player: number; drone: number }
  ends: RoundResult[]
}

function side(): Side {
  const hp = { player: 100, drone: 100 }
  const hud = fake<BoxingHud>({
    setHp: (p: number, d: number) => {
      hp.player = p
      hp.drone = d
    },
    playerName: 'x',
  })
  const scene = fake<BoxingScene>({ resolveHit: () => ({ target: 'head', accuracy: 100 }) })
  const engine = createBoxingEngine({ hud, telemetry, detector, random: () => 0.5 })
  engine.init(scene, {} as Calibration)
  const s: Side = { engine, hp, ends: [] }
  engine.onRoundEnd((r) => s.ends.push(r))
  return s
}

/** a and b in a room; messages are delivered at the next tick, like a fast LAN. */
function pair(): { a: Side; b: Side; tick: (ms: number) => void } {
  const a = side()
  const b = side()
  const queue: (() => void)[] = []
  a.engine.setVersus({ sendPunch: (p) => queue.push(() => b.engine.incomingPunch(p)), sendDefence: (d) => queue.push(() => b.engine.punchResolved(d)) })
  b.engine.setVersus({ sendPunch: (p) => queue.push(() => a.engine.incomingPunch(p)), sendDefence: (d) => queue.push(() => a.engine.punchResolved(d)) })
  a.engine.startRound()
  b.engine.startRound()
  const tick = (ms: number): void => {
    for (let t = 0; t < ms; t += 16) {
      for (const f of queue.splice(0)) f()
      a.engine.update(16)
      b.engine.update(16)
    }
    for (const f of queue.splice(0)) f()
  }
  return { a, b, tick }
}

const punch = (kind: Punch['kind'] = 'cross'): BoxingActions => ({
  punches: [{ kind, hand: 'right', t: 0, peakVelocity: 5, elbowAngle: 170, source: 'keyboard' }],
  guard: false,
  slip: null,
  debug: {},
})
const hold = (guard: boolean, slip: SlipKind | null): BoxingActions => ({ punches: [], guard, slip, debug: {} })

describe('online 1v1 engine', () => {
  test('no drone attacks: the opponent is the only threat', () => {
    const { a, tick } = pair()
    tick(10_000)
    expect(a.hp.player).toBe(100)
  })

  test('an undefended punch lands after the telegraph and both screens agree on health', () => {
    const { a, b, tick } = pair()
    a.engine.onActions(punch('cross'))
    tick(700)
    expect(b.hp.player).toBe(100) // still telegraphing (1 s wind-up)
    tick(500)
    expect(b.hp.player).toBe(92)
    expect(a.hp.drone).toBe(92)
  })

  test('a slip dodges a straight and a guard cuts the damage', () => {
    const { a, b, tick } = pair()
    b.engine.onActions(hold(false, 'left'))
    a.engine.onActions(punch('jab'))
    tick(1300)
    expect(b.hp.player).toBe(100)
    b.engine.onActions(hold(true, null))
    a.engine.onActions(punch('cross'))
    tick(1300)
    expect(b.hp.player).toBeCloseTo(98.4, 5)
    expect(a.hp.drone).toBeCloseTo(98.4, 5)
  })

  test('only one punch in flight: spamming does not stack damage', () => {
    const { a, b, tick } = pair()
    a.engine.onActions(punch())
    a.engine.onActions(punch())
    a.engine.onActions(punch())
    tick(1300)
    expect(b.hp.player).toBe(92)
  })

  test('KO: the defender loses and the attacker wins', () => {
    const { a, b, tick } = pair()
    for (let i = 0; i < 13 && b.ends.length === 0; i++) {
      a.engine.onActions(punch('uppercut'))
      tick(1300)
    }
    tick(2000)
    expect(b.ends[0]?.outcome).toBe('ko-loss')
    expect(a.ends[0]?.outcome).toBe('ko-win')
  })
})
