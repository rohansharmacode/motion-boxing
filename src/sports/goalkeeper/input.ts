// Mouse / touch / keyboard fallback for Reflex Keeper (research doc section 4: D hotkey, mouse X-Y = keeper
// gloves). Arrow keys (Shift = faster) glide the gloves across the goal; using them turns fallback mode on.

/** Goal-plane limits for the keyboard target, metres. */
export const KEY_X_MAX = 3.4
export const KEY_Y_MIN = 0.2
export const KEY_Y_MAX = 2.3
/** Keyboard glove speed, m/s, and with Shift. */
export const KEY_SPEED = 5.5
export const KEY_FAST = 8.5
/** Where the keyboard target starts and returns to on reset. */
export const KEY_HOME = { x: 0, y: 1.1 } as const

export interface KeyState {
  left: boolean
  right: boolean
  up: boolean
  down: boolean
  fast: boolean
}

/** Move a goal-plane target by held keys over dtS seconds (diagonals normalised, clamped to the goal). */
export function stepKeyTarget(t: { x: number; y: number }, keys: KeyState, dtS: number): void {
  const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0)
  const dy = (keys.up ? 1 : 0) - (keys.down ? 1 : 0)
  if ((dx === 0 && dy === 0) || !(dtS > 0)) return
  const norm = dx !== 0 && dy !== 0 ? Math.SQRT1_2 : 1
  const step = (keys.fast ? KEY_FAST : KEY_SPEED) * dtS * norm
  t.x = Math.max(-KEY_X_MAX, Math.min(KEY_X_MAX, t.x + dx * step))
  t.y = Math.max(KEY_Y_MIN, Math.min(KEY_Y_MAX, t.y + dy * step))
}

export interface KeeperInput {
  readonly mouseOn: boolean
  setMouse(on: boolean): void
  /** Flips mouse mode and returns the new state. */
  toggle(): boolean
  /** Latest goal-plane target, null when mouse mode is off or nothing moved yet. Reused object: copy it. */
  target(): { x: number; y: number } | null
  /** Advance keyboard movement; call once per frame before target(). */
  update(dtMs: number): void
  dispose(): void
}

export interface KeeperInputOptions {
  canvas: HTMLCanvasElement
  screenToGoal: (ndcX: number, ndcY: number) => { x: number; y: number }
  onToggle?: (mouseOn: boolean) => void
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function createKeeperInput(opts: KeeperInputOptions): KeeperInput {
  const { canvas, screenToGoal, onToggle } = opts
  let mouseOn = false
  // Last pointer position in NDC; converted lazily so camera moves (resize, shake) stay in sync.
  let ndc: { x: number; y: number } | null = null
  let lastSource: 'pointer' | 'keys' | null = null
  const keys: KeyState = { left: false, right: false, up: false, down: false, fast: false }
  const keyTarget: { x: number; y: number } = { x: KEY_HOME.x, y: KEY_HOME.y }
  const out = { x: 0, y: 0 }

  function track(clientX: number, clientY: number): void {
    const r = canvas.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const x = ((clientX - r.left) / r.width) * 2 - 1
    const y = 1 - ((clientY - r.top) / r.height) * 2
    ndc ??= { x: 0, y: 0 }
    ndc.x = Math.max(-1, Math.min(1, x))
    ndc.y = Math.max(-1, Math.min(1, y))
    lastSource = 'pointer'
  }

  const onPointerMove = (e: PointerEvent): void => {
    track(e.clientX, e.clientY)
  }
  const onPointerDown = (e: PointerEvent): void => {
    track(e.clientX, e.clientY)
  }
  const onTouch = (e: TouchEvent): void => {
    const t = e.touches[0]
    if (!t) return
    track(t.clientX, t.clientY)
    // Keep the page from scrolling or zooming while dragging the gloves.
    if (mouseOn && e.cancelable) e.preventDefault()
  }
  const ARROWS: Record<string, keyof KeyState> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
  const onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return
    keys.fast = e.shiftKey
    const dir = ARROWS[e.code]
    if (dir) {
      e.preventDefault() // no page scroll
      keys[dir] = true
      if (lastSource !== 'keys') {
        // Continue from where the gloves are now when switching from the mouse.
        if (lastSource === 'pointer' && ndc) {
          const g = screenToGoal(ndc.x, ndc.y)
          keyTarget.x = Math.max(-KEY_X_MAX, Math.min(KEY_X_MAX, g.x))
          keyTarget.y = Math.max(KEY_Y_MIN, Math.min(KEY_Y_MAX, g.y))
        }
        lastSource = 'keys'
      }
      if (!mouseOn) api.setMouse(true)
      return
    }
    if (e.code !== 'KeyD' || e.repeat) return
    api.toggle()
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.fast = e.shiftKey
    const dir = ARROWS[e.code]
    if (dir) keys[dir] = false
  }
  const onBlur = (): void => {
    keys.left = keys.right = keys.up = keys.down = keys.fast = false
  }

  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('touchstart', onTouch, { passive: false })
  canvas.addEventListener('touchmove', onTouch, { passive: false })
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  const api: KeeperInput = {
    get mouseOn() {
      return mouseOn
    },
    setMouse(on) {
      if (on === mouseOn) return
      mouseOn = on
      onToggle?.(mouseOn)
    },
    toggle() {
      api.setMouse(!mouseOn)
      return mouseOn
    },
    target() {
      if (!mouseOn) return null
      if (lastSource === 'keys') {
        out.x = keyTarget.x
        out.y = keyTarget.y
        return out
      }
      if (!ndc) return null
      const g = screenToGoal(ndc.x, ndc.y)
      out.x = g.x
      out.y = g.y
      return out
    },
    update(dtMs) {
      if (lastSource === 'keys') stepKeyTarget(keyTarget, keys, dtMs / 1000)
    },
    dispose() {
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('touchstart', onTouch)
      canvas.removeEventListener('touchmove', onTouch)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    },
  }
  return api
}
