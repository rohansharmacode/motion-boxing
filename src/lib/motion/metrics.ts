export type Hand = 'left' | 'right'
export interface Metrics {
  peakVelocity: number
  reactionMs: number | null
  symmetry: number | null
  guardUptime: number | null
  fatigueTrend: number | null
}

export class RoundMetrics {
  private speeds: Record<Hand, number[]> = { left: [], right: [] }
  private recent: number[] = []
  private guarded = 0
  private observed = 0
  private cue: number | null = null

  markCue(timeMs: number) { this.cue = timeMs }
  observeGuard(dtMs: number, held: boolean) {
    this.observed += dtMs
    if (held) this.guarded += dtMs
  }
  event(timeMs: number, peakVelocity: number, hand?: Hand): Metrics {
    let reactionMs = null
    if (this.cue !== null && timeMs >= this.cue) {
      reactionMs = timeMs - this.cue
      this.cue = null
    }
    if (hand) {
      const window = this.speeds[hand]
      window.push(peakVelocity)
      if (window.length > 8) window.shift()
      this.recent.push(peakVelocity)
      if (this.recent.length > 8) this.recent.shift()
    }
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
    const l = mean(this.speeds.left), r = mean(this.speeds.right)
    const baseline = mean(this.recent.slice(0, 4))
    return {
      peakVelocity, reactionMs,
      symmetry: l > 0 && r > 0 ? Math.min(l, r) / Math.max(l, r) : null,
      guardUptime: this.observed ? this.guarded / this.observed : null,
      fatigueTrend: this.recent.length === 8 && baseline > 0 ? 1 - mean(this.recent.slice(4)) / baseline : null,
    }
  }
}
