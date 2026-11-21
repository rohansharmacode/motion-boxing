import type { MotionEventDetail, MotionEventInput, Telemetry } from './types.ts'

const PLAYER_KEY = 'motion-sports.player-id'

function loadPlayerId(): string {
  try {
    const saved = localStorage.getItem(PLAYER_KEY)
    if (saved) return saved
    const id = crypto.randomUUID()
    localStorage.setItem(PLAYER_KEY, id)
    return id
  } catch {
    // Storage blocked (private mode, sandboxed iframe): use a per-page id.
    return crypto.randomUUID()
  }
}

export function createTelemetry(): Telemetry {
  const playerId = loadPlayerId()
  let sessionId = crypto.randomUUID()
  let roundStart = performance.now()

  return {
    get playerId() {
      return playerId
    },
    get sessionId() {
      return sessionId
    },

    startRound() {
      sessionId = crypto.randomUUID()
      roundStart = performance.now()
    },

    emit(input: MotionEventInput): MotionEventDetail {
      const detail: MotionEventDetail = {
        event_id: crypto.randomUUID(),
        session_id: sessionId,
        player_id: playerId,
        sport: 'BOXING',
        event_ts: new Date().toISOString(),
        round_ms: Math.round(performance.now() - roundStart),
        event_type: input.event_type,
        peak_velocity: input.peak_velocity ?? null,
        reaction_ms: input.reaction_ms ?? null,
        accuracy_score: input.accuracy_score ?? null,
        symmetry_ratio: input.symmetry_ratio ?? null,
        metrics: input.metrics ?? {},
      }
      window.dispatchEvent(new CustomEvent('motion-event', { detail }))
      return detail
    },
  }
}
