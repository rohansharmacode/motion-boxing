// Online 1v1 transport: one WebSocket to the room relay in server/src/versus.ts.
// The relay only pairs two players and forwards { t: 'msg', d } between them.

import type { RobotLook } from '../../../custom/look.ts'

/** Game messages between the two laptops (the relay never reads them). look: the sender's customised robot (untrusted: sanitise). */
export type GameMsg =
  | { k: 'hello'; name: string; look?: RobotLook }
  | { k: 'ready' }
  | { k: 'start' }
  | { k: 'punch'; id: number; kind: 'jab' | 'cross' | 'hook' | 'uppercut'; hand: 'left' | 'right'; damage: number; counter: boolean }
  | { k: 'defence'; id: number; outcome: 'blocked' | 'dodged' | 'hit'; damage: number; hp: number }
  /** About 15 times a second: the sender's gloves and lean, so the opponent robot moves like them. */
  | { k: 'pose'; l: [number, number, number]; r: [number, number, number]; lean: [number, number, number] }

export type RelayError = 'not-found' | 'full' | 'busy' | 'unreachable' | 'closed'

export interface VersusClientEvents {
  onPeerJoined(name: string): void
  onPeerLeft(): void
  onMessage(msg: GameMsg): void
  /** The connection dropped after joining and could not come back (about 30 s of retries). */
  onClosed(): void
  /** The connection dropped; reconnecting in the background. */
  onReconnecting?(): void
  /** Back in the room after a drop. peer: the friend's name if they are there too. */
  onReconnected?(peer: string | null): void
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

/** Relay address: ?relay=, then the one saved in the lobby, then VITE_VERSUS_URL, then VITE_API_URL, then this host (HTTPS) or this host on port 3001. */
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
  if (env && env !== 'same-origin') return env
  // Hosted (HTTPS) build: the relay is on the same host as the page.
  if (env === 'same-origin' || location.protocol === 'https:') return location.host
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

/** Reconnect attempts after a drop: about 30 s in all, then the connection counts as gone. */
const RECONNECT_DELAYS_MS = [300, 700, 1500, 2500, 4000, 6000, 8000, 8000]
/** No message at all (pongs included) for this long: the socket is dead even if it has not closed. */
const SILENCE_MS = 12_000

type RelayIn = { t?: string; room?: string; seat?: number; peer?: string | null; name?: string; d?: GameMsg; at?: number; reason?: RelayError }

/**
 * Create a room (room = null) or join one by code. Resolves once the relay seats us.
 * After that a dropped socket (server restart, Wi-Fi blip, sleeping host) reconnects by itself and
 * takes the same room and seat back; the room is re-created if the server lost it.
 */
export function connectVersus(
  address: string,
  room: string | null,
  name: string,
  events: VersusClientEvents,
): Promise<VersusClient> {
  const url = relayUrl(address)
  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null
    let joined: (VersusClient & { room: string; seat: 0 | 1 }) | null = null
    let closedByUs = false
    let rtt = 0
    let pingTimer = 0
    let silenceTimer = 0
    let retryTimer = 0
    let attempt = 0

    const raw = (m: unknown): void => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
    }

    const stopTimers = (): void => {
      window.clearInterval(pingTimer)
      window.clearTimeout(silenceTimer)
    }

    const heard = (): void => {
      window.clearTimeout(silenceTimer)
      silenceTimer = window.setTimeout(() => ws?.close(), SILENCE_MS)
    }

    function scheduleReconnect(): void {
      if (closedByUs) return
      const delay = RECONNECT_DELAYS_MS[attempt]
      if (delay === undefined) {
        events.onClosed()
        return
      }
      if (attempt === 0) events.onReconnecting?.()
      attempt++
      retryTimer = window.setTimeout(open, delay)
    }

    function open(): void {
      let sock: WebSocket
      try {
        sock = new WebSocket(url)
      } catch {
        if (!joined) reject('unreachable' satisfies RelayError)
        else scheduleReconnect()
        return
      }
      ws = sock
      const firstTimeout = joined
        ? 0
        : window.setTimeout(() => {
            sock.close()
            reject('unreachable' satisfies RelayError)
          }, CONNECT_TIMEOUT_MS)

      sock.onopen = () => {
        heard()
        if (joined) raw({ t: 'join', room: joined.room, name, seat: joined.seat, orCreate: true })
        else raw(room ? { t: 'join', room, name } : { t: 'create', name })
      }
      sock.onerror = () => {
        if (!joined) {
          window.clearTimeout(firstTimeout)
          reject('unreachable' satisfies RelayError)
        }
      }
      sock.onclose = () => {
        if (ws !== sock) return
        window.clearTimeout(firstTimeout)
        stopTimers()
        if (!joined) reject('closed' satisfies RelayError)
        else scheduleReconnect()
      }
      sock.onmessage = (e) => {
        heard()
        let m: RelayIn
        try {
          m = JSON.parse(String(e.data))
        } catch {
          return
        }
        if (m.t === 'joined') {
          window.clearTimeout(firstTimeout)
          window.clearInterval(pingTimer)
          pingTimer = window.setInterval(() => raw({ t: 'ping', at: performance.now() }), PING_MS)
          if (joined) {
            attempt = 0
            events.onReconnected?.(m.peer ?? null)
            return
          }
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
              window.clearTimeout(retryTimer)
              stopTimers()
              ws?.close()
            },
          }
          resolve(joined)
        } else if (m.t === 'error') {
          if (!joined) {
            window.clearTimeout(firstTimeout)
            closedByUs = true
            sock.close()
            reject(m.reason ?? 'closed')
          } else {
            // Our seat was taken while we were away: nothing to go back to.
            closedByUs = true
            stopTimers()
            sock.close()
            events.onClosed()
          }
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
    }

    open()
  })
}
