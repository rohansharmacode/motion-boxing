# Devpost submission (ready to paste)

**Project name:** Kinetic Ring

**Tagline:** Living-room motion sports, rebuilt for 2026: box, keep goal or fight a friend with just your laptop webcam, coached by Snowflake Cortex.

**Demo video:** TODO: add the 60-second backup video link (see `docs/DEMO.md`).

**Built with:** TypeScript, three.js, MediaPipe Pose Landmarker, Web Workers, Vite, Node.js, Express, WebSockets, Snowflake (Dynamic Tables, Streams and Tasks, Cortex AI_COMPLETE, AI_CLASSIFY, Cortex Search, Cortex Analyst, VECTOR, Streamlit in Snowflake), Python, Render

---

## Inspiration

We grew up with living-room motion sports: swinging a controller at the TV with the whole family. That needed a console, a sensor bar and a controller in your hand. In 2026 every laptop has a webcam and a browser that can run a pose model in real time, so we asked: can you get the same feeling with no hardware at all, and make it smarter than a fixed score screen? We wanted a coach that actually looks at how you moved and tells you what to fix.

## What it does

Kinetic Ring is a set of webcam motion sports that run in the browser.

- **Boxing:** stand in front of your laptop and box a bot. The game recognises jab, cross, hook and uppercut, plus block, slip and duck, from your pose. The bot telegraphs its attacks, so you have to defend as well as punch. Land enough and you get a slow-motion knockout.
- **Online 1v1:** two laptops, two webcams, one room code. Your punch is telegraphed on your friend's screen for a second so they can slip or block it.
- **Reflex Keeper:** a goalkeeper game on the same pose tracking, with real ball physics and reaction-time scoring.
- **AI coach:** after every round, Snowflake Cortex writes a personal coach card from your stats: a headline, three tips, a drill and a badge.
- **Leaderboard and dashboard:** a live top 10, and a coaching dashboard in Streamlit in Snowflake. It shows your percentile against pro benchmarks, your fatigue curve and left/right symmetry, finds your "style twin", and lets you ask questions about your stats in plain English.

Your video never leaves your device; only the punch data does.

## How we built it

- **Pose:** MediaPipe Pose Landmarker runs in a Web Worker, so the game renders at full speed while inference runs alongside. Frames are passed as zero-copy `ImageBitmap`s, and a One Euro filter smooths the landmarks.
- **Motion detection:** a pure TypeScript detector works in a torso-relative 3D frame, so a tilted laptop camera doesn't confuse "forward" with "up". Punch type comes from elbow angle, shoulder yaw against your calibrated stance, and hand velocity. Defences come from head movement against a learned neutral position.
- **Game:** a deterministic rules engine (HP, round clock, combos, counters, bot AI) driven only by frame time, so rounds can be replayed in tests, and a three.js arena.
- **Backend:** Node.js and Express validate, de-duplicate and batch events into Snowflake through a retrying write-behind queue. A WebSocket relay pairs 1v1 players by room code; each laptop owns its own health, so the two screens never disagree.
- **Snowflake:**
  - Raw events land in `MOTION_EVENTS`.
  - Dynamic Tables roll them into per-player form and per-session progress.
  - Cortex `AI_COMPLETE` with a JSON schema writes the coach card, grounded in our drill library through Cortex Search.
  - Streams and Tasks write a live highlights feed and run `AI_CLASSIFY` scouting reports.
  - Vector similarity finds style twins.
  - Cortex Analyst answers natural-language questions.
  - Streamlit in Snowflake hosts the dashboard.
- **Hosting:** a single Render service serves the game, API and relay over HTTPS, which the webcam requires.

## Challenges we ran into

- **Webcam noise.** Laptop webcams, bad lighting and people walking past produced phantom punches. We added retraction hysteresis, so a hand must pull back before it can punch again, along with visibility gating and tracker-swap detection. We also learned to tell a guard raise apart from an uppercut.
- **Keeping rendering smooth.** Running pose inference on the main thread stuttered the 3D scene, so we moved it to a worker and skip frames while the worker is busy.
- **Two laptops, one fight.** Network lag made the two screens disagree about who got hit. Giving each laptop authority over its own health fixed it.
- **Going live on Snowflake.** New accounts block the legacy `SNOWFLAKE.CORTEX.COMPLETE` function, so we moved everything to `AI_COMPLETE`. Multi-factor sign-in blocks password logins from scripts, so we switched to key-pair auth. The first Cortex call on a cold warehouse is slow, so the server has a fast fallback card and a warm-up.
- **Venue Wi-Fi** blocks laptop-to-laptop traffic, so 1v1 runs over a phone hotspot.

## Accomplishments that we're proud of

- Real punch classification from a plain webcam, with no controller or sensors.
- Online 1v1 across two laptops, built during the hackathon.
- A coach card from Cortex that cites your real numbers and suggests a drill from a real drill library, as validated JSON.
- A Snowflake pipeline that runs end to end on a live account: setup, seed, verification, live rounds and the dashboard.
- It never breaks during a demo: offline mode, a mock backend, keyboard and mouse controls, and a fallback coach.

## What we learned

- Pose models are good enough for gameplay, but the hard part is everything around them: calibration, filtering and rejecting false positives.
- Dynamic Tables and Streams and Tasks turn a raw event table into analytics with very little code, and they cost almost nothing when idle.
- Structured output (a JSON schema) is what makes an LLM reliable enough to put straight into a game UI.
- Retrieval matters: grounding the coach in a drill library made the advice concrete instead of generic.

## What's next for Kinetic Ring

- More sports on the same pose pipeline. Archery is already designed.
- Ranked online matches and tournaments, with the leaderboard and highlights from Snowflake.
- Training plans: the coach tracks your trends across sessions and sets the next drill.
- Benchmark data from real athletes, to replace our hand-picked pro percentiles.
- Mobile and TV browsers.
