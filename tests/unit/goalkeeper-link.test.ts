// @vitest-environment happy-dom
// src/api/goalkeeperLink.ts: the per-save points it sends must add up to the score the keeper's
// end screen shows. engine.ts endShootout sums the unrounded accuracy/2 and rounds once, so a
// per-kick Math.round would drift 1-3 points over a shootout.
import { afterEach, describe, expect, test } from 'vitest'
import { createGoalkeeperLink, type GoalkeeperLink, type ShootoutSummary } from '../../src/api/goalkeeperLink.ts'

interface Kick {
  outcome: 'SAVE' | 'GOAL'
  reaction: number | null
  accuracy: number
  punch: boolean
}

/** engine.ts endShootout, verbatim arithmetic. */
function engineScore(kicks: readonly Kick[]): number {
  let score = 0
  for (const k of kicks) {
    if (k.outcome !== 'SAVE') continue
    score += 1000
    if (k.reaction !== null && k.reaction < 450) score += 250
    if (k.punch) score += 150
    score += k.accuracy / 2
  }
  return Math.round(score)
}

function dispatch(detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent('motion-event', { detail }))
}

/** Plays one shootout through the link the way src/sports/goalkeeper/telemetry.ts dispatches it. */
function play(kicks: readonly Kick[], sessionId: string): Record<string, unknown>[] {
  const metricsSeen: Record<string, unknown>[] = []
  kicks.forEach((k, i) => {
    const metrics = { kick: i, zone: 4, row: 1, col: 1, part: k.outcome === 'SAVE' ? 'left' : null, punch: k.punch }
    metricsSeen.push(metrics)
    dispatch({
      event_id: crypto.randomUUID(),
      session_id: sessionId,
      player_id: 'local',
      sport: 'GOALKEEPER',
      event_ts: new Date().toISOString(),
      round_ms: i * 9000,
      event_type: k.outcome,
      peak_velocity: 8,
      reaction_ms: k.reaction,
      accuracy_score: k.accuracy,
      symmetry_ratio: null,
      metrics,
    })
  })
  dispatch({
    event_id: crypto.randomUUID(),
    session_id: sessionId,
    player_id: 'local',
    sport: 'GOALKEEPER',
    event_ts: new Date().toISOString(),
    round_ms: 50_000,
    event_type: 'TICK',
    metrics: { summary: true, counts: { saves: kicks.filter((k) => k.outcome === 'SAVE').length, goals: kicks.filter((k) => k.outcome === 'GOAL').length } },
  })
  return metricsSeen
}

let link: GoalkeeperLink | null = null
afterEach(() => {
  link?.dispose()
  link = null
  localStorage.clear()
})

function shootout(kicks: readonly Kick[]): { summary: ShootoutSummary; metrics: Record<string, unknown>[] } {
  link = createGoalkeeperLink({ displayName: 'Link Test' })
  let summary: ShootoutSummary | null = null
  link.onShootoutEnd((s) => (summary = s))
  const metrics = play(kicks, crypto.randomUUID())
  expect(summary).not.toBeNull()
  return { summary: summary!, metrics }
}

describe('goalkeeper link score', () => {
  test('two saves at accuracy 80.6 give 2581, the engine score (per-kick rounding gave 2580)', () => {
    const kicks: Kick[] = [
      { outcome: 'SAVE', reaction: 300, accuracy: 80.6, punch: false },
      { outcome: 'SAVE', reaction: 300, accuracy: 80.6, punch: false },
    ]
    const { summary } = shootout(kicks)
    expect(engineScore(kicks)).toBe(2581)
    expect(summary.score).toBe(2581)
    expect(summary).toMatchObject({ saves: 2, goals: 0, result: 'WIN' })
  })

  test('five saves at 83.33 match the end screen exactly', () => {
    const kicks: Kick[] = Array.from({ length: 5 }, () => ({ outcome: 'SAVE' as const, reaction: 312, accuracy: 83.33, punch: false }))
    expect(shootout(kicks).summary.score).toBe(engineScore(kicks))
  })

  test('mixed saves, goals, punches and slow reactions match the engine for many accuracies', () => {
    for (let n = 0; n < 40; n++) {
      const kicks: Kick[] = Array.from({ length: 5 }, (_, i) => ({
        outcome: (n + i) % 3 === 0 ? ('GOAL' as const) : ('SAVE' as const),
        reaction: (n * 7 + i * 53) % 3 === 0 ? null : 200 + ((n * 37 + i * 91) % 400),
        accuracy: ((n * 17.37 + i * 29.11) % 100) + 0.01 * i,
        punch: (n + i) % 4 === 0,
      }))
      const { summary } = shootout(kicks)
      expect(summary.score).toBe(engineScore(kicks))
      link?.dispose()
      link = null
    }
  })

  test("the game's own metrics objects are not changed", () => {
    const { metrics } = shootout([{ outcome: 'SAVE', reaction: 300, accuracy: 70.5, punch: true }])
    expect(metrics[0]).not.toHaveProperty('points')
  })
})
