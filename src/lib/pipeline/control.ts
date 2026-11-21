import type { Tier, Landmark } from './types'
export class FrameGate {
  isBusy = false
  private last = -Infinity
  acquire(now: number): number | null {
    if (this.isBusy || !Number.isFinite(now)) return null
    this.isBusy = true
    this.last = Math.max(now, this.last + 0.001)
    return this.last
  }
  release() { this.isBusy = false }
}

export class QualityLadder {
  tier: Tier = 0
  private samples: number[] = []
  private fastWindows = 0
  update(ms: number): Tier {
    if (!Number.isFinite(ms) || ms < 0) return this.tier
    this.samples.push(ms)
    if (this.samples.length < 10) return this.tier
    const average = this.samples.reduce((a,b) => a+b,0)/10
    this.samples = []
    this.fastWindows = average < 30 ? this.fastWindows + 1 : 0
    if (average > 45) this.tier = Math.min(2, this.tier+1) as Tier
    if (this.fastWindows >= 3) {
      this.tier = Math.max(0, this.tier-1) as Tier
      this.fastWindows = 0
    }
    return this.tier
  }
}
interface Candidate { index: number; x: number; y: number; width: number; score: number }
export function isVisible(p: Landmark | undefined): p is Landmark {
  return !!p && [p.x,p.y,p.z].every(Number.isFinite) && (p.visibility ?? 1) >= 0.5
}
export class TargetSelector {
  private target?: Candidate
  private missingSince?: number
  reset() { this.target = undefined; this.missingSince = undefined }
  select(poses: Landmark[][], timeMs: number): number | null {
    const candidates: Candidate[] = []
    poses.forEach((pose,index) => {
      const a = pose[11], b = pose[12], nose = pose[0]
      if (!isVisible(a) || !isVisible(b) || !isVisible(nose)) return
      const width = Math.hypot(a.x-b.x,a.y-b.y)
      if (width < 0.04) return
      const x = (a.x+b.x)/2, y = (a.y+b.y)/2
      candidates.push({ index,x,y,width,score: width/(1+3*Math.hypot(x-0.5,y-0.5)) })
    })
    let next: Candidate | undefined
    if (this.target) {
      const previous = this.target
      next = candidates.filter(c => Math.hypot(c.x-previous.x,c.y-previous.y) < previous.width*0.65
        && c.width/previous.width > 0.65 && c.width/previous.width < 1.5)
        .sort((a,b) => Math.hypot(a.x-previous.x,a.y-previous.y)-Math.hypot(b.x-previous.x,b.y-previous.y))[0]
      if (!next) {
        this.missingSince ??= timeMs
        if (timeMs-this.missingSince < 1500) return null
        this.target = undefined
      }
    }
    next ??= candidates.sort((a,b) => b.score-a.score)[0]
    this.target = next
    if (next) this.missingSince = undefined
    return next?.index ?? null
  }
}
