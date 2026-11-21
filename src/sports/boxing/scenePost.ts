// Render path for the boxing scene: bloom composer on 'high', a plain render on 'low', and an auto-drop
// to 'low' when frames run slow. Neon materials use colours above 1 so only they cross the bloom threshold.
import { HalfFloatType, Vector2, WebGLRenderTarget } from 'three'
import type { Camera, Scene, WebGLRenderer } from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import type { QualityLevel } from './types.ts'

/** A small radius keeps the glow on the neon instead of hazing the whole frame. */
const BLOOM = { strength: 0.6, radius: 0.2, threshold: 0.62 } as const
/** Auto-drop when the mean frame time over the last WINDOW_MS is above this. */
const SLOW_FRAME_MS = 24
const WINDOW_MS = 2000
/** Ignore the first frames (shader compiles) and the frames right after a resize or quality change. */
const WARMUP_MS = 1500

export interface RenderPipeline {
  readonly quality: QualityLevel
  /** A manual choice: it also turns the auto-drop off. */
  setQuality(level: QualityLevel): void
  /** CSS pixels. */
  setSize(width: number, height: number): void
  /** Feed every real frame time; drops to low once when the 2 s mean is slow (never raises). */
  watchFrame(dtMs: number): void
  render(): void
  dispose(): void
}

export function createRenderPipeline(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  onChange: (level: QualityLevel) => void,
): RenderPipeline {
  // MSAA target: the canvas antialias flag does not apply to render targets.
  const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 })
  const composer = new EffectComposer(renderer, target)
  const renderPass = new RenderPass(scene, camera)
  const bloom = new UnrealBloomPass(new Vector2(1, 1), BLOOM.strength, BLOOM.radius, BLOOM.threshold)
  const output = new OutputPass()
  composer.addPass(renderPass)
  composer.addPass(bloom)
  composer.addPass(output)

  let quality: QualityLevel = 'high'
  let auto = true
  let width = 1
  let height = 1
  const samples: number[] = []
  let sum = 0
  let warmMs = 0

  function restartWatch(): void {
    samples.length = 0
    sum = 0
    warmMs = 0
  }

  function applySize(): void {
    const high = quality === 'high'
    const ratio = high ? Math.min(window.devicePixelRatio || 1, 2) : 1
    renderer.setPixelRatio(ratio)
    renderer.setSize(width, height)
    // On low the composer shrinks to 1 px so its buffers give their memory back.
    const w = high ? width : 1
    const h = high ? height : 1
    composer.setPixelRatio(ratio)
    composer.setSize(w, h)
    // The bloom chain starts at half the CSS resolution whatever the pixel ratio: it is a blur anyway.
    bloom.setSize(w, h)
    restartWatch()
  }

  function apply(level: QualityLevel): void {
    if (level === quality) return
    quality = level
    applySize()
    onChange(level)
  }

  return {
    get quality() {
      return quality
    },

    setQuality(level) {
      auto = false
      apply(level)
    },

    setSize(w, h) {
      width = Math.max(1, Math.round(w))
      height = Math.max(1, Math.round(h))
      applySize()
    },

    watchFrame(dtMs) {
      if (!auto || quality === 'low' || !(dtMs > 0)) return
      if (warmMs < WARMUP_MS) {
        warmMs += dtMs
        return
      }
      samples.push(dtMs)
      sum += dtMs
      while (samples.length > 1 && sum - samples[0] >= WINDOW_MS) sum -= samples.shift() ?? 0
      if (sum >= WINDOW_MS * 0.95 && sum / samples.length > SLOW_FRAME_MS) apply('low')
    },

    render() {
      if (quality === 'high') composer.render(0)
      else renderer.render(scene, camera)
    },

    dispose() {
      renderPass.dispose()
      bloom.dispose()
      output.dispose()
      composer.dispose()
    },
  }
}
