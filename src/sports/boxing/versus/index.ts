// Online 1v1 boxing between two laptops: lobby (create or join a room by code) and the match
// handshake. Each laptop runs its own engine; the drone stands in for the other player.
// Your punch telegraphs on their screen, they block or slip it, and their laptop reports back.
import './lobby.css'
import type { BoxingEngine, OpponentPuppet } from '../types.ts'
import { connectVersus, defaultRelayAddress, relayUrl, saveRelayAddress } from './client.ts'
import type { GameMsg, RelayError, VersusClient } from './client.ts'
import { sanitizeLook } from '../../../custom/look.ts'
import type { RobotLook } from '../../../custom/look.ts'

export type VersusInput = 'camera' | 'keyboard'

export interface VersusDeps {
  engine: BoxingEngine
  /** Puts the friend's name on the opponent health bar (null = back to the drone). */
  setOpponentName?(name: string | null): void
  playerName(): string
  /** This player's customised robot, sent to the friend so they see it. */
  playerLook?(): RobotLook
  /** Dress the opponent in the friend's robot look (null = back to the drone). */
  setOpponentLook?(look: RobotLook | null): void
  /** This player's gloves and lean, relayed so the friend's opponent robot moves like them. */
  getPuppet?(): OpponentPuppet
  /** Drive the opponent robot from the friend's relayed gloves and lean (null = bot animation). */
  setOpponentPuppet?(p: OpponentPuppet | null): void
  /** Tight hit spheres while in a room (only a glove that really reaches the friend lands). */
  setStrictHits?(on: boolean): void
  /** Paired: start the chosen input. Calibration then calls ready() instead of starting a round. */
  onChoose(input: VersusInput): void
  /** Leave the online match (opponent left, connection lost, or the player cancelled mid-match). */
  onLeave(): void
}

export interface Versus {
  /** True while connected to a room. main.ts then skips practice and calls ready() to start rounds. */
  readonly active: boolean
  /** Show the "Play a friend online" button (start screen only). */
  setEntryVisible(on: boolean): void
  /** This player is calibrated and in the ring: the round starts when the opponent is too. */
  ready(): void
  dispose(): void
}

