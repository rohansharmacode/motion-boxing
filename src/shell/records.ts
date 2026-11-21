// Personal bests per sport, kept in localStorage. Fed by the round summary that each sport
// emits on window 'motion-event' (event_type TICK with metrics.summary = true).
import type { TileId } from './types.ts'

export interface SportRecord {
  rounds: number
  wins: number
  bestPunches: number
  bestAccuracy: number
  bestSpeed: number
  /** ISO time of the last round. */
  lastPlayed: string | null
}

const KEY = 'motion-sports.records.v1'

const empty = (): SportRecord => ({ rounds: 0, wins: 0, bestPunches: 0, bestAccuracy: 0, bestSpeed: 0, lastPlayed: null })

type Store = Partial<Record<TileId, SportRecord>>

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Store) : {}
  } catch {
    return {}
  }
}

function save(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // Storage blocked: records live for this page only.
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function sportToTile(sport: unknown): TileId | null {
  if (typeof sport !== 'string') return null
  const s = sport.toLowerCase()
  return s === 'boxing' || s === 'goalkeeper' || s === 'archery' ? s : null
}

export interface Records {
  get(id: TileId): SportRecord
  dispose(): void
}

export function createRecords(onChange: (id: TileId) => void): Records {
  let store = load()

  function onEvent(e: Event): void {
    const detail = (e as CustomEvent<unknown>).detail
    if (typeof detail !== 'object' || detail === null) return
    const d = detail as { sport?: unknown; event_ts?: unknown; metrics?: Record<string, unknown> }
    const m = d.metrics
    const id = sportToTile(d.sport)
    if (!id || !m || m.summary !== true) return
    const counts = (m.counts ?? {}) as Record<string, unknown>
    const r = { ...empty(), ...store[id] }
    r.rounds++
    if (m.outcome === 'ko-win' || m.outcome === 'win') r.wins++
    r.bestPunches = Math.max(r.bestPunches, num(counts.total))
    r.bestAccuracy = Math.max(r.bestAccuracy, num(m.accuracyPct))
    r.bestSpeed = Math.max(r.bestSpeed, num(m.bestSpeed))
    r.lastPlayed = typeof d.event_ts === 'string' ? d.event_ts : new Date().toISOString()
    store = { ...store, [id]: r }
    save(store)
    onChange(id)
  }

  window.addEventListener('motion-event', onEvent)

  return {
    get: (id) => ({ ...empty(), ...store[id] }),
    dispose: () => window.removeEventListener('motion-event', onEvent),
  }
}
