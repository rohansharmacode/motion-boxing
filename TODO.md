# motion-boxing TODO

Browser webcam boxing game. Vite + TypeScript, MediaPipe Pose, Three.js, Snowflake analytics.
Original art only. UX feel inspired by livewebtennis.com (dark broadcast look, one neon accent,
condensed display type, camera-first onboarding), with our own copy, colours and assets.

## Decisions
- MediaPipe `@mediapipe/tasks-vision` 1.2.3 (exact pin). WASM from jsDelivr, pinned to 1.2.3.
- Pose model `pose_landmarker_lite.task` in `public/models/`.
- Timestamps: `performance.now()`, strictly increasing.
- Coordinates are mirrored in x once, at the source (`src/pose.ts`). y stays down until Three.js (M2 flips y).
- Strict TypeScript: `strict: true` plus the existing tsconfig rules.
- Snowflake only through a small Node server (M3). No credentials in browser code.

## Milestone 1: tracking, detection, counter
| # | Task | Owns | Effort | Needs | Status |
|---|---|---|---|---|---|
| T0 | git init, baseline commit, private GitHub repo | repo | orchestrator | none | in progress |
| T1 | Setup: deps, model file, delete scaffold, page shell, palette, shared types | package.json, tsconfig.json, index.html, src/style.css, src/types.ts, src/main.ts (stub), public/models/ | medium | T0 | todo |
| T2 | Webcam + PoseLandmarker loop + mirrored overlay | src/pose.ts, src/overlay.ts | high | T1 | todo |
| T3 | Punch and block detector (pure) | src/detector.ts | xhigh | T1 | todo |
| T4 | Detector black-box tests (`node --test`) | tests/detector.test.ts | medium | T1 | todo |
| T5 | UI: start screen, errors, coach prompts, scoreboard HUD, debug panel | src/hud.ts, src/hud.css | high | T1 | todo |
| T6 | Integrate main.ts, fix compile errors, tests pass | src/main.ts | high | T2-T5 | todo |
| T7 | Verify: build, tests, dev server, headless Chrome fake camera | read-only | medium | T6 | todo |
| T8 | Reviews: detector logic, real-time loop | read-only | xhigh | T6 | todo |
| T9 | Orchestrator check: build + dev server, fresh-eyes review | none | orchestrator | T7, T8 | todo |
| T10 | Human: 15 min webcam tuning session with debug panel (D key) | src/detector.ts config | human | T9 | todo |

## Milestone 2: Three.js boxer (after M1 is confirmed)
- Low-poly original boxer, mirrors the player, y flipped for Three.js.

## Milestone 3: Snowflake
- Node API server with `snowflake-sdk`, secrets in git-ignored `.env`.
- Batch insert punches at round end. One stats query on screen.
- Human: create Snowflake account, XSMALL warehouse (auto-suspend 60), service user + PAT.
