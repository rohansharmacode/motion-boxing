# motion-boxing TODO

First-person webcam boxing game ("Kinetic Ring", working name). Vite + TypeScript, MediaPipe PoseLandmarker lite,
Three.js, Snowflake analytics (later). Design source: motion-sports-research.md sections 3 (Shared Calibration,
Boxing) and 4 (Client Architecture). Original art only. UX feel inspired by livewebtennis.com, own copy and colours.

## Ownership
We own `src/pose/*`, `src/sports/boxing/*`, `src/main.ts` (plus package.json for deps).

## Decisions
- `@mediapipe/tasks-vision` 1.2.3 and `three` 0.187.0, exact pins. WASM from jsDelivr (pinned 1.2.3). Model in `public/models/`.
- Timestamps: `performance.now()`, strictly increasing. x mirrored once at the source (`src/pose/pipeline.ts`). y flipped for Three.js.
- 1-euro filter per coordinate on joints 0, 11 to 16 (boxing: minCutoff 1.5, beta 0.08, dCutoff 1.0), applied in pixel and mm units so beta works.
- 2 s hold-stance calibration (15 valid frames, shoulders visible). All motion in shoulder widths (SW, SW/s).
- Events: `window.dispatchEvent(new CustomEvent('motion-event', { detail }))`, detail fields = MOTION_EVENTS columns.
- Keys: D = keyboard fallback, Backquote = debug panel, R = new round.
- Deviation: inference runs on the main thread for M1. Web Worker is a later optimisation.
- Strict TypeScript. `npm run build` must stay green.

## Milestone 1: punching on screen works (target 45 min) - workflow wf_70b02344-de3
| # | Task | Owns | Effort | Status |
|---|---|---|---|---|
| T0 | git init, baseline commit, private repo github.com/rohansharmacode/motion-boxing | repo | orchestrator | done |
| S0 | Setup from first plan: deps, model file, strict tsconfig, page shell (index.html, style.css) | setup | medium | done |
| C0 | Contracts: `src/pose/types.ts`, `src/sports/boxing/types.ts` | contracts | medium | in progress |
| A | Pose pipeline, 1-euro filter, calibration, body tracker, overlay | `src/pose/*` | xhigh | in progress |
| B | Detector: jab, cross, hook, uppercut, guard, slip | `boxing/detector.ts` | xhigh | in progress |
| C | Three.js scene: neon gloves, original drone, telegraph, hitstop, shake, sparks | `boxing/scene.ts` | xhigh | in progress |
| D | HUD, telemetry (`motion-event`), keyboard fallback | `boxing/hud.*`, `telemetry.ts`, `keyboard.ts` | medium | in progress |
| E | Engine: 60 s round, HP, drone AI, block 80%, slip counter 1.5x | `boxing/engine.ts` | high | in progress |
| F | Integrate `src/main.ts`, delete superseded drafts, green build | `src/main.ts` | high | todo |
| G | Smoke: build, dev server, headless Chrome camera + keyboard paths | read-only | medium | todo |
| H | Orchestrator: review results, build + dev server myself, fresh-eyes review, commit + push | orchestrator | - | todo |
| I | Human: webcam playtest and threshold tuning with debug panel (Backquote) | detector config | human | todo |

## Next (after M1)
- Review pass (xhigh): detector logic vs real webcam data, loop latency, scene perf.
- Web Worker inference with ImageBitmap transfer and isBusy gate; auto-downgrade ladder (doc section 4).
- Snowflake: tiny Node backend `POST /api/events` (batched every 2 to 3 s), MOTION_EVENTS + SESSIONS tables, Cortex coach card.
- Human: Snowflake account, XSMALL warehouse, service user + PAT in git-ignored `.env`.
