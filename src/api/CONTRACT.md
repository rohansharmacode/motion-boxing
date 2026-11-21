# Frontend ↔ backend contract (for Person B)

> **Update:** the Express server in `server/` uses its own shapes: `{name}` for players, a bare event array with lowercase `jab|cross|hook|uppercut|block`, `sport: "boxing"`, and `{session_id}` for session/end. The client talks to it through `src/api/serverAdapter.ts`, which maps these shapes, so the server is the source of truth. The shapes below are the client's internal ones.
>
> **Open asks for the server:**
> 1. Accept `slip`/`duck` event types. The client drops them for now.
> 2. Parse `text/plain` bodies on `/api/events`. `sendBeacon` on tab close sends `text/plain`, and `express.json()` ignores it.
> 3. Keep `payload.client_event_id` to de-dupe retried events. The server makes a new `event_id` for each event, so a retried batch creates duplicates.


Types live in `src/api/types.ts`; the client is `src/api/client.ts`. Field names match the Snowflake tables in `motion-sports-research.md` (section 5), so you can insert rows as-is.

The frontend reads `VITE_API_URL` (for example `http://localhost:8787`, trailing slash optional). If it is empty, or `VITE_USE_MOCK=true`, the frontend uses mock data and never calls the network. If a live call fails (network error, non-2xx, or timeout: 8 s, 20 s for `/api/session/end`), the frontend falls back to mock data and shows an "offline" chip, so the demo never breaks.

## Call order

```
POST /api/players          once per display name (the client caches the id in localStorage)
POST /api/session/start    when the player picks a sport
POST /api/events           every 2 s during the round (+ retries, + sendBeacon on tab close)
POST /api/session/end      once, after the last events batch
GET  /api/leaderboard      start screen / any time
```

## CORS

All calls are cross-origin from the Vite dev server. Allow:

- Origin `http://localhost:5173` (and `http://localhost:4173` for `vite preview`, plus the deployed origin).
- Methods `GET, POST, OPTIONS`; header `Content-Type` (and `Accept`). JSON POSTs trigger a preflight, so answer `OPTIONS` with `204`.
- No cookies or credentials are sent.
- `sendBeacon` posts `text/plain` (no preflight); parse the body as JSON anyway.

## POST /api/players

Request:

```json
{ "display_name": "Naman" }
```

Reply `200`/`201` with the `PLAYERS` row. Please make this idempotent on `display_name` (case-insensitive): return the existing player rather than a new id.

```json
{ "player_id": "2f0c1d7e-3c1a-4c8e-9b0e-6d7a1f2b9c41", "display_name": "Naman", "created_at": "2026-11-21T14:01:58.000Z" }
```

If this fails, the client uses a local uuid for the player. `/api/session/end` always carries `player_id` + `display_name`, so upsert `PLAYERS` there too.

## POST /api/session/start

Request:

```json
{ "player_id": "2f0c1d7e-3c1a-4c8e-9b0e-6d7a1f2b9c41", "display_name": "Naman", "sport": "BOXING" }
```

Reply (insert a `SESSIONS` row with `started_at`):

```json
{ "session_id": "8d6a4c1b-0f8e-4b7a-a3c2-5e9d1f0b7a66", "started_at": "2026-11-21T14:02:00.000Z" }
```

If this fails, the client makes its own `session_id` (uuid). Events and `/api/session/end` then arrive for a session you have never seen, so upsert `SESSIONS` on `/api/session/end`.

## POST /api/events

Sent every 2 seconds while a round runs, plus once at round end. Also sent with `navigator.sendBeacon` if the tab closes (body is the same JSON, content type `text/plain`; parse it anyway).

```json
{
  "events": [
    {
      "event_id": "uuid",
      "session_id": "uuid",
      "player_id": "uuid",
      "sport": "BOXING",
      "event_ts": "2026-11-21T14:03:12.481Z",
      "round_ms": 12480,
      "event_type": "PUNCH",
      "peak_velocity": 3.1,
      "reaction_ms": null,
      "accuracy_score": 82,
      "symmetry_ratio": null,
      "metrics": { "punchType": "HOOK", "hand": "L", "landed": true }
    }
  ]
}
```

Reply `200` or `204`. Any non-2xx or network error: the client puts the batch back at the front of its queue and retries with backoff (2 s, 4 s, 8 s … max 30 s). Unsent events are kept in localStorage (max 5000) and re-sent on the next page load or when the browser comes back online, so **the same event can arrive more than once, possibly hours later**. `event_id` is unique: de-duplicate on it (for example `MERGE` on `event_id`, or insert into a staging table and dedupe). A batch has at most 500 events.

