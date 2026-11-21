import type { KeeperEventInput, KeeperMotionEvent, KeeperTelemetry } from './types.ts'

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

export function createKeeperTelemetry(): KeeperTelemetry {
  const playerId = loadPlayerId()
  let sessionId = crypto.randomUUID()
  let roundStart = performance.now()
  let pending: KeeperMotionEvent[] = []

  function build(input: KeeperEventInput): KeeperMotionEvent {
    return {
      event_id: crypto.randomUUID(),
      session_id: sessionId,
      player_id: playerId,
      sport: 'GOALKEEPER',
      event_ts: new Date().toISOString(),
      round_ms: Math.round(performance.now() - roundStart),
      event_type: input.event_type,
      peak_velocity: input.peak_velocity ?? null,
      reaction_ms: input.reaction_ms ?? null,
      accuracy_score: input.accuracy_score ?? null,
      symmetry_ratio: input.symmetry_ratio ?? null,
      metrics: input.metrics ?? {},
    }
  }

  function dispatch(detail: KeeperMotionEvent): void {
    window.dispatchEvent(new CustomEvent('motion-event', { detail }))
  }

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

    emit(input: KeeperEventInput): KeeperMotionEvent {
      const detail = build(input)
      dispatch(detail)
      return detail
    },

    queueTick(input: Omit<KeeperEventInput, 'event_type'>): void {
      // Timestamps are taken now, so batching does not skew event_ts or round_ms.
      pending.push(build({ ...input, event_type: 'TICK' }))
    },

    flush(): number {
      if (pending.length === 0) return 0
      const batch = pending
      pending = []
      for (const detail of batch) dispatch(detail)
      return batch.length
    },
  }
}
