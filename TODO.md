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

## Ownership (updated 12:22)
Ours: `src/sports/boxing/*`, `src/main.ts`, `src/styles/*`, `public/assets/*`. Shared: `src/pose/*` (goalkeeper uses it).
Team: Person B `server/` API, Person C `src/ui` + `src/api`, Gemini `public/art`, Astra `src/lib`, shell `src/shell/*`, goalkeeper `src/sports/goalkeeper/*`.
None of server/, src/ui, src/api, public/art, src/lib, INTEGRATION.md were in the repo at 12:22. Our own backend draft was parked (not committed) so it cannot clash with Person B.

## Queue (in order)
1. M1 workflow wf_70b02344-de3 (above) finishes; orchestrator review; commit + push.
2. (cancelled: our own server/ backend. Person B owns server/.)
3. Shell integration: `startBoxing(ctx: GameContext): Promise<GameSession>` in `src/main.ts`, dispose stops camera, rAF loop, keyboard, engine, scene; return early after each await if `ctx.signal.aborted`; `mountShell({ launchers: { boxing: startBoxing } })`; no auto-start; round-end "Home" button calls `ctx.exit()`; keep the round timer clear of the shell Home button (top centre).
4. Wave 1 boxing polish (exclusive files): bloom arena with weak-laptop fallback, 3 drone attack patterns, combos, slow-mo KO, sfx, art from handoff when present.
5. Team integration when pushed: Person B server, Person C src/ui + src/api (name entry, coach card, mock fallback), Gemini art on tiles, Astra src/lib, goalkeeper in mountShell, leaderboard tile via GET /api/leaderboard.
6. Hardening: 5 reviewers (weak laptop, bad lighting, passer-by, network down, rapid replays/leaks), fix ours, report theirs; hidden demo mode (M) with seeded round + coach card; lazy-load models; docs/DEMO.md click-path.
7. Done gate: full flow (dashboard, name, calibrate, round, events, coach card, leaderboard, home with best score) clean twice in a row (3 for the hardening pass), build green, pushed.

## Git process
- Shared working tree is used by other teams. Commit from a separate worktree (branch `boxing-sync` tracking origin/main, in the session scratchpad): sync only our paths, `npm run build`, commit `<area>: <what>`, `git pull --rebase origin main`, `git push origin HEAD:main`.
- Commit at least every 20 minutes. Never commit `.env` or secrets.

## Next (after M1)
- Review pass (xhigh): detector logic vs real webcam data, loop latency, scene perf.
- Web Worker inference with ImageBitmap transfer and isBusy gate; auto-downgrade ladder (doc section 4).
- Snowflake: tiny Node backend `POST /api/events` (batched every 2 to 3 s), MOTION_EVENTS + SESSIONS tables, Cortex coach card.
- Human: Snowflake account, XSMALL warehouse, service user + PAT in git-ignored `.env`.
