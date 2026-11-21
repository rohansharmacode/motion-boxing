# Kinetic Ring — 20-Second Trailer Storyboard

**Goal:** Punchy, zero-fluff 20-second demo trailer for MLH submission and the 17:30 judging pitch. Every shot is 100% recordable straight from the live browser build (`1080p @ 60fps` via OBS Studio or Windows Game Bar, with one phone/second-laptop over-the-shoulder angle for Shot 2 if desired).

**Music Mood & Audio Arc:**
- **Track style:** Upbeat, crisp *cyber-arcade synthwave / future funk* at **128 BPM** (clean 4-bar drops, zero muddy vocals — e.g. royalty-free retro-arcade synth beat).
- **Dynamic curve:** Filtered synth arpeggio (`0:00–0:03`) -> tight percussion kick enters on the calibration lock (`0:03–0:06`) -> full bassline drop on the first landed jab (`0:06–0:14`) -> brief 0.3s beat-cut + procedural `sfx.ko()` impact boom (`0:14`) -> bright triumphant synth chord swell over Snowflake Cortex AI Coach & final title card (`0:15–0:20`).
- **SFX layer:** Record live game Web Audio SFX (`roundBell`, `whoosh`, `punchHit`, `block`, `ko`) at `-6 dB` under the music so hits feel physically tactile.

---

## Shot-by-Shot Breakdown (7 Shots · 20.0 Seconds)

| Shot | Timecode | Duration | Visual / Real-Game Capture | On-Screen Caption (Chakra Petch Bold Italic) | SFX & Music Cue |
| :--- | :--- | :---: | :--- | :--- | :--- |
| **01 · The Hook** | `0:00.0 – 0:02.5` | 2.5 s | Open on the Kinetic dashboard (`shell.html`). Hand cursor dwells over the animated **Boxing** tile (`public/art/tile-boxing.svg`) until the dwell ring fills and launches cleanly into the arena. | `MOTION SPORTS. NO CONTROLLERS.` | Soft filtered synth arp rises; `uiClick('confirm')` on tile launch. |
| **02 · Zero-Friction Setup** | `0:02.5 – 0:05.5` | 3.0 s | Calibration view with `public/art/calibration-silhouette.svg` over live webcam feed. Player raises fists into the `L FIST` / `R FIST` rings; bar fills to `Locked in. Fight!`; cut flash of `public/art/splash-get-ready.svg`. *(Bonus: picture-in-picture or quick 1s over-the-shoulder clip showing hands in mid-air in front of a normal laptop.)* | `JUST YOUR LAPTOP WEBCAM.` *(sub: Video never leaves this device)* | Kick drum enters; `roundBell(1)` strikes at `0:05.3`. |
| **03 · First Exchange** | `0:05.5 – 0:09.0` | 3.5 s | First-person Boxing bout (`src/sports/boxing`). Player throws a snappy left jab -> right cross combo into `HEX-7`'s chest & head hit spheres. Cyan/ember neon gloves burst lime/magenta impact sparks; live HUD punch counter & speed telemetry climb. | `JAB. CROSS. HOOK. UPPERCUT.` | Bassline drops on first landed punch; rapid `whoosh` + `punchHit` sync. |
| **04 · Slip & Counter** | `0:09.0 – 0:12.0` | 3.0 s | `HEX-7`'s telegraph ring glows crimson (`#FF2A3D`). Player leans left to slip (or raises guard to block) cleanly as the drone lunges past, then immediately lands a golden-lime **COUNTER!** uppercut with hitstop and camera shake. | `READ THE TELEGRAPH. COUNTER.` | `block` / whoosh dodge -> `punchHit(1.0, true)` counter chime on beat. |
| **05 · Sport Switch (Goalkeeper)** | `0:12.0 – 0:14.2` | 2.2 s | Fast whip-cut to **Reflex Keeper** (`src/sports/goalkeeper`): curving plasma penalty kick arcs toward top-right corner; player's glowing glove intercepts the ball in brief slow-motion for a clean save (`SAVED!`). | `ONE WEBCAM. MULTIPLE SPORTS.` | Synth fill climbs; crisp save deflection thump. |
| **06 · The Knockout** | `0:14.2 – 0:16.4` | 2.2 s | Cut back to Boxing final blow: `HEX-7` HP hits `0`, explodes in 72 lime/magenta sparks, tumbles back, and `public/art/title-ko.svg` (`K.O.!`) slams onto screen. | *(Visual `K.O.!` SVG carries the frame — no extra text)* | 0.25 s music cut -> `sfx.ko()` sub-boom + `roundBell(3)`. |
| **07 · Snowflake Cortex + End Card** | `0:16.4 – 0:20.0` | 3.6 s | `0:16.4–0:18.4`: Show post-match **Snowflake Cortex AI Coach** summary card (Form Score, biomechanical breakdown, live Booth Leaderboard). `0:18.4–0:20.0`: Hard cut to `public/art/og-social.svg` (Kinetic Ring wordmark + stack pills) held cleanly for 1.6 s. | `LIVE AI COACHING IN SNOWFLAKE.` -> `KINETIC RING · PLAY IN BROWSER` | Warm bright synth resolution chord + crisp tail fade-out. |

---

## Fast Recording Checklist (15 Minutes Before Demo)

1. **Resolution & Framing:** Record browser tab at `1920×1080`, `60 fps`, full-screen (`F11`) with DevTools closed.
2. **Lighting:** Sit facing a bright wall/window (never backlit) so MediaPipe Pose locks at `28–30 FPS` with zero jitter.
3. **One-Take Tip:** Record one continuous 45-second Boxing bout (make sure to trigger 1 slip + 1 counter + 1 KO) and one 15-second Goalkeeper shootout, then trim the 7 clips cleanly in CapCut / Clipchamp / DaVinci Resolve directly on the 128 BPM beat markers.
4. **Captions Style:** White `#F4F7FF` `Chakra Petch Bold Italic` with subtle `#070913` drop shadow and `#C8FF00` accent on the action verb; position at bottom-center `12%` safe margin so the HUD stays unobstructed.
