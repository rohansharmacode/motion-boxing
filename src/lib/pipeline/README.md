# Pose pipeline

Person A imports the singleton from the project root with

```ts
import { PosePipeline } from './src/lib/pipeline'
import type { BodyFrame, PipelineStatus } from './src/lib/pipeline'

const pipeline = PosePipeline.getInstance()
const offFrame = pipeline.onFrame((frame: BodyFrame) => {
  if (frame.person === 'no-person') return
  // Calibrate/smooth/classify frame.image and frame.world in the active game.
})
const offStatus = pipeline.onStatus((status: PipelineStatus) => {
  // Apply status.renderer.pixelRatioCap, bloom and shadows to your renderer.
  // The caller owns Three.js and restores its preferred settings on recovery.
})
await pipeline.start()
// On sport switch, replace subscriptions and reuse this instance.
offFrame()
offStatus()
pipeline.stop() // pauses capture scheduling, retains camera and loaded model
pipeline.dispose() // releases camera, worker, overlay, timers and listeners
```

From `src/main.ts`, the import path is `./lib/pipeline`. Start from a user gesture in a secure context (HTTPS or localhost). The browser requests camera permission. Disposing permits a fresh singleton. A failed instance must be disposed before retrying.

The image/world arrays preserve MediaPipe indices and unmirrored coordinates for the motion library. Low-visibility joints become null. Missing targets produce an empty-array frame with `person: 'no-person'` immediately. The selector reserves a missing person's lock for 1.5 seconds before choosing a new target. Initial selection scores shoulder width and centrality. Position and scale continuity preserve the lock across candidate reorderings. Pose-only tracking cannot guarantee identity when people overlap.

Capture uses OffscreenCanvas at 640×480 and targets at most 30 frames/s. The busy gate is acquired before capture. Transferred ImageBitmaps are closed in the worker even when inference fails. Worker failure or a ten-second inference timeout stops the pipeline and releases resources. Camera/model initialization has a 60-second timeout after permission is granted.

Ten measured inferences averaging above 45 ms advance one tier. Tier 1 captures at 320×240. Tier 2 also requests pixel ratio capped at 1, bloom off and shadows off. Three consecutive ten-frame windows below 30 ms recover one tier. Status FPS measures delivered frame intervals. Inference timing includes a delegate fallback if one occurs.

F toggles the mirrored skeleton overlay with FPS, inference duration, delegate, tier and target state. The shortcut ignores text inputs and modified/repeated keys.

## Runtime assets

The worker loads pinned MediaPipe 0.10.22-rc.20250304 from jsDelivr and the float16 lite model from Google's model storage. GPU initialization and GPU inference failures fall back to CPU. A classic Blob worker supports MediaPipe's WASM loader. Hosting CSP must permit blob workers, the asset origins and WASM execution.

All paths can be overridden through the first `getInstance({...})` call. For offline/local fallback, deployment must serve these files from Vite's public folder (public itself is omitted from browser URLs).

- `public/mediapipe/vision_bundle.cjs` from the same pinned tasks-vision package.
- The package's complete `wasm/` directory at `public/mediapipe/wasm/`.
- `public/mediapipe/pose_landmarker_lite.task`.

The local files are deployment prerequisites. This change only creates files inside `src/lib/pipeline/`. CDN failures automatically try the configured local locations, and unavailable assets produce an error status.

## Verification

Run `npx vitest@4 run src/lib/pipeline --no-cache --reporter verbose` from the repository root. Tests use fake browser and MediaPipe objects, covering frame drops, monotonic timestamps, downgrade/recovery, target loss/reacquisition, concurrent starts, camera disposal races, CPU/local fallback and bitmap cleanup. Tests are JavaScript so the application TypeScript compilation does not require Vitest types.

Measured fake throughput is reported by the test runner. Real camera FPS and GPU/CPU inference latency require testing on the deployment hardware.
