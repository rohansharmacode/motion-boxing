# Themes

`bright` (default): sunny island resort, toy-like bean characters, white rounded UI, Fredoka + Nunito.
`neon`: the original dark neon look.

Switch with `?theme=bright` or `?theme=neon` (remembered in localStorage under `kinetic.theme`).

## Layout

- `src/theme/index.ts`: `activeTheme()`, `isBright()`, `applyTheme()` (sets `<html data-theme>`, fonts, favicon). Imported by the shell and the UI kit, so every page gets it.
- `src/theme/bright/palette.ts`: shared colours.
- `src/theme/bright/theme.css`: page base + boxing HUD (`--b-*` tokens). `shell.css`: dashboard. `ui.css`: `src/ui` kit.
- `src/theme/bright/environment.ts`: sky, sun with soft shadows, fog, tone mapping, island backdrop (`applyBrightEnvironment`, `buildIslandBackdrop`, `makeBlobShadow`).
- `src/theme/bright/arena.ts`: beach boxing ring, bleachers, bunting (`buildBrightArena`, `CROWD_SEATS`).
- `src/theme/bright/avatar.ts`: bean character kit (`buildBean`, `buildCrowd`, `buildFigurine`).
- `src/theme/bright/boxer.ts`: opponent and first-person gloves that satisfy `DroneParts` / `GloveParts`.
- `src/theme/bright/boxing.ts`: `brightBoxingLook()`, the one hook the boxing scene calls (null under neon).
- `src/theme/bright/sfx.ts`: cheerful synthesized UI sounds (used by the shell) and an optional boxing set.
- `public/art/bright/*`: original bright SVG art with the same names as `public/art/*`.

## Boxing scene hookup

`src/sports/boxing/scene.ts` calls `brightBoxingLook()` once (null under neon). Under bright it uses the look's sky/lights, arena, opponent and gloves, calls `look.update()` each frame, cheers the crowd on counters and KOs. `sceneParts.ts` makes `COLORS` follow the theme and keeps `hdr()` colours in range under bright; `scenePost.ts` skips bloom under bright (full resolution kept). Neon is unchanged with `?theme=neon`.
