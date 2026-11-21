// Local rule-based coach: the fallback card when the Cortex coach is unreachable.
import type { AttackPattern, CoachCard, PunchKind, RoundLog, RoundResult } from './types.ts'

type Area = 'start' | 'output' | 'balance' | 'accuracy' | 'guard' | 'fatigue' | 'defence' | 'reaction' | 'mix' | 'combo' | 'counter' | 'polish'

interface Tip {
  area: Area
  /** 0 = fine, 1 = weakest. */
  severity: number
  text: string
}

const DRILLS: Record<Area, string> = {
  output: 'Busy hands: 3 rounds of 30 s nonstop jab cross at half power. Never let your hands rest.',
  start: 'Shadow box for 60 s: jab, cross, jab, cross, then reset your guard. Count every punch out loud.',
  balance: 'Mirror drill: 30 s left hand only, 30 s right hand only, then 30 s alternating at the same pace.',
  accuracy: 'Target drill: pick a spot on the wall and land 20 jabs and 20 crosses on it at full arm extension.',
  guard: 'Return drill: after every punch touch your glove to your cheek before the next one. 3 sets of 20.',
  fatigue: 'Sprint rounds: 15 s all-out punching, 15 s rest, 6 times. Hold the same speed on the last set.',
  defence: 'Call and dodge: a partner calls "straight", "hook" or "slam". Duck the hook, slip the slam, slip or duck the straight. 3 sets of 20 calls.',
  reaction: 'Flash drill: a partner raises a hand at random and you slip on sight. 3 sets of 15 reps.',
  mix: 'Ladder drill: jab, then jab cross, then jab cross hook, then jab cross hook uppercut. Repeat 5 times.',
  combo: 'Three-count drill: throw jab, cross, hook as one flowing chain, 10 chains, 3 sets.',
  counter: 'Slip and fire: slip left, throw a cross straight away. 3 sets of 10 each side.',
  polish: 'Champion round: one 60 s round at 80 percent speed, focusing on clean form on every punch.',
}

const PATTERN_FIX: Record<AttackPattern, string> = {
  straight: 'Slip left or right, or duck, the moment the ring lights up.',
  hook: 'Only a duck beats a hook, so bend your knees as soon as the ring glows.',
  slam: 'Ducking will not save you here. Move your head left or right instead.',
}

const pct = (x: number): number => Math.round(x * 100)
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