`event_type` values from boxing: `PUNCH` (`metrics.punchType` = `JAB|CROSS|HOOK|UPPERCUT`, `metrics.hand` = `L|R`, optional `metrics.landed`), `BLOCK` (guard raised), `DODGE` (`metrics.kind` = `slip|duck`, `metrics.direction` = `L|R|DOWN` when known). Events from the pose library also carry `metrics.confidence` (0..1), `metrics.guardUptime` (0..1, running value for the round so far), `metrics.fatigueTrend` (0.2 = recent punches 20% slower than earlier ones) and `metrics.frameMs`. `accuracy_score` is pose confidence × 100 when the game has nothing better.

## POST /api/session/end

Sent once when the round ends, after the last events batch.

```json
{
  "session_id": "uuid",
  "player_id": "uuid",
  "display_name": "Naman",
  "sport": "BOXING",
  "started_at": "2026-11-21T14:02:00.000Z",
  "ended_at": "2026-11-21T14:02:40.000Z",
  "final_score": 1840,
  "result": "KO_WIN",
  "avg_inference_fps": 28.4,
  "stats": { "punches": 42, "landed": 30, "byType": { "JAB": 20, "HOOK": 12 }, "avgSpeed": 2.6, "maxSpeed": 4.1, "blocks": 6, "dodges": 3, "avgReactionMs": 410, "leftRightRatio": 0.8, "bestCombo": 7, "guardPct": 64, "slips": 3, "ducks": 0, "fatigueTrend": 0.12 }
}
```

`stats` is just the client's own count (`guardPct`, `slips`, `ducks`, `fatigueTrend` are optional). Snowflake's numbers from `MOTION_EVENTS` are the real ones. Upsert `PLAYERS` and `SESSIONS` here: either earlier call may have failed.

Expected reply (upsert `PLAYERS` + `SESSIONS`, run the Cortex coach, query the leaderboard):

```json
{
  "coach": {
    "headline": "Fast hands, lazy guard in the last 15 seconds.",
    "tips": ["...", "...", "..."],
    "drill": { "name": "Guard-Return Jabs", "description": "..." },
    "badge": { "name": "Neon Hammer", "description": "..." }
  },
  "leaderboard": [
    { "rank": 1, "player_id": "uuid", "display_name": "Naman", "sport": "BOXING", "score": 1840, "max_speed": 4.1 }
  ],
  "form_score": 78
}
```

Top 10 for the same sport is enough. The UI highlights the row whose `player_id` matches. Cortex can take a few seconds, and the UI shows a loading state while it waits (timeout 20 s, then mock).

## GET /api/leaderboard?sport=BOXING&limit=10

`sport` is `BOXING | GOALKEEPER | ARCHERY`; `limit` is 1..100 (default 10). Best score per player is the nicest view.

```json
{
  "entries": [
    { "rank": 1, "player_id": "2f0c1d7e-...", "display_name": "Naman", "sport": "BOXING", "score": 1840, "max_speed": 4.1 },
    { "rank": 2, "player_id": "c51e0a9b-...", "display_name": "Kestrel", "sport": "BOXING", "score": 1712, "max_speed": 3.8 }
  ]
}
```

A bare array of entries is also accepted. On failure the client shows a local mock board (seeded names plus this browser's own scores) marked `source: "mock"`.

## Client API (for the frontend)

```ts
import { createPlayer, startSession, endSession, getLeaderboard, fromMotionLib, emitMotionEvent, getApiStatus } from './api/client';

const player = await createPlayer(name);
const session = await startSession(player, 'BOXING');
session.start();                                   // round begins: starts listening for 'motion-event'
classifier.update(frame).forEach((ev) => emitMotionEvent(fromMotionLib(ev)));
const res = await endSession(session, { finalScore, result, avgInferenceFps });
const board = await getLeaderboard('BOXING', 10);
getApiStatus();                                    // { mode: 'live' | 'mock' | 'offline', queued }
```

None of these promises reject. `createSession({ displayName, sport })` (sync, local ids) still works.

## Goalkeeper: optional fields (added with difficulty and save grades)

These are all optional and only add to what was already sent, so older servers can ignore them. They ride in `metrics` (stored in `payload`).

| Event | Field | Values |
| --- | --- | --- |
| `SAVE` / `GOAL` | `difficulty` | `easy` \| `normal` \| `hard` |
| `SAVE` / `GOAL` | `saveGrade` | `perfect` \| `good` \| `fingertip` \| `miss`, or `null` for a wide shot |
| `SAVE` / `GOAL` | `combo`, `points`, `rampStep` | integers. `points` = grade × combo multiplier + punch bonus. The adapter already sums `metrics.points`, so the leaderboard matches the end screen |
| `SAVE` / `GOAL` | `shot`, `fake` | `straight` \| `curl` \| `dip` \| `skimmer` \| `topCorner`, and a boolean |
| summary `TICK` | `difficulty`, `grade`, `bestCombo`, `perfects` | `grade` is `S` \| `A` \| `B` \| `C` |

The guided practice (3 slow shots) sends no `SAVE`/`GOAL` events and no summary.
