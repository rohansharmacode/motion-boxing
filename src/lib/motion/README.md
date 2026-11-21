# Boxing motion library

Import from `src/lib/motion/index.ts`. Supply a single player's 33 MediaPipe image landmarks and matching world landmarks in metres. Preserve MediaPipe's anatomical left/right indices and original, unmirrored coordinates. Both arrays may contain missing joints.

```ts
import { Calibrator, PunchClassifier } from './src/lib/motion'
import type { Frame } from './src/lib/motion'

const calibration = new Calibrator()
let boxer: PunchClassifier | undefined

function onPose(frame: Frame) {
  if (!boxer) {
    const stance = calibration.update(frame.image)
    if (stance) boxer = new PunchClassifier(stance)
    return []
  }
  return boxer.update(frame)
}
```

Ask the player to hold a neutral stance during the game's two-second setup. The calibrator averages 15 valid frames. It stores mirrored image-space torso and nose anchors and 2D shoulder width. Use one classifier per player per round. Call `boxer.markCue(timeMs)` at the opponent's telegraph. Supply strictly increasing capture timestamps in milliseconds from the same clock.

- `OneEuroFilter(options).update(value, timeMs)` filters a scalar. `LandmarkSmoother(options).update(pose, timeMs)` filters all 33 XYZ triples independently. Both expose `reset()`. The classifier accepts the same optional settings. Defaults are `minCutoff: 1.5` Hz, `beta: 0.08`, and `dCutoff: 1` Hz. Lower the minimum cutoff for quieter resting hands. Increase beta for quicker response during movement.
- `update(frame)` returns an array of onset events. Punches carry an anatomical hand. Guard, slip and duck fire on entry. The research thresholds are in `index.ts`. A punch needs a settled starting position, a 220 ms per-hand cooldown and a return near its start before rearming. Tracking gaps over 150 ms clear velocity history. Confidence is the lowest contributing joint visibility, with missing visibility assumed to be 1.
- `peakVelocity` is the largest wrist speed observed from the settled position through detection, in shoulder-widths/s. Posture events report zero. XY uses calibrated image shoulder width, and relative world Z uses world shoulder width. World-space straight-punch thrust and shoulder twist retain their metric thresholds.
- `reactionMs` measures cue to first detected action. `symmetry` divides the slower hand's mean peak speed by the faster hand's, over the last eight punches per hand. `guardUptime` is the fraction of observable time in guard. `fatigueTrend` compares the mean peak speeds of the latest four punches with the preceding four. Positive values indicate slowing. Unavailable measurements are null.
- Torso position, apparent size and joint visibility reject many bystanders and tracking jumps. A single pose stream cannot distinguish people occupying the same stance. The caller owns player selection.

From the repository root, run `npx vitest@4 run src/lib/motion --no-cache --reporter verbose`. The suite reports exact-sequence accuracy by class and mean classification time on 2,000 prebuilt frames. Synthetic results cover the fixture distribution and exclude camera capture and MediaPipe inference.
