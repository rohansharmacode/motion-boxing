# Fight Style Guide (retro-grounded)

Rules taken from how classic fighters and boxers work, not their art. All art stays original. Numbers are targets at 60 fps (1 frame = 16.7 ms).

## 1. Timing and feel
| Moment | Value | Lineage |
|---|---|---|
| Hit-stop, jab / light | 50-70 ms (3-4 f) both fighters freeze | SF II, Tekken: freeze on contact sells weight |
| Hit-stop, hook / heavy | 100-130 ms (6-8 f) | heavier hit = longer freeze |
| Hit-stop, counter / KO | 200-300 ms, then 0.3x slow-mo for 600 ms | Fight Night KO replay, Punch-Out star punch |
| Blocked hit | half the hit-stop of the same punch | blocks must feel "dead" |
| Enemy telegraph | 450-700 ms (normal), 900-1100 ms (big punch) | Punch-Out: every attack has a fixed, learnable tell |
| Anticipation : strike : recovery | 3 : 1 : 2 (e.g. 300 / 100 / 200 ms) | Disney anticipation, Punch-Out wind-ups |
| Punish window after a whiff | 500-800 ms enemy "dazed", flash on body | Punch-Out counter window |
| Screen shake | light 0, heavy 2-3 px for 80 ms, KO 6 px for 250 ms, decay exponential | keep it rare or it stops meaning anything |

* Easing: wind-up `easeInQuad`, strike `easeOutExpo` (reach 90% in the first third), recovery `easeOutBack` with 5-10% overshoot. Never linear.
* Smear: on the strike, stretch the glove 1.3-1.6x along travel for 1-2 frames plus a 2-frame motion trail. That is the 3D equivalent of a smear frame.
* Squash: on contact, glove 0.85x along the hit axis for 2 frames; the target head snaps back 15-25 degrees and settles with `easeOutElastic` over 300 ms.
* Idle is never still: bob 2-4% of body height on a 0.9-1.2 s loop (Wii Sports and Punch-Out bounce). Offset each fighter's phase.

## 2. Telegraphs and readability (most important rule)
* One tell per attack, always the same, always in the same spot. Order: pose change, then colour flash, then sound.
* Colour code: enemy wind-up flashes **amber `#FFB000`** on the attacking glove, unblockable/big punch flashes **magenta `#FF2E88`**, a punish window glows **cyan `#00E5FF`** on the enemy body.
* The enemy pulls the attacking glove back 20-30% of arm length before striking (Punch-Out-style lean). The bigger the punch, the bigger the pull.
* Only one threat on screen at a time. Never start a second telegraph while one is live.
* Hits read left vs right: the enemy body leans toward the side that will land.

## 3. Camera staging
* Over-shoulder FOV 50-55 degrees; player shoulder fills the bottom 20-25% of the frame, enemy head sits at the upper third line (Punch-Out see-through-player framing).
* Enemy fills 45-60% of screen height in the fight shot.
* Heavy hit: punch-in 3-5% FOV for 120 ms, ease back over 300 ms. KO: cut to a wide/low shot, never slide slowly.
* Camera follows the player's head with 120-200 ms lag (critically damped spring), never 1:1 jitter.

## 4. Silhouette and proportions
* Toy proportions: head 1/3 to 1/4 of total height, gloves 1.2-1.5x head width (Ready 2 Rumble, Wii Sports exaggeration).
* Every fighter must be identifiable as a pure black silhouette at 64 px tall. Test this.
* One dominant colour per fighter, gloves in a contrasting colour. Player gloves and enemy gloves never share a hue.
* Rim light from behind the enemy (2-3x brightness of fill) to separate it from the crowd.

## 5. Palette (neon arcade, outrun lineage)
| Role | Hex |
|---|---|
| Background deep | `#0B0420` / `#14082E` |
| Floor grid / horizon | `#FF2E88` fading to `#7B2FF7` |
| Primary neon (player) | `#00E5FF` |
| Enemy | `#FF4D4D` / `#FF2E88` |
| Telegraph / warning | `#FFB000` |
| Text / highlights | `#F5F3FF` |
* Max 5 hues on screen plus the background. Saturated colour only on things that matter: gloves, telegraphs, health. Crowd and stands stay at 30-40% saturation and darker so fighters pop.
* Bloom only on emissive gameplay elements. Bloom on everything = the "AI slop" look.

## 6. HUD and type
* Health bars top, full width split in the middle (SF II layout), 12-16 px tall, player left. Damage shows as a white "chip" that drains 400 ms after the hit (SF / Tekken delayed bar).
* Display font: one pixel/arcade face (e.g. Press Start 2P or similar) for numbers, round calls and KO only. Body text in a clean sans. Two fonts max.
* Round call text: scale in from 1.4x to 1.0x in 150 ms, hold 600 ms, out 200 ms. "KO" gets a 1-frame white screen flash at 40% opacity.
* Hit numbers / combo counter: right side, appear on hit, fade after 800 ms. Nothing else animates in the HUD during a fight.

## 7. Audio
* Every hit has 3 layers: transient (thump, first 30 ms), body (whoosh tail 150-250 ms), sweetener (crowd "ooh" on heavies only).
* Pitch-randomise each hit +/-5-8% so repeats do not sound robotic.
* Sound on the exact hit-stop frame; telegraph sound 100-150 ms before the strike lands.
* Duck music 40-50% for 400 ms on KO. Bell = round start/end only.

## Checklist before merging visual work
1. Can you tell what the enemy will do next within 0.5 s, with sound off?
2. Does every hit freeze, flash and sound on the same frame?
3. Is any glow on something that is not gameplay? Remove it.
4. Does it still hold 60 fps on a laptop? Smoothness beats effects.
