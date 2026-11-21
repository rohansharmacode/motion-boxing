# Playtest simulator (`npm run sim`)

Plays the real app in headless Chromium with no webcam and no person. `src/pose/pipeline.ts` is swapped (Playwright route,
dev server only, no game code changed) for `mockPipeline.js`, which publishes PoseFrames from:

- **Real takes** from the motion lab, `recordings/<game>_*.json.gz` (boxing and bowling so far), re-timed onto `performance.now()`
  so detectors see real speeds even when rendering is slow.
- **Synthetic poses** (`synth.mjs`) for sports with no takes yet: dives, archery draw and release, bowling swing, racket swing.

```
npm run sim -- boxing        # full fight from real takes: calibration, jab/hook/uppercut/block/dodge/duck sets,
                             # a 1.5 s tracking loss and a hand leaving the frame, until KO or the round ends
npm run sim -- all           # boxing, then a quick pass on goalkeeper, archery, bowling, tabletennis, tennis
```

Output in `sim-out/<sport>/`: screenshots, `run.mp4` (real time) and `run.gif`, plus `sim-out/report.json`
(punches per labelled set and how they were classified, fps, page errors).

Env: `SIM_URL` (use a running server instead of starting vite on :5199), `SIM_CHROME` (Chromium executable if Playwright's
own is not installed), `SIM_W` / `SIM_H` (viewport, default 960x540), `SIM_OUT`, `SIM_REC`, `SIM_HEADED=1`, `SIM_DEBUG=1`.
Needs `ffmpeg` on PATH for the video. Software WebGL in headless Chromium is slow (7 to 15 fps), so fps numbers here are not
what a laptop GPU gets; detection does not depend on it because frames keep their recorded timestamps.

For detector accuracy alone (no browser), `npm run replay -- recordings/boxing_*.json.gz` is faster.