const ERRORS: Record<RelayError, string> = {
  'not-found': 'No room with that code. Check the letters with your friend.',
  full: 'That room already has two players.',
  busy: 'The server is full right now. Try again in a moment.',
  unreachable: 'Could not reach the game server. Check the address below and that both laptops are on the same network.',
  closed: 'The connection closed. Try again.',
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function createVersus(ui: HTMLElement, deps: VersusDeps): Versus {
  const { engine } = deps
  const root = document.createElement('div')
  root.className = 'vs-root'
  ui.append(root)

  const entry = document.createElement('button')
  entry.type = 'button'
  entry.className = 'vs-entry'
  entry.id = 'versus-btn'
  entry.textContent = 'Play a friend online'
  root.append(entry)

  const panel = document.createElement('div')
  panel.className = 'vs-panel'
  panel.hidden = true
  root.append(panel)

  const banner = document.createElement('div')
  banner.className = 'vs-banner'
  banner.hidden = true
  root.append(banner)

  let client: VersusClient | null = null
  let peerName: string | null = null
  let inMatch = false
  let localReady = false
  let peerReady = false
  let entryWanted = false
  let busy = false
  let bannerTimer = 0
  let disposed = false
  /** A friend who dropped mid-match gets this long to come back. */
  let peerGrace = 0
  const PEER_GRACE_MS = 30_000
  /** Pose relay to the friend, about 15 times a second while connected. */
  let poseTimer = 0
  const POSE_MS = 33
  const num3 = (v: unknown): [number, number, number] | null =>
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 5)
      ? [v[0], v[1], v[2]]
      : null

  function show(html: string): void {
    panel.innerHTML = html
    panel.hidden = false
    entry.hidden = true
  }

  function hidePanel(): void {
    panel.hidden = true
    panel.innerHTML = ''
    entry.hidden = !entryWanted || client !== null
  }

  /** center: big waiting message; corner: small "You vs X" tag under the opponent's health bar. */
  function renderBanner(text: string | null, place: 'center' | 'corner' = 'center'): void {
    window.clearInterval(bannerTimer)
    banner.classList.toggle('vs-banner--corner', place === 'corner')
    if (text === null) {
      banner.hidden = true
      return
    }
    const paint = (): void => {
      const rtt = client && client.rttMs > 0 ? ` <span class="vs-ping">${Math.round(client.rttMs)} ms</span>` : ''
      banner.innerHTML = `${text}${rtt}`
    }
    paint()
    banner.hidden = false
    bannerTimer = window.setInterval(paint, 1000)
  }

  function matchBanner(): void {
    renderBanner(`You <b>vs</b> ${esc(peerName ?? 'Friend')}`, 'corner')
  }

  const hello = (): GameMsg => ({ k: 'hello', name: deps.playerName() || 'Player', look: deps.playerLook?.() })

  function setPeer(name: string | null): void {
    peerName = name
    deps.setOpponentName?.(name)
    if (!name) deps.setOpponentLook?.(null)
  }

  function menu(error: string | null = null): void {
    const address = defaultRelayAddress()
    show(`
      <h2>Play a friend</h2>
      <p class="vs-sub">Two laptops, two webcams, one ring.</p>
      ${error ? `<p class="vs-error" role="alert">${esc(error)}</p>` : ''}
      <button type="button" class="vs-btn vs-primary" data-act="create">Create a room</button>
      <div class="vs-or">or join one</div>
      <form class="vs-join" data-act="join">
        <input name="code" maxlength="4" autocomplete="off" spellcheck="false" placeholder="CODE" aria-label="Room code" />
        <button type="submit" class="vs-btn">Join</button>
      </form>
      <details class="vs-server">
        <summary>Server</summary>
        <input name="server" value="${esc(address)}" aria-label="Game server address" />
        <p class="vs-hint">The laptop running <code>npm run server:mock</code>, for example <code>192.168.1.20:3001</code>.</p>
      </details>
      <button type="button" class="vs-link" data-act="close">Back</button>`)
    const code = panel.querySelector<HTMLInputElement>('input[name=code]')
    code?.addEventListener('input', () => {
      code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
    })
  }

  function serverAddress(): string {
    const input = panel.querySelector<HTMLInputElement>('input[name=server]')
    const address = (input?.value ?? defaultRelayAddress()).trim() || defaultRelayAddress()
    saveRelayAddress(address)
    return address
  }

  function waiting(): void {
    show(`
      <h2>Room code</h2>
      <div class="vs-code" id="versus-code">${esc(client?.room ?? '')}</div>
      <p class="vs-sub">Tell your friend this code. Waiting for them to join<span class="vs-dots"></span></p>
      <button type="button" class="vs-link" data-act="leave">Cancel</button>`)
  }

  function paired(): void {
    show(`
      <h2>You <span class="vs-vs">vs</span> ${esc(peerName ?? 'Friend')}</h2>
      <p class="vs-sub">Room ${esc(client?.room ?? '')}. Stand back so your upper body is in view.</p>
      <button type="button" class="vs-btn vs-primary" data-act="camera" id="versus-camera">Use camera</button>
      <button type="button" class="vs-btn" data-act="keyboard" id="versus-keyboard">Keyboard</button>
      <button type="button" class="vs-link" data-act="leave">Leave room</button>`)
  }

  function notice(title: string, body: string): void {
    show(`
      <h2>${esc(title)}</h2>
      <p class="vs-sub">${esc(body)}</p>
      <button type="button" class="vs-btn vs-primary" data-act="close-notice">OK</button>`)
  }

  function startMatchIfBoth(): void {
    if (!client || !localReady || !peerReady) return
    if (client.seat === 0) {
      client.send({ k: 'start' })
      begin()
    }
  }

  function begin(): void {
    localReady = false
    peerReady = false
    matchBanner()
    engine.startRound()
  }

  function onMessage(msg: GameMsg): void {
    switch (msg.k) {
      case 'hello':
        setPeer(String(msg.name).slice(0, 24) || 'Friend')
        if (msg.look) deps.setOpponentLook?.(sanitizeLook(msg.look))
        if (!inMatch && !panel.hidden) paired()
        else if (inMatch) matchBanner()
        break
      case 'ready':
        peerReady = true
        startMatchIfBoth()
        break
      case 'start':
        if (localReady) begin()
        break
      case 'punch':
        engine.incomingPunch(msg)
        break
      case 'defence':
        engine.punchResolved(msg)
        break
      case 'pose': {
        const l = num3(msg.l)
        const r = num3(msg.r)
        const lean = num3(msg.lean)
        if (l && r && lean) deps.setOpponentPuppet?.({ left: l, right: r, lean })
        break
      }
    }
  }

  /** Back to "no room": drop the link and the connection. */
  function teardown(): void {
    const c = client
    client = null
    setPeer(null)
    localReady = false
    peerReady = false
    engine.setVersus(null)
    window.clearTimeout(peerGrace)
    peerGrace = 0
    window.clearInterval(poseTimer)
    poseTimer = 0
    deps.setOpponentPuppet?.(null)
    deps.setStrictHits?.(false)
    renderBanner(null)
    c?.close()
  }

  function opponentGone(title: string, body: string): void {
    const wasInMatch = inMatch
    inMatch = false
    teardown()
    if (wasInMatch) {
      engine.abortRound()
      deps.onLeave()
    }
    notice(title, body)
  }

  async function join(room: string | null): Promise<void> {
    if (busy) return
    busy = true
    const address = serverAddress()
    show(`<h2>Connecting</h2><p class="vs-sub">${esc(relayUrl(address))}</p>`)
    try {
      const c = await connectVersus(address, room, deps.playerName() || 'Player', {
        onPeerJoined(name) {
          const wasAway = peerGrace !== 0
          window.clearTimeout(peerGrace)
          peerGrace = 0
          setPeer(name)
          c.send(hello())
          if (!inMatch) paired()
          else {
            // The friend dropped and came back mid-match: pick up where we were.
            if (localReady) c.send({ k: 'ready' })
            if (wasAway) matchBanner()
          }
        },
        onPeerLeft() {
          if (inMatch) {
            // Give a dropped friend time to reconnect before calling the match off.
            window.clearTimeout(peerGrace)
            renderBanner(`${esc(peerName ?? 'Your friend')} is reconnecting`)
            peerGrace = window.setTimeout(() => {
              peerGrace = 0
              opponentGone(`${peerName ?? 'Your friend'} left`, 'The match is over. You can start a new room any time.')
            }, PEER_GRACE_MS)
          } else if (client) {
            setPeer(null)
            peerReady = false
            waiting()
          }
        },
        onMessage,
        onReconnecting() {
          if (inMatch) renderBanner('Reconnecting')
        },
        onReconnected(peer) {
          if (peer) {
            setPeer(peer)
            c.send(hello())
            if (inMatch && localReady) c.send({ k: 'ready' })
          }
          if (inMatch) {
            if (peer) matchBanner()
            else renderBanner(`Waiting for ${esc(peerName ?? 'your friend')} to reconnect`)
          } else if (peer) paired()
          else {
            setPeer(null)
            waiting()
          }
        },
        onClosed() {
          opponentGone('Connection lost', 'The game server stopped answering.')
        },
      })
      if (disposed) {
        c.close()
        return
      }
      client = c
      setPeer(c.peerName)
      deps.setStrictHits?.(true)
      engine.setVersus({
        sendPunch: (p) => c.send({ k: 'punch', ...p }),
        sendDefence: (d) => c.send({ k: 'defence', ...d }),
      })
      // Our gloves and lean go to the friend (30 Hz) so their opponent robot is us, not an animated bot.
      window.clearInterval(poseTimer)
      poseTimer = window.setInterval(() => {
        const p = inMatch && peerName ? deps.getPuppet?.() : undefined
        if (p) c.send({ k: 'pose', l: p.left, r: p.right, lean: p.lean })
      }, POSE_MS)
      if (peerName) {
        c.send(hello())
        paired()
      } else {
        waiting()
      }
    } catch (err) {
      const reason = (typeof err === 'string' && err in ERRORS ? err : 'unreachable') as RelayError
      menu(ERRORS[reason])
    } finally {
      busy = false
    }
  }

  function onClick(e: Event): void {
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-act]') : null
    if (target === entry || (e.target instanceof Element && e.target.closest('#versus-btn'))) {
      menu()
      return
    }
    if (!target || target.tagName === 'FORM') return
    switch (target.dataset.act) {
      case 'create':
        void join(null)
        break
      case 'close':
      case 'close-notice':
        hidePanel()
        break
      case 'leave':
        teardown()
        menu()
        break
      case 'camera':
      case 'keyboard':
        inMatch = true
        hidePanel()
        renderBanner(`Get ready. ${esc(peerName ?? 'Your friend')} is setting up too`)
        deps.onChoose(target.dataset.act)
        break
    }
  }

  function onSubmit(e: Event): void {
    const form = e.target instanceof HTMLFormElement ? e.target : null
    if (!form || form.dataset.act !== 'join') return
    e.preventDefault()
    const code = String(new FormData(form).get('code') ?? '').trim().toUpperCase()
    if (code.length !== 4) {
      menu('Room codes are 4 letters.')
      return
    }
    void join(code)
  }

  root.addEventListener('click', onClick)
  root.addEventListener('submit', onSubmit)
  // Keys typed in the lobby must not reach the game's shortcuts (D, M, R).
  const stopKeys = (e: KeyboardEvent): void => {
    if (!panel.hidden) e.stopPropagation()
  }
  root.addEventListener('keydown', stopKeys)

  // ?room=ABCD opens the lobby and joins straight away.
  const deepLink = new URLSearchParams(location.search).get('room')
  if (deepLink && /^[A-Za-z0-9]{4}$/.test(deepLink)) queueMicrotask(() => void join(deepLink.toUpperCase()))

  return {
    get active() {
      // Paired counts too: a player who starts from the normal camera or keyboard buttons (or by hand
      // dwell) while in a room with a friend is still fighting the friend, never the bot.
      return client !== null && (inMatch || peerName !== null)
    },
    setEntryVisible(on) {
      entryWanted = on
      if (panel.hidden) entry.hidden = !on || client !== null
    },
    ready() {
      if (!client) return
      if (!peerName) {
        renderBanner('Waiting for your friend to join')
        return
      }
      inMatch = true
      hidePanel()
      localReady = true
      renderBanner(`Waiting for ${esc(peerName)} to get ready`)
      client.send({ k: 'ready' })
      startMatchIfBoth()
    },
    dispose() {
      disposed = true
      window.clearInterval(bannerTimer)
      root.removeEventListener('click', onClick)
      root.removeEventListener('submit', onSubmit)
      root.removeEventListener('keydown', stopKeys)
      teardown()
      root.remove()
    },
  }
}
