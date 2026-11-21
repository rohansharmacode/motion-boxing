// Automatic render quality: drops to 'low' when the game runs under ~50 fps or pose inference takes over
// 45 ms (the renderer and the tracker share the GPU), and climbs back after a run of fast frames.
// Each drop doubles the frames needed to climb back, so a borderline laptop settles instead of flickering.
// Pure: feed it real frame times and the pipeline's inference average.
export type RenderQuality = 'high' | 'low'

export interface QualityGovernorConfig {
  /** Drop when the windowed mean frame time is above 1000 / dropFps ms... */
  dropFps: number
  /** ...or the inference average is above this, ms. */
  dropInferenceMs: number
  /** Averaging window, ms. */
  windowMs: number
  /** Ignored time after start and after every change (shader compiles, resize), ms. */
  warmupMs: number
  /** Consecutive fast frames needed to climb back the first time (doubles after each drop). */
  recoverFrames: number
  /** A frame counts as fast at or below this, ms (a 60 Hz display caps frames near 16.7 ms). */
  recoverFrameMs: number
  /** ...and only while inference is below this, ms. */
  recoverInferenceMs: number
  /** Cap on the doubled recovery count. */
  maxRecoverFrames: number
}

export const DEFAULT_QUALITY_GOVERNOR: QualityGovernorConfig = {
  dropFps: 50,
  dropInferenceMs: 45,
  windowMs: 2000,
  warmupMs: 1500,
  recoverFrames: 30,
  recoverFrameMs: 18,
  recoverInferenceMs: 30,
  maxRecoverFrames: 480,
}

export interface QualityGovernor {
  readonly level: RenderQuality
  /** Feed every rendered frame. Returns the new level when it changes, else null. */
  update(frameMs: number, inferenceMs: number): RenderQuality | null
  reset(): void
}

export function createQualityGovernor(config: Partial<QualityGovernorConfig> = {}): QualityGovernor {
  const cfg = { ...DEFAULT_QUALITY_GOVERNOR, ...config }
  let level: RenderQuality = 'high'
  let warm = 0
  const frames: number[] = []
  let sum = 0
  let fastRun = 0
  let needed = cfg.recoverFrames

  const restart = (): void => {
    warm = 0
    frames.length = 0
    sum = 0
    fastRun = 0
  }

  return {
    get level() {
      return level
    },
    update(frameMs, inferenceMs) {
      if (!(frameMs > 0) || !Number.isFinite(frameMs)) return null
      const inf = Number.isFinite(inferenceMs) ? inferenceMs : 0
      if (warm < cfg.warmupMs) {
        warm += frameMs
        return null
      }
      if (level === 'high') {
        frames.push(frameMs)
        sum += frameMs
        while (frames.length > 1 && sum - frames[0] >= cfg.windowMs) sum -= frames.shift() ?? 0
        const full = sum >= cfg.windowMs * 0.95
        const slowFrames = full && sum / frames.length > 1000 / cfg.dropFps
        if (slowFrames || inf > cfg.dropInferenceMs) {
          level = 'low'
          restart()
          return level
        }
        return null
      }
      fastRun = frameMs <= cfg.recoverFrameMs && inf < cfg.recoverInferenceMs ? fastRun + 1 : 0
      if (fastRun >= needed) {
        level = 'high'
        needed = Math.min(cfg.maxRecoverFrames, needed * 2)
        restart()
        return level
      }
      return null
    },
    reset() {
      level = 'high'
      needed = cfg.recoverFrames
      restart()
    },
  }
}
