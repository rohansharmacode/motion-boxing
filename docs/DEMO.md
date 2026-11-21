# Live demo script (3 minutes)

One presenter talks and plays. One teammate ("Laptop B") sits ready for the 1v1. Times are cumulative.

## Before the judges arrive (10 minutes ahead)

- [ ] **Laptop A (main):** `npm run server` and `npm run dev`. Check `curl -s localhost:3001/api/health` shows `"mode":"snowflake","snowflake":"up"`.
- [ ] Add `WAREHOUSE_KEEPWARM_MS=240000` to `server/.env` and restart the server, so the first coach card is fast. Remove it after the demo, because it bills.
- [ ] Play one warm-up round, so Cortex and the warehouse are awake.
- [ ] **Laptop B:** `npm run dev`. In Boxing > **Play a friend online** > **Server**, enter Laptop A's IP and port (`ipconfig getifaddr en0` on Mac, `ipconfig` on Windows), e.g. `192.168.1.20:3001`.
- [ ] Both laptops on the **same phone hotspot**. Venue Wi-Fi often blocks laptop-to-laptop traffic.
- [ ] Browser tabs open on Laptop A: (1) the game at `http://localhost:5173`, (2) the Streamlit dashboard in Snowsight (`MOTION_DB.PUBLIC.MOTION_DASHBOARD`), (3) `docs/snowflake-screens/` as a last resort.
- [ ] Good light on your face, plain background, stand about 2 m from the webcam. Calibrate once.
- [ ] Backup video open in a tab (link at the bottom).

## Script

| Time | On screen | Say |
|---|---|---|
| **0:00 – 0:20** | **Dashboard.** Home screen with the sport tiles: Boxing, Reflex Keeper, Leaderboard. | "Remember living-room motion sports? They needed a console and a controller. We rebuilt them for 2026 with just a laptop webcam. Pose tracking runs in the browser, and the video never leaves the device." |
| **0:20 – 1:05** | **Boxing with a KO.** Enter a name, **Start camera**, calibrate (hold guard), fight the bot. Jab, cross, hook; slip or duck its telegraphed attacks. Land the KO, and the slow-motion finish plays. | "Every punch is classified live: jab, cross, hook, uppercut, block, slip, duck, from 3D pose. The bot telegraphs its attacks, so you have to defend too." On the KO: "Knockout, in slow motion." |
| **1:05 – 1:40** | **1v1 on two laptops.** Boxing > **Play a friend online** > **Create a room**. Read the 4-letter code; Laptop B types it and joins. Both calibrate; trade a few punches. | "Same game, two laptops, two webcams. A tiny WebSocket relay pairs us by room code. Your punch is telegraphed on their screen for one second, so they can slip it or block it." |
| **1:40 – 2:05** | **Goalkeeper.** Home > Reflex Keeper. Save two or three shots with your hands and body. | "Same pose pipeline, a second sport: Reflex Keeper. Real ball physics, and every save logs your reaction time." |
| **2:05 – 2:50** | **Snowflake coach and leaderboard.** Back on the boxing result screen: the **AI Coach** card (headline, 3 tips, a drill, a badge) and **Top 10**. Then switch to the Streamlit tab: the live leaderboard, percentile vs pros, fatigue curve; open **Snowflake Lab** for the style twin and the AI scouting report. | "Every punch is a row in Snowflake. Dynamic Tables roll it into form and progress, and Cortex `AI_COMPLETE` writes this coach card as validated JSON, grounded in our drill library with Cortex Search. This dashboard runs inside Snowflake with Streamlit, so the data never leaves." |
| **2:50 – 3:00** | Back to the home screen. | "No controller, no console, no data leaving Snowflake. Kinetic Ring. Thank you." |

Timing cuts if you run long: skip the Snowflake Lab page first, then shorten the goalkeeper to one save.

## Fallback plan

| What fails | Do this | What the judges still see |
|---|---|---|
| **Wi-Fi / internet down** (Snowflake unreachable) | Keep going. The game falls back to a local coach card and an "offline" chip by itself. Or restart with `npm run server:mock`. Show the Snowflake part from `docs/snowflake-screens/` (dashboard, Lab page, live coach card). | Full gameplay; Snowflake from screenshots. Say: "the venue Wi-Fi is down, here's the live run from earlier today." |
| **Snowflake slow** (coach card spinning) | Talk over it: "Cortex is writing this from your stats." If Cortex takes over about 5 s, the server answers with a stats-based card so the screen never hangs, and the Cortex card is saved to Snowflake in the background. Show that one in Streamlit instead. | A coach card either way. |
| **Laptops can't see each other** (1v1) | Both on a phone hotspot. Still blocked: open two browser windows on Laptop A, create the room in one (camera) and join from the other (**Keyboard**). | 1v1 on one machine. |
| **Webcam fails or lighting is bad** | Boxing: press **D** for keyboard mode (J jab, K cross, H hook, U uppercut, Shift / arrows to dodge). Press **M** for a pre-recorded demo round with result screen and coach card. Goalkeeper: press **D** for mouse mode. | All screens and the Snowflake flow, without a camera. |
| **Everything fails** | Play the 60-second backup video. | The whole flow on a real webcam. |

## Backup video

60-second recording of a real webcam round (boxing KO, coach card, leaderboard): **TODO: add link**.
Record it on a laptop with a working webcam (macOS: QuickTime > New Screen Recording; Windows: Win + Alt + R in Game Bar), upload it as an unlisted video, and paste the link here and in `docs/DEVPOST.md`.
