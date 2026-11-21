# Kinetic Ring UI

A front-end prototype for the Kinetic Ring webcam boxing demo: React + TypeScript + Tailwind v4, driven by mock data.
There is no pose tracking, webcam, backend or auth here. Every screen is a pure, props-driven component, ready to wire to the real engine and the Express/Snowflake API.

This lives in its own folder with its own `package.json`, so it doesn't touch the root Vite app, `server/` or `src/`.

```bash
cd kinetic-ui
npm install
npm run dev        # http://localhost:5180
npm run build      # typecheck + production build
```

- Game flow: `/`
- Every screen and state side by side: `/#/gallery`

## Keyboard
| Key | Where | Action |
|---|---|---|
| Enter | Start | Enter the ring (skips calibration in the mock flow) |
| L | Start | Leaderboard |
| ←/→ | Sport picker | Move between sports |
| D | Round | Toggle demo controls (1 punch, 2 hit, 3 big hit, 4 block, 5 slip, 6 telegraph, 7 time 0:08, 9 K.O.) |
| R | Post-match | Rematch |
| Esc | Post-match / Leaderboard | Home |

## Files
- `src/index.css`: design tokens (`@theme` colours, fonts, easing) plus all keyframes. Reduced-motion rules are at the bottom.
- `src/types.ts`: API types, with the exact names from the contract, and a few UI-only types.
- `src/mocks.ts`: all mock data.
- `src/hudStore.ts`: a small external store for the HUD (see below).
- `src/App.tsx`: the mock game flow plus hash routing. The `Mock*` wrappers are where real data plugs in.
- `src/Gallery.tsx`: the gallery route. Each frame renders at 1280x720, scaled to fit.

## Components and props

### `StartScreen`
| Prop | Type | Notes |
|---|---|---|
| `defaultName?` | `string` | |
| `mockData?` | `boolean` | Shows the "Mock data: no API connected" chip (default `true`) |
| `onStart` | `(name: string, sport: SportId) => void` | |
| `onLeaderboard` | `() => void` | |

### `CalibrationOverlay`
| Prop | Type | Notes |
|---|---|---|
| `state` | `CalibrationState` | `searching`, `too_close`, `too_far`, `off_centre`, `low_light`, `holding` or `locked` |
| `holdProgress?` | `number` | 0-1, while `holding` |
| `video?` | `ReactNode` | Live webcam element. A dark placeholder is shown when it is missing |

### `Countdown`
| Prop | Type | Notes |
|---|---|---|
| `value?` | `3 \| 2 \| 1 \| 'FIGHT'` | Static, for the gallery. Omit to auto-run |
| `onDone?` | `() => void` | |
| `stepMs?` | `number` | Default 800 |

### `RoundHud`
| Prop | Type | Notes |
|---|---|---|
| `store` | `HudStore` | From `createHudStore(initial: HudState)` |
| `playerName` | `string` | |
| `opponentName?` | `string` | Default `UNIT-07` |
| `scene?` | `ReactNode` | 3D scene behind the overlay. The middle stays clear |

The engine drives the HUD through the store, not through props, so it can update 60 times a second without re-rendering the whole HUD:
`store.update(Partial<HudState>)`, `store.punch(PunchInfo)`, `store.event('BLOCK' | 'SLIP' | 'HIT' | 'COUNTER' | 'KO')`, `store.hit(big?)` and `store.telegraph(on)`.
Each widget subscribes to its own slice, and the speed gauge animates through `requestAnimationFrame` straight on the DOM.

### `DemoControls`
| Prop | Type |
|---|---|
| `store` | `HudStore` |
| `onKo?` | `(won: boolean) => void` |

### `PostMatchScreen`
| Prop | Type | Notes |
|---|---|---|
| `result` | `Result` | |
| `score` | `number` | Counts up |
| `stats` | `RoundStats` | |
| `coachStatus` | `'loading' \| 'ready'` | |
| `coach?` | `CoachCard` | `fallback: true` shows the "Offline coach" chip |
| `coachLoadingLines` | `string[]` | Rotating sub-lines |
| `leaderboard` | `LeaderboardRow[]` | |
| `playerRow` | `LeaderboardRow` | Shown below "..." when outside the top 10 |
| `percentiles` | `Percentiles` | |
| `dataSource` | `DataSource` | |
| `onRematch` / `onHome` | `() => void` | Also on R / Esc |
| `hotkeys?` | `boolean` | Default `true` |

The form score label is Contender below 65, Pro from 65 to 84 and Champion from 85 up (`formLabel`).

### `LeaderboardScreen`
| Prop | Type | Notes |
|---|---|---|
| `rows` | `LeaderboardRow[]` | New arrays animate row reordering and flash "NEW" on changed rows |
| `playerId?` | `string` | Highlighted row |
| `updatedAt` | `number` | ms timestamp, for "Updated N s ago" |
| `dataSource` | `DataSource` | |
| `globalStats` | `{ totalPlayers; totalPunches; fastestPunchEver }` | Bottom ticker |
| `onHome?` | `() => void` | Esc |

The 5-second auto-refresh is done by the caller (see `MockLeaderboard` in `App.tsx`), so the screen stays pure.

### Shared (`src/components`)
`ui.tsx` holds `Chip`, `LiveChip`, `DataSourceChip`, `Button`, `Panel`, `KeyHint`, `CountUp`, `ArenaBackdrop` and the hooks `useCountUp`, `useHotkeys`, `useInterval` and `usePrefersReducedMotion`. `art.tsx` holds `Logo`, `DroneIcon`, `Silhouette` and `BadgeIcon`, all original vector art.
