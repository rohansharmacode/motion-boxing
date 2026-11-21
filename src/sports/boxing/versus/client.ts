// Online 1v1 transport: one WebSocket to the room relay in server/src/versus.ts.
// The relay only pairs two players and forwards { t: 'msg', d } between them.

/** Game messages between the two laptops (the relay never reads them). */
export type GameMsg =
  | { k: 'hello'; name: string }
  | { k: 'ready' }
  | { k: 'start' }
  | { k: 'punch'; id: number; kind: 'jab' | 'cross' | 'hook' | 'uppercut'; hand: 'left' | 'right'; damage: number; counter: boolean }
  | { k: 'defence'; id: number; outcome: 'blocked' | 'dodged' | 'hit'; damage: number; hp: number }

export type RelayError = 'not-found' | 'full' | 'busy' | 'unreachable' | 'closed'

export interface VersusClientEvents {
  onPeerJoined(name: string): void
  onPeerLeft(): void
  onMessage(msg: GameMsg): void
  /** The connection dropped after joining. */
  onClosed(): void
}

export interface VersusClient {
  readonly room: string
  /** 0 = created the room (starts rounds), 1 = joined it. */
  readonly seat: 0 | 1
  /** Opponent name when already in the room at join time. */
  readonly peerName: string | null
  /** Smoothed round-trip time to the relay, ms (0 until measured). */
  readonly rttMs: number
  send(msg: GameMsg): void
  close(): void
}

const STORAGE_KEY = 'motion-sports.versus-server'
const PING_MS = 2000
const CONNECT_TIMEOUT_MS = 6000

/** Relay address: ?relay=, then the one saved in the lobby, then VITE_VERSUS_URL, then VITE_API_URL, then this host on port 3001. */
export function defaultRelayAddress(): string {
  const q = new URLSearchParams(location.search).get('relay')
  if (q) return q
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return saved
  } catch {
    // Storage blocked: fall through.
  }
  const env = String(import.meta.env.VITE_VERSUS_URL ?? '').trim() || String(import.meta.env.VITE_API_URL ?? '').trim()
  if (env) return env
  return `${location.hostname || 'localhost'}:3001`
}

export function saveRelayAddress(address: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, address.trim())
  } catch {
    // Not fatal.
  }
}

/** "192.168.1.20:3001", "http://host:3001", "wss://x.y/versus" -> a ws(s) URL ending in /versus. */
export function relayUrl(address: string): string {
  let a = address.trim().replace(/\/+$/, '')
  if (/^https:\/\//i.test(a)) a = 'wss://' + a.slice(8)
  else if (/^http:\/\//i.test(a)) a = 'ws://' + a.slice(7)
  else if (!/^wss?:\/\//i.test(a)) a = (location.protocol === 'https:' ? 'wss://' : 'ws://') + a
  if (!/\/versus$/.test(a)) a = a.replace(/\/api$/, '') + '/versus'
  return a
}

/** Create a room (room = null) or join one by code. Resolves once the relay seats us. */
export function connectVersus(
  address: string,
  room: string | null,
  name: string,
  events: VersusClientEvents,
): Promise<VersusClient> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(relayUrl(address))
    } catch {
      reject('unreachable' satisfies RelayError)
      return
    }
    let joined: VersusClient | null = null
    let closedByUs = false
    let rtt = 0
    let pingTimer = 0
    const timeout = window.setTimeout(() => {
      ws.close()
      reject('unreachable' satisfies RelayError)
    }, CONNECT_TIMEOUT_MS)

    const raw = (m: unknown): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
    }

    ws.onopen = () => raw(room ? { t: 'join', room, name } : { t: 'create', name })
    ws.onerror = () => {
      if (!joined) {
        window.clearTimeout(timeout)
        reject('unreachable' satisfies RelayError)
      }
    }
    ws.onclose = () => {
      window.clearTimeout(timeout)
      window.clearInterval(pingTimer)
      if (!joined) reject('closed' satisfies RelayError)
      else if (!closedByUs) events.onClosed()
    }
    ws.onmessage = (e) => {
      let m: { t?: string; room?: string; seat?: number; peer?: string | null; name?: string; d?: GameMsg; at?: number; reason?: RelayError }
      try {
        m = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (m.t === 'joined' && !joined) {
        window.clearTimeout(timeout)
        joined = {
          room: String(m.room),
          seat: m.seat === 1 ? 1 : 0,
          peerName: m.peer ?? null,
          get rttMs() {
            return rtt
          },
          send: (msg) => raw({ t: 'msg', d: msg }),
          close: () => {
            closedByUs = true
            ws.close()
          },
        }
        pingTimer = window.setInterval(() => raw({ t: 'ping', at: performance.now() }), PING_MS)
        resolve(joined)
      } else if (m.t === 'error' && !joined) {
        window.clearTimeout(timeout)
        closedByUs = true
        ws.close()
        reject(m.reason ?? 'closed')
      } else if (m.t === 'pong' && typeof m.at === 'number') {
        const sample = performance.now() - m.at
        rtt = rtt === 0 ? sample : rtt * 0.7 + sample * 0.3
      } else if (m.t === 'peer-joined') {
        events.onPeerJoined(m.name ?? 'Player')
      } else if (m.t === 'peer-left') {
        events.onPeerLeft()
      } else if (m.t === 'msg' && m.d && typeof m.d === 'object') {
        events.onMessage(m.d)
      }
    }
  })
}
