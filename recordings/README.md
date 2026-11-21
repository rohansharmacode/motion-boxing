# Motion recordings (detector tuning)

Pose landmarks recorded from real webcams, for every game, used to score and tune the detectors.
Only landmark JSON lives here (`*.json.gz`, about 150 to 300 KB per minute). **No video, no keys.**

## The motion lab: http://localhost:5173/record.html

`npm run dev`, then open **/record.html** (dev server only; it is not part of the production build).
Pick the game at the top: **Boxing**, **Goalkeeper**, **Archery** or **Bowling**. Each has a **Record** and a **Train** tab.
Links can go straight to a game and tab: `/record.html?game=archery&tab=train`.

### Record

1. **Start camera**. Fill in **Person**, **Distance** (measure it: 1.5 / 2.5 m) and **Lighting** (e.g. `room`, `dim`, `backlit`).
2. **Start take**, then the player **holds the guard still for 2 s**. The live detector (and later the replay) calibrates from it.
3. Click a motion (hover it for what to do), the player does the reps, then **End set** (Alt+Enter) and type how many reps were actually done.
   - Best: a second person presses **Alt+Space** at each rep. Marked reps give exact matching and latency.
   - **Live detections** shows what the game's detector sees right now: ✓ for the motion being recorded, ✗ for anything else.
   - A wrong set can be deleted from the table before saving.
4. **Save take** (Alt+S). It is written to `recordings/<game>_<person>_<motions>_<time>.json.gz`.

**What to record:** 20+ reps of each motion, from 2 to 3 people, at 1.5 m and 2.5 m, in at least 2 lighting setups.
Include fast and sloppy reps, and a 30 to 60 s **idle** set per game (shifting weight, talking, touching your face,
adjusting the laptop, someone walking behind).

| Game | Motions | Detector |
|---|---|---|
| Boxing | `jab-L`, `jab-R` (straight punch with your own left / right; jab or cross both count), `hook`, `uppercut`, `block`, `dodge-L`, `dodge-R`, `duck`, `idle` | yes |
| Archery | `archery-draw`, `archery-release`, `idle` | yes |
| Goalkeeper | `keeper-dive-L`, `keeper-dive-R`, `idle` | not yet (recorded for later) |
| Bowling | `bowl-swing`, `idle` | not yet (recorded for later) |

### Train

- **Score** runs the selected takes through the real calibrator, trackers and detectors. Per motion: reps, detected (recall),
  precision, false triggers, median latency vs the rep marks, and what fired during each set. ✓ = target met
  (≥90% detected, <5% false triggers). Tick **Also score per person** to spot one person skewing the numbers.
- **Boxing thresholds** (velocity, extension, hysteresis, visibility gate, guard, slip, duck): edit a value and Score again to see
  the effect (shown as before → after), or **Auto-tune**: it tries one step up and down per value and keeps what improves
  mean F1 minus idle triggers. **Copy overrides** gives the JSON for a tuning PR.

## Command line

```bash
npm run replay                           # all recordings, one report per game
npm run replay -- --by person            # also per person (or: distance, lighting)
npm run replay -- --boxing '{"cooldownMs":180}'   # try boxing overrides
```

Needs Node 22.18+.
