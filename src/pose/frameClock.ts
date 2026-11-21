// Camera frame timestamps. Wrist speeds are distances over time, so a frame must be stamped when the camera
// captured it, not when tracking happened to run (which jitters with main-thread and worker load).
// Preference: requestVideoFrameCallback's captureTime (same clock as performance.now), else the frame's
// mediaTime mapped onto performance.now, else the callback time. Stamps are strictly increasing.

/** Subset of VideoFrameCallbackMetadata the clock reads. */
export interface FrameMeta {
  captureTime?: number
  mediaTime?: number
}

export interface FrameClock {
  /** now: callback time (performance.now clock). Returns the frame's capture time, strictly increasing. */
  stamp(now: number, meta?: FrameMeta): number
  reset(): void
}

/** A capture time older than this relative to the callback is not believable (clock mix-up), ms. */
const MAX_AGE_MS = 500

export function createFrameClock(): FrameClock {
  let last = -Infinity
  /** performance.now - mediaTime*1000 offset, learned as the minimum seen (the least-delayed delivery). */
  let mediaOffset: number | null = null
  let lastMedia = -Infinity

  return {
    stamp(now, meta) {
      let t = now
      const cap = meta?.captureTime
      const media = meta?.mediaTime
      if (typeof cap === 'number' && Number.isFinite(cap) && cap <= now && now - cap < MAX_AGE_MS) {
        t = cap
      } else if (typeof media === 'number' && Number.isFinite(media)) {
        if (media < lastMedia) mediaOffset = null // stream restarted
        lastMedia = media
        const off = now - media * 1000
        mediaOffset = mediaOffset === null ? off : Math.min(mediaOffset, off)
        const mapped = media * 1000 + mediaOffset
        if (now - mapped < MAX_AGE_MS) t = mapped
      }
      t = t > last ? t : last + 0.001
      last = t
      return t
    },
    reset() {
      last = -Infinity
      mediaOffset = null
      lastMedia = -Infinity
    },
  }
}