export function buildLocalCoachCard(result: RoundResult, log: RoundLog): CoachCard {
  const punches = log.punches
  const n = punches.length
  const roundMs = Math.max(1, log.roundMs)
  const minutes = roundMs / 60_000

  const left = punches.filter((p) => p.hand === 'left')
  const right = punches.filter((p) => p.hand === 'right')
  const balance = n ? Math.min(left.length, right.length) / Math.max(left.length, right.length) : 1
  const leftSpeed = avg(left.map((p) => p.speed))
  const rightSpeed = avg(right.map((p) => p.speed))
  const avgSpeed = avg(punches.map((p) => p.speed))

  const firstHalf = avg(punches.filter((p) => p.t < roundMs / 2).map((p) => p.speed))
  const secondHalf = avg(punches.filter((p) => p.t >= roundMs / 2).map((p) => p.speed))
  const decay = firstHalf > 0 && secondHalf > 0 ? (firstHalf - secondHalf) / firstHalf : 0

  const landed = punches.filter((p) => p.landed).length
  const accuracy = n ? landed / n : 0
  const counters = punches.filter((p) => p.counter).length
  const guardPct = clamp01(log.guardMs / roundMs)
  const perMinute = n / minutes

  const kinds: PunchKind[] = ['jab', 'cross', 'hook', 'uppercut']
  const kindCounts = kinds.map((k) => ({ k, c: punches.filter((p) => p.kind === k).length }))
  const top = kindCounts.reduce((a, b) => (b.c > a.c ? b : a))
  const topShare = n ? top.c / n : 0

  const defences = log.defences
  const saved = defences.filter((d) => d.outcome !== 'hit').length
  const defenceRate = defences.length ? saved / defences.length : 1
  const patterns: AttackPattern[] = ['straight', 'hook', 'slam']
  const worst = patterns
    .map((p) => {
      const all = defences.filter((d) => d.pattern === p)
      const hits = all.filter((d) => d.outcome === 'hit').length
      return { p, hits, total: all.length, rate: all.length ? hits / all.length : 0 }
    })
    .reduce((a, b) => (b.rate > a.rate || (b.rate === a.rate && b.hits > a.hits) ? b : a))
  const reactions = defences.flatMap((d) => (d.reactionMs === null ? [] : [d.reactionMs]))
  const reaction = avg(reactions)
  const maxCombo = result.maxCombo

  // Badge
  let badge = 'ALL-ROUNDER'
  if (result.outcome === 'ko-win') badge = 'DRONE BREAKER'
  else if (n === 0) badge = 'OPENING BELL'
  else if (counters >= 3) badge = 'COUNTER SNIPER'
  else if (n >= 6 && balance < 0.4) badge = 'ONE-HAND BANDIT'
  else if (guardPct >= 0.6 && defenceRate >= 0.6) badge = 'IRON GUARD'
  else if (avgSpeed >= 7) badge = 'SPEED DEMON'
  else if (perMinute >= 40) badge = 'PRESSURE ARTIST'

  // Headline: one fact about the hands, one about defence.
  let handFact: string
  if (n === 0) handFact = 'No punches thrown'
  else if (balance < 0.5) {
    const [main, side] = right.length >= left.length ? ['right', right.length] : ['left', left.length]
    handFact = `${pct(side / n)} percent of punches came from your ${main} hand`
  } else if (leftSpeed > 0 && rightSpeed > 0 && Math.abs(rightSpeed - leftSpeed) / Math.min(leftSpeed, rightSpeed) >= 0.1) {
    const fast = rightSpeed > leftSpeed ? 'Right' : 'Left'
    const diff = Math.abs(rightSpeed - leftSpeed) / Math.min(leftSpeed, rightSpeed)
    handFact = `${fast} hand ${pct(diff)} percent faster than your ${fast === 'Right' ? 'left' : 'right'}`
  } else handFact = `${n} punches at ${pct(accuracy)} percent accuracy`
  const headline = `${handFact}, guard up ${pct(guardPct)} percent of the round.`

  // Tips: candidates scored by weakness, best three win.
  const tips: Tip[] = []
  const add = (area: Area, severity: number, text: string): void => {
    tips.push({ area, severity: clamp01(severity), text })
  }
  if (n === 0) {
    add('start', 1, 'You did not throw a punch. Start with a jab in the first 3 seconds to find your range.')
  } else {
    if (n >= 4) {
      const [weak, count] = left.length <= right.length ? ['left', left.length] : ['right', right.length]
      add('balance', (1 - balance) * 1.2, `Your ${weak} hand threw only ${count} of ${n} punches. Double up with it to set up the other hand.`)
    }
    if (perMinute < 30) add('output', (30 - perMinute) / 30, `You threw ${n} punches. Aim for 30 a round by firing a jab every time the drone resets.`)
    add('accuracy', (0.75 - accuracy) / 0.5, `Only ${pct(accuracy)} percent of punches landed. Aim at the core and fully extend before pulling back.`)
    if (decay >= 0.1) add('fatigue', decay * 2, `Your speed dropped ${pct(decay)} percent in the second half. Breathe out on every punch and stay light on your feet.`)
    if (n >= 5 && topShare >= 0.6) add('mix', (topShare - 0.5) * 2, `${pct(topShare)} percent of your punches were ${top.k}s. Mix in other punches to open the drone up.`)
    if (maxCombo < 3) add('combo', 0.5, `Your longest combo was ${maxCombo}. Chain jab, cross, hook without resetting.`)
    if (counters === 0 && defences.some((d) => d.outcome === 'dodged')) add('counter', 0.45, 'No counters landed. Fire a punch right after a slip or duck for bonus damage.')
  }
  add('guard', (0.6 - guardPct) / 0.5, `Guard was up only ${pct(guardPct)} percent of the round. Bring both gloves back to your chin after every combo.`)
  if (worst.hits > 0) add('defence', worst.rate, `${worst.hits} of ${worst.total} ${worst.p} attacks landed on you. ${PATTERN_FIX[worst.p]}`)
  if (reactions.length && reaction > 350) add('reaction', (reaction - 300) / 300, `Your average reaction was ${Math.round(reaction)} ms. Watch the drone ring, not your gloves, and move on the first flash.`)

  // Fillers so a strong round still gets three tips.
  if (n > 0) add('polish', 0.02, `Best punch hit ${result.bestSpeed.toFixed(1)} shoulder widths per second. Snap the glove back just as fast as it went out.`)
  add('polish', 0.015, 'Stay on the balls of your feet so you can slip in either direction.')
  add('polish', 0.01, 'Keep your chin tucked and your eyes on the drone between attacks.')
  add('polish', 0, 'Turn your hips into every cross and hook for more power.')

  const picked = tips.sort((a, b) => b.severity - a.severity).slice(0, 3)
  return {
    badge,
    headline,
    tips: [picked[0].text, picked[1].text, picked[2].text],
    drill: DRILLS[picked[0].area],
    source: 'local',
  }
}
