# Motion recordings (detector tuning)

Pose landmarks recorded from real webcams, replayed through the detectors to measure and tune them.
Only landmark JSON lives here (`*.json.gz`, about 150 to 300 KB per minute). **No video, no keys.**

## Record

1. `npm run dev`, open the game with `?record=1`, e.g. http://localhost:5173/?record=1. Pick a sport and start the camera.
   The **Motion recorder** panel appears bottom right once the camera runs. It works in every sport and does not change the game.
2. Fill in **person**, **dist m** (measure it: 1.5 / 2.5 m) and **lighting** (e.g. `room`, `dim`, `backlit`, `window`).
3. **Start take**, then have the player **hold their guard still for 2 s** (the replay calibrates from it, like the game).
4. Click a label, have the player do the reps, click **End segment** (Alt+Enter) and type how many reps were actually done.
   - Best: a second person presses **Alt+Space** right as each rep happens. Marked reps give latency and exact matching.
   - Do one label per segment. Several segments per take are fine; one take per label is easiest to manage.
5. **Save take** (Alt+S). It is written to `recordings/<person>_<labels>_<time>.json.gz`.

### What to record

20+ reps of each, from 2 to 3 people, at 1.5 m and 2.5 m, in at least 2 lighting setups. Include fast and sloppy reps.

| Label | Do |
|---|---|
| `jab-L`, `jab-R` | Straight punch with the player's own left / right hand (jab or cross both count) |
| `hook`, `uppercut` | Either hand |
| `block` | Raise the guard to the face from a lowered position |
| `dodge-L`, `dodge-R` | Slip the head to the player's own left / right |
| `duck` | Duck down and back up |
| `archery-draw`, `archery-release` | Raise the bow arm and draw; release by snapping the draw hand back |
| `keeper-dive-L`, `keeper-dive-R`, `bowl-swing` | Recorded for later: no detector yet |
| `idle` | 30 to 60 s of normal not-punching: shifting weight, talking, scratching your face, adjusting the laptop, someone walking behind |

## Replay

```bash
npm run replay                           # all recordings
npm run replay -- --by person            # also per person (or: distance, lighting)
npm run replay -- --boxing '{"cooldownMs":180}'   # try boxing detector overrides
```

It prints, per motion: reps, detected (recall), precision, false triggers, median latency vs the rep marks,
what fired during each labelled set (misclassifications), and idle triggers per minute.
Targets: every motion >= 90% detected, false triggers < 5% of reps, idle fires nothing. Needs Node 22.18+.
