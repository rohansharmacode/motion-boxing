// Demo mode (M key): a fixed, believable KO round plus its coach card, for the live judged demo.
import type { Hand } from '../../pose/types.ts'
import type { AttackPattern, CoachCard, PunchCounts, PunchKind, RoundLog, RoundResult, Telemetry } from './types.ts'

export interface DemoRound {
  result: RoundResult
  log: RoundLog
  card: CoachCard
}

/** Same rules as the engine: an unblocked strike costs 12 HP, a block cuts it by 80 percent. */
const STRIKE_DAMAGE = 12
const BLOCK_FACTOR = 0.2

const KINDS: Record<string, PunchKind> = { j: 'jab', c: 'cross', h: 'hook', u: 'uppercut' }
const BASE_SPEED: Record<PunchKind, number> = { jab: 8.9, cross: 9.3, hook: 8.6, uppercut: 8.8 }

/**
 * Punch groups: start time (s), counter flag, tokens of kind + hand (L/R), "!" marks a miss.
 * Groups are more than 1.5 s apart, so each one starts a fresh combo.
 */
const GROUPS: Array<[number, boolean, string]> = [
  [2.6, false, 'jL jL! cR'],
  [6.3, false, 'jL cR! jL'],
  [9.1, false, 'jL cR jL hL!'],
  [12.0, true, 'uR hL cR'],
  [15.6, false, 'jL! jL cR'],
  [21.2, false, 'jL cR jL cR hL uR'],
  [25.7, true, 'cR hL'],
  [29.6, false, 'jL uL! cR'],
  [34.1, false, 'jL cR hR!'],
  [46.4, false, 'jL cR hL uR'],
]

/** Drone attacks: telegraph start (s), pattern, outcome, reaction ms. */
const DEFENCES: Array<[number, AttackPattern, 'blocked' | 'dodged' | 'hit', number | null]> = [
  [4.9, 'straight', 'blocked', 240],
  [11.4, 'hook', 'dodged', 210],
  [18.3, 'slam', 'hit', null],
  [25.1, 'straight', 'dodged', 190],
  [32.5, 'slam', 'blocked', 230],
  [38.2, 'hook', 'blocked', 260],
]

const round1 = (v: number): number => Math.round(v * 10) / 10
const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

function buildLog(): RoundLog {
  const punches: RoundLog['punches'] = []
  for (const [start, counter, tokens] of GROUPS) {
    let combo = 0
    tokens.split(' ').forEach((tok, i) => {
      const kind = KINDS[tok[0]]
      const hand: Hand = tok[1] === 'L' ? 'left' : 'right'
      const landed = !tok.endsWith('!')
      const t = Math.round(start * 1000 + i * (i % 2 ? 340 : 300))
      // Slight fatigue: about 0.8 SW/s slower by the end, with a small fixed wobble.
      const n = punches.length
      const speed = round1(BASE_SPEED[kind] - t / 60_000 + 0.18 * Math.sin(n * 2.3) + (counter ? 0.15 : 0))
      combo = landed ? combo + 1 : 0
      punches.push({ kind, hand, t, speed, landed, counter, combo })
    })
  }
  const defences = DEFENCES.map(([s, pattern, outcome, reactionMs]) => ({ pattern, t: Math.round(s * 1000), outcome, reactionMs }))
  return { roundMs: punches[punches.length - 1].t + 120, punches, defences, guardMs: 14_600 }
}

function buildResult(log: RoundLog): RoundResult {
  const counts: PunchCounts = { total: log.punches.length, jab: 0, cross: 0, hook: 0, uppercut: 0, landed: 0 }
  for (const p of log.punches) {
    counts[p.kind]++
    if (p.landed) counts.landed++
  }
  const count = (o: string): number => log.defences.filter((d) => d.outcome === o).length
  const blocks = count('blocked')
  const hitsTaken = count('hit')
  return {
    outcome: 'ko-win',
    playerHp: round1(100 - hitsTaken * STRIKE_DAMAGE - blocks * STRIKE_DAMAGE * BLOCK_FACTOR),
    droneHp: 0,
    counts,
    blocks,
    dodges: count('dodged'),
    hitsTaken,
    bestSpeed: Math.max(...log.punches.map((p) => p.speed)),
    accuracyPct: Math.round((counts.landed / counts.total) * 100),
    maxCombo: Math.max(...log.punches.map((p) => p.combo)),
  }
}

function buildCard(r: RoundResult, log: RoundLog): CoachCard {
  const secsLeft = Math.round((60_000 - log.roundMs) / 1000)
  const counters = log.punches.filter((p) => p.counter && p.landed).length
  const early = avg(log.punches.slice(0, 10).map((p) => p.speed)).toFixed(1)
  const late = avg(log.punches.slice(-10).map((p) => p.speed)).toFixed(1)
  return {
    badge: 'COUNTER SURGEON',
    headline: `KO with ${secsLeft} s to spare: ${r.counts.landed} of ${r.counts.total} landed (${r.accuracyPct} percent), top speed ${r.bestSpeed} SW/s.`,
    tips: [
      `Your ${r.maxCombo}-punch chain was the turning point. Open with the jab-cross like you did there, then let the hook and uppercut finish.`,
      `${r.dodges} dodges opened ${counters} counter punches and ${r.blocks} blocks kept the damage small. The one clean hit came from a slam: slip left or right instead of standing tall.`,
      `Hand speed slid from ${early} to ${late} SW/s across the round. Exhale on every punch and snap the hand back to guard to keep the pace.`,
    ],
    drill: 'Slip-and-return: 3 rounds of 30 s. Slip left, cross; slip right, hook; duck, uppercut. Rest 15 s between rounds.',
    source: 'demo',
  }
}

export function createDemoRound(): DemoRound {
  const log = buildLog()
  const result = buildResult(log)
  return { result, log, card: buildCard(result, log) }
}

/** Emit the whole demo round synchronously, in round order, so the dashboard and backend see a full round. */
export function emitDemoTelemetry(telemetry: Telemetry, demo: DemoRound, playerName: string): void {
  telemetry.startRound()
  const events = [
    ...demo.log.punches.map((p) => ({ t: p.t, punch: p, defence: null })),
    ...demo.log.defences.map((d) => ({ t: d.t, punch: null, defence: d })),
  ].sort((a, b) => a.t - b.t)

  let left = 0
  let right = 0
  for (const { punch: p, defence: d } of events) {
    if (p) {
      if (p.hand === 'left') left++
      else right++
      telemetry.emit({
        event_type: 'PUNCH',
        peak_velocity: p.speed,
        accuracy_score: p.landed ? 70 + (Math.round(p.t / 10) % 25) : 0,
        symmetry_ratio: Math.round((Math.min(left, right) / Math.max(left, right)) * 100) / 100,
        metrics: { punchType: p.kind, hand: p.hand, landed: p.landed, combo: p.combo, counter: p.counter, source: 'demo' },
      })
    } else if (d && d.outcome !== 'hit') {
      telemetry.emit({
        event_type: d.outcome === 'blocked' ? 'BLOCK' : 'DODGE',
        reaction_ms: d.reactionMs,
        metrics: { pattern: d.pattern, source: 'demo' },
      })
    }
  }
  telemetry.emit({ event_type: 'TICK', metrics: { summary: true, ...demo.result, playerName, source: 'demo' } })
}
