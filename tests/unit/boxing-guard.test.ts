// Guard stamina, bot defence (guard, dodge with tell, guard break) and how the boxing engine uses them.
import { describe, expect, test } from 'vitest'
import { BOT_GUARD, PLAYER_GUARD, createGuardMeter } from '../../src/sports/boxing/guard.ts'
import { BOT_DEFENCE, catchesDodge, createBotDefence } from '../../src/sports/boxing/botDefence.ts'
import { createBoxingEngine } from '../../src/sports/boxing/engine.ts'
import type {
  BoxingActions,
  BoxingDetector,
  BoxingHud,
  BoxingScene,
  BotStance,
  GuardMeterView,
  Punch,
  PunchKind,
  Telemetry,
} from '../../src/sports/boxing/types.ts'
import type { Calibration } from '../../src/pose/types.ts'

/** Scripted random: returns values in order, then repeats the last one. */
function scripted(...values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

/** Run a bot or meter in 10 ms steps. */
function step(fn: (dt: number, now: number) => void, ms: number, start = 0): number {
  let now = start
  for (let t = 0; t < ms; t += 10) {
    now += 10
    fn(10, now)
  }
  return now
}

describe('guard meter', () => {
  test('starts full and drains by the block cost', () => {
    const g = createGuardMeter(PLAYER_GUARD)
    expect(g.fraction).toBe(1)
    expect(g.block(30)).toBe('blocked')
    expect(g.value).toBe(70)
    expect(g.canBlock).toBe(true)
  })

  test('waits regenDelayMs after a block, then refills', () => {
    const g = createGuardMeter(PLAYER_GUARD)
    g.block(50)
    g.update(PLAYER_GUARD.regenDelayMs - 10, false)
    expect(g.value).toBe(50)
    g.update(10, false)
    g.update(1000, false)
    expect(g.value).toBeCloseTo(50 + PLAYER_GUARD.regenPerSec, 5)
    g.update(60_000, false)
    expect(g.value).toBe(PLAYER_GUARD.max)
  })

  test('refills slower while the guard is held', () => {
    const open = createGuardMeter(PLAYER_GUARD)
    const held = createGuardMeter(PLAYER_GUARD)
    for (const g of [open, held]) {
      g.block(60)
      g.update(PLAYER_GUARD.regenDelayMs, false)
    }
    open.update(1000, false)
    held.update(1000, true)
    expect(held.value - 40).toBeCloseTo((open.value - 40) * PLAYER_GUARD.heldRegenFactor, 5)
  })

  test('breaks at 0, stuns for breakMs, then comes back part full', () => {
    const g = createGuardMeter(PLAYER_GUARD)
    expect(g.block(60)).toBe('blocked')
    expect(g.block(60)).toBe('broke')
    expect(g.broken).toBe(true)
    expect(g.canBlock).toBe(false)
    expect(g.brokenMs).toBe(PLAYER_GUARD.breakMs)
    // No regen during the stun, and further blocks do nothing.
    g.update(PLAYER_GUARD.breakMs - 1, false)
    expect(g.value).toBe(0)
    expect(g.block(10)).toBe('broke')
    g.update(1, false)
    expect(g.broken).toBe(false)
    expect(g.fraction).toBeCloseTo(PLAYER_GUARD.recoverFraction, 5)
  })

  test('reset refills and clears a stun', () => {
    const g = createGuardMeter(BOT_GUARD)
    g.block(1000)
    g.reset()
    expect(g.broken).toBe(false)
    expect(g.value).toBe(BOT_GUARD.max)
  })
})

describe('bot defence', () => {
  /** Bot with its guard up: one decision at 0 (raise), long hold. */
  function guardedBot() {
    const bot = createBotDefence(scripted(0, 1))
    step((dt, now) => bot.update(dt, now), BOT_DEFENCE.decideEveryMs + BOT_DEFENCE.guardRaiseMs + 20)
    return bot
  }

  test('raises a guard with a visible raise before it protects', () => {
    const bot = createBotDefence(scripted(0, 1))
    step((dt, now) => bot.update(dt, now), BOT_DEFENCE.decideEveryMs + 10)
    expect(bot.stance.guard).toBe('raising')
    expect(bot.onPunch('jab', 500).kind).toBe('open')
    step((dt, now) => bot.update(dt, now), BOT_DEFENCE.guardRaiseMs, 500)
    expect(bot.stance.guard).toBe('up')
    expect(bot.onPunch('jab', 800)).toEqual({ kind: 'blocked', broke: false })
  })

  test('never raises a guard when the dice say no', () => {
    const bot = createBotDefence(scripted(0.99))
    step((dt, now) => bot.update(dt, now), 10_000)
    expect(bot.stance.guard).toBe('down')
  })

  test('guard chance rises with player pressure but stays capped', () => {
    // With 0.3 the bot only raises once it has seen enough recent punches.
    const calm = createBotDefence(scripted(0.99, 0.99, 0.99, 0.3))
    step((dt, now) => calm.update(dt, now), BOT_DEFENCE.decideEveryMs * 4 + 10)
    expect(calm.stance.guard).toBe('down')
    const pressed = createBotDefence(scripted(0.99, 0.99, 0.99, 0.3))
    for (let i = 0; i < 4; i++) pressed.onPunch('jab', 100 + i, false)
    step((dt, now) => pressed.update(dt, now), BOT_DEFENCE.decideEveryMs * 4 + 10, 100)
    expect(pressed.stance.guard).not.toBe('down')
    expect(BOT_DEFENCE.guardBase + BOT_DEFENCE.guardPerPressure * 50).toBeGreaterThan(BOT_DEFENCE.guardMax)
  })

  test('wild misses never drain the guard', () => {
    const bot = guardedBot()
    expect(bot.onPunch('uppercut', 1000, false).kind).toBe('open')
    expect(bot.guard.value).toBe(BOT_GUARD.max)
  })

  test('blocked punches drain stamina by kind and the guard breaks into a stun', () => {
    const bot = guardedBot()
    expect(bot.onPunch('jab', 700)).toEqual({ kind: 'blocked', broke: false })
    expect(bot.guard.value).toBe(BOT_GUARD.max - BOT_DEFENCE.blockCost.jab)
    let broke = false
    let n = 0
    while (!broke && n < 20) {
      const r = bot.onPunch('uppercut', 710 + n++)
      broke = r.kind === 'blocked' && r.broke
    }
    expect(broke).toBe(true)
    expect(n).toBe(Math.ceil((BOT_GUARD.max - BOT_DEFENCE.blockCost.jab) / BOT_DEFENCE.blockCost.uppercut))
    expect(bot.stance).toMatchObject({ guard: 'down', broken: true })
    // Stunned: open to everything and it does not defend.
    expect(bot.onPunch('jab', 900).kind).toBe('open')
    step((dt, now) => bot.update(dt, now), BOT_GUARD.breakMs - 20, 900)
    expect(bot.stance.guard).toBe('down')
    expect(bot.stance.dodge).toBeNull()
    step((dt, now) => bot.update(dt, now), 40, 900 + BOT_GUARD.breakMs)
    expect(bot.stance.broken).toBe(false)
  })

  test('guard drops after its hold and leaves a guaranteed opening', () => {
    const bot = createBotDefence(scripted(0, 0, 0))
    let now = step((dt, n) => bot.update(dt, n), BOT_DEFENCE.decideEveryMs + BOT_DEFENCE.guardHoldMinMs + 20)
    expect(bot.stance.guard).toBe('down')
    now = step((dt, n) => bot.update(dt, n), BOT_DEFENCE.guardCooldownMs - 20, now)
    expect(bot.stance.guard).toBe('down')
  })

  test('dodges only after a punch, with a tell where it can still be hit', () => {
    // 0.99: no guard; 0: dodge roll succeeds; 0: sway (not duck).
    const bot = createBotDefence(scripted(0, 0, 0.99))
    expect(bot.onPunch('jab', 0).kind).toBe('open') // the punch it reacts to still lands
    expect(bot.stance.dodgePhase).toBe('tell')
    expect(bot.onPunch('jab', 5).kind).toBe('open') // tell: still hittable
    let now = step((dt, n) => bot.update(dt, n), BOT_DEFENCE.tellMs + 10, 5)
    expect(bot.stance.dodgePhase).toBe('active')
    const dodge = bot.stance.dodge
    expect(dodge === 'sway-left' || dodge === 'sway-right').toBe(true)
    expect(bot.onPunch('cross', now)).toEqual({ kind: 'evaded', dodge })
    expect(bot.onPunch('hook', now)).toEqual({ kind: 'caught', dodge })
    now = step((dt, n) => bot.update(dt, n), BOT_DEFENCE.activeMs + BOT_DEFENCE.recoverMs + 20, now)
    expect(bot.stance.dodge).toBeNull()
    // Cooldown: no new dodge right away, even with a sure roll.
    bot.onPunch('jab', now)
    expect(bot.stance.dodge).toBeNull()
  })

  test('ducks under hooks; uppercuts catch a duck', () => {
    const bot = createBotDefence(scripted(0))
    bot.onPunch('hook', 0)
    expect(bot.stance.dodge).toBe('duck')
    const now = step((dt, n) => bot.update(dt, n), BOT_DEFENCE.tellMs + 10)
    expect(bot.onPunch('jab', now).kind).toBe('evaded')
    expect(bot.onPunch('uppercut', now).kind).toBe('caught')
  })

  test('no dodge or guard while busy attacking; a tell is cancelled', () => {
    const bot = createBotDefence(scripted(0))
    bot.onPunch('jab', 0)
    expect(bot.stance.dodgePhase).toBe('tell')
    bot.setBusy(true)
    expect(bot.stance.dodge).toBeNull()
    bot.onPunch('jab', 10)
    expect(bot.stance.dodge).toBeNull()
    step((dt, n) => bot.update(dt, n), 3000, 10)
    expect(bot.stance.guard).toBe('down')
  })

  test('dodge chance grows with repeats of the same punch and is capped', () => {
    // Roll 0.2 is above the base chance but below base + repeats.
    const roll = BOT_DEFENCE.dodgeBase + 0.05
    const bot = createBotDefence(scripted(roll))
    bot.onPunch('jab', 0)
    expect(bot.stance.dodge).toBeNull()
    bot.onPunch('jab', 3000)
    bot.onPunch('jab', 6000)
    expect(bot.stance.dodge).not.toBeNull()
    expect(BOT_DEFENCE.dodgeMax).toBeLessThan(0.5)
  })

  test('catchesDodge rules', () => {
    expect(catchesDodge('sway-left', 'hook')).toBe(true)
    expect(catchesDodge('sway-right', 'jab')).toBe(false)
    expect(catchesDodge('duck', 'uppercut')).toBe(true)
    expect(catchesDodge('duck', 'hook')).toBe(false)
  })
})

// ---------- engine ----------

const CALIBRATION = { shoulderWidth: 0.3 } as unknown as Calibration
const noop = (): void => {}

function fakeScene(hitAlways = true) {
  const calls = { guard: [] as boolean[], meters: null as null | [GuardMeterView, GuardMeterView], stance: null as BotStance | null, droneHits: 0, playerHits: [] as boolean[] }
  const scene = {
    canvas: {} as HTMLCanvasElement,
    quality: 'low',
    resize: noop,
    setBody: noop,
    punch: noop,
    resolveHit: () => (hitAlways ? { target: 'head', accuracy: 100 } : null),
    setGuard: (on: boolean) => calls.guard.push(on),
    setSlip: noop,
    droneTelegraph: noop,
    droneStrike: noop,
    droneHit: () => calls.droneHits++,
    playerHit: (b: boolean) => calls.playerHits.push(b),
    droneKO: noop,
    setGuardMeters: (p: GuardMeterView, b: GuardMeterView) => (calls.meters = [p, b]),
    setBotStance: (s: BotStance) => (calls.stance = s),
    resetRound: noop,
    hitstop: noop,
    update: noop,
    render: noop,
    setTimeScale: noop,
    setQuality: noop,
    dispose: noop,
  } as unknown as BoxingScene
  return { scene, calls }
}

function fakeHud() {
  const callouts: string[] = []
  const hp = { player: 100, drone: 100 }
  const hud = new Proxy({} as BoxingHud, {
    get(_, key) {
      if (key === 'callout') return (t: string) => callouts.push(t)
      if (key === 'setHp') return (p: number, d: number) => Object.assign(hp, { player: p, drone: d })
      if (key === 'playerName') return ''
      return noop
    },
  })
  return { hud, callouts, hp }
}

const telemetry: Telemetry = {
  playerId: 'p',
  sessionId: 's',
  startRound: noop,
  emit: (i) => ({ ...i }) as never,
}
const detector: BoxingDetector = { update: () => ({ punches: [], guard: false, slip: null, debug: {} }), reset: noop }

function punch(kind: PunchKind): Punch {
  return { kind, hand: 'right', t: 0, peakVelocity: 5, elbowAngle: 170, source: 'keyboard' }
}
const act = (over: Partial<BoxingActions>): BoxingActions => ({ punches: [], guard: false, slip: null, debug: {}, ...over })

function setup(random: () => number, hitAlways = true) {
  const { scene, calls } = fakeScene(hitAlways)
  const { hud, callouts, hp } = fakeHud()
  const engine = createBoxingEngine({ hud, telemetry, detector, random })
  engine.init(scene, CALIBRATION)
  engine.startRound()
  return { engine, calls, callouts, hp }
}

describe('boxing engine guard and bot defence', () => {
  test('pushes both guard meters and the bot stance to the scene', () => {
    const { engine, calls } = setup(() => 0.99)
    engine.update(16)
    expect(calls.meters).toEqual([
      { fraction: 1, broken: false },
      { fraction: 1, broken: false },
    ])
    expect(calls.stance).toMatchObject({ guard: 'down', dodge: null })
  })

  test('repeated blocks break the player guard, then the drone hits at full damage', () => {
    // 0.99 keeps the bot from guarding or dodging; patterns come from the same stream (always slam).
    const { engine, calls, callouts } = setup(() => 0.99)
    engine.onActions(act({ guard: true }))
    let broken = false
    for (let i = 0; i < 6000 && !broken; i++) {
      engine.update(10)
      broken = callouts.includes('GUARD BROKEN')
    }
    expect(broken).toBe(true)
    expect(calls.guard.at(-1)).toBe(false) // the scene drops the gloves
    // The guard comes back after the stun and the gloves go back up.
    for (let i = 0; i < 400; i++) engine.update(10)
    expect(Number(engine.debug.playerGuard)).toBeGreaterThan(0)
    expect(calls.guard.at(-1)).toBe(true)
  })

  test('a bot dodge makes straight punches miss and a hook into the sway lands as a counter', () => {
    // First draw is the dodge roll on the first jab (0 = dodge), then the sway pick, then high values.
    const { engine, callouts, hp } = setup(scripted(0, 0.5, 0.99))
    engine.onActions(act({ punches: [punch('jab')] }))
    const afterFirst = hp.drone
    expect(afterFirst).toBeLessThan(100) // the punch it reacts to lands
    for (let i = 0; i < 25; i++) engine.update(10) // through the tell
    engine.onActions(act({ punches: [punch('cross')] }))
    expect(hp.drone).toBe(afterFirst)
    expect(callouts.at(-1)).toMatch(/TRY A HOOK/)
    engine.onActions(act({ punches: [punch('hook')] }))
    expect(hp.drone).toBeLessThan(afterFirst)
  })

  test('punches into the bot guard only chip, and breaking it stops its attacks', () => {
    // 0.99 for pattern/gap picks never matters before the guard decision at 450 ms; 0 raises the guard.
    const { engine, callouts, hp } = setup(scripted(0, 0, 0))
    for (let i = 0; i < 70; i++) engine.update(10)
    expect(engine.debug.botStance).toBe('up')
    engine.onActions(act({ punches: [punch('cross')] }))
    expect(100 - hp.drone).toBeLessThan(1.5)
    expect(callouts.at(-1)).toBe('BLOCKED')
    for (let i = 0; i < 10 && !callouts.includes('GUARD BREAK'); i++) engine.onActions(act({ punches: [punch('uppercut')] }))
    expect(callouts).toContain('GUARD BREAK')
    expect(engine.debug.attack).toBe('-')
    for (let i = 0; i < 150; i++) engine.update(10)
    expect(engine.debug.attack).toBe('-') // stunned: no telegraph
  })
})
