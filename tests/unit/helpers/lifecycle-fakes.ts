// Leak-accounting fakes for tests/unit/shell-lifecycle.test.ts.
// happy-dom has no WebAudio, so FakeAudioContext stands in for it (with live/closed bookkeeping).
// FakeResizeObserver replaces happy-dom's to count observe/disconnect. The trackers wrap the real
// (or fake-timer) functions and only record what is still live; behaviour passes straight through.

// ---------- AudioContext ----------

class FakeParam {
  value = 0
  setValueAtTime(v: number): this {
    this.value = v
    return this
  }
  exponentialRampToValueAtTime(v: number): this {
    this.value = v
    return this
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v
    return this
  }
  setTargetAtTime(v: number): this {
    this.value = v
    return this
  }
  cancelScheduledValues(): this {
    return this
  }
}

class FakeNode {
  connect<T>(dst: T): T {
    return dst
  }
  disconnect(): void {}
}

class FakeSource extends FakeNode {
  frequency = new FakeParam()
  detune = new FakeParam()
  type = 'sine'
  buffer: unknown = null
  loop = false
  start(): void {}
  stop(): void {}
}

export class FakeAudioContext {
  static all: FakeAudioContext[] = []
  static reset(): void {
    FakeAudioContext.all = []
  }
  /** Keeper sfx builds a noise buffer right away; shell UI sfx never does. */
  static keeper(): FakeAudioContext[] {
    return FakeAudioContext.all.filter((c) => c.usedBuffer)
  }
  static ui(): FakeAudioContext[] {
    return FakeAudioContext.all.filter((c) => !c.usedBuffer)
  }

  state: 'running' | 'suspended' | 'closed' = 'running'
  currentTime = 0
  sampleRate = 8000
  destination = new FakeNode()
  usedBuffer = false

  constructor() {
    FakeAudioContext.all.push(this)
  }
  resume(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    this.state = 'closed'
    return Promise.resolve()
  }
  createGain(): FakeNode & { gain: FakeParam } {
    return Object.assign(new FakeNode(), { gain: new FakeParam() })
  }
  createOscillator(): FakeSource {
    return new FakeSource()
  }
  createBufferSource(): FakeSource {
    return new FakeSource()
  }
  createBiquadFilter(): FakeNode & { type: string; frequency: FakeParam; Q: FakeParam; gain: FakeParam } {
    return Object.assign(new FakeNode(), { type: 'lowpass', frequency: new FakeParam(), Q: new FakeParam(), gain: new FakeParam() })
  }
  createBuffer(_channels: number, length: number): { getChannelData(i: number): Float32Array } {
    this.usedBuffer = true
    const data = new Float32Array(length)
    return { getChannelData: () => data }
  }
}

// ---------- ResizeObserver ----------

export class FakeResizeObserver {
  static all: FakeResizeObserver[] = []
  static reset(): void {
    FakeResizeObserver.all = []
  }
  /** Observers that still watch at least one element. */
  static live(): FakeResizeObserver[] {
    return FakeResizeObserver.all.filter((o) => o.targets.size > 0)
  }

  readonly targets = new Set<Element>()
  observeCalls = 0
  disconnectCalls = 0
  constructor(readonly cb: ResizeObserverCallback) {
    FakeResizeObserver.all.push(this)
  }
  observe(el: Element): void {
    this.observeCalls++
    this.targets.add(el)
  }
  unobserve(el: Element): void {
    this.targets.delete(el)
  }
  disconnect(): void {
    this.disconnectCalls++
    this.targets.clear()
  }
}

// ---------- event listeners ----------

type Listener = EventListenerOrEventListenerObject

export interface ListenerTracker {
  /** Sorted "type|capture" keys with a count per live listener, e.g. ["keydown|false"]. */
  snapshot(): string[]
  /** Live listener objects for one type. */
  live(type: string): Listener[]
  uninstall(): void
}

function captureOf(opts: boolean | AddEventListenerOptions | EventListenerOptions | undefined): boolean {
  return typeof opts === 'boolean' ? opts : Boolean(opts?.capture)
}

/** Wraps target.addEventListener/removeEventListener (own-property shadow) to count live listeners. */
export function trackListeners(target: EventTarget): ListenerTracker {
  const live = new Map<string, Set<Listener>>()
  const origAdd = target.addEventListener
  const origRemove = target.removeEventListener
  const had = Object.prototype.hasOwnProperty.call(target, 'addEventListener')

  const add = function (this: EventTarget, type: string, fn: Listener | null, opts?: boolean | AddEventListenerOptions): void {
    if (fn) {
      const key = `${type}|${captureOf(opts)}`
      const once = typeof opts === 'object' && opts?.once === true
      // { once } listeners remove themselves on dispatch; only count the long-lived ones.
      if (!once) {
        let s = live.get(key)
        if (!s) live.set(key, (s = new Set()))
        s.add(fn)
      }
    }
    origAdd.call(this, type, fn, opts)
  }
  const remove = function (this: EventTarget, type: string, fn: Listener | null, opts?: boolean | EventListenerOptions): void {
    if (fn) live.get(`${type}|${captureOf(opts)}`)?.delete(fn)
    origRemove.call(this, type, fn, opts)
  }
  Object.defineProperty(target, 'addEventListener', { value: add, configurable: true, writable: true })
  Object.defineProperty(target, 'removeEventListener', { value: remove, configurable: true, writable: true })

  return {
    snapshot() {
      const out: string[] = []
      for (const [key, set] of live) for (let i = 0; i < set.size; i++) out.push(key)
      return out.sort()
    },
    live(type) {
      const out: Listener[] = []
      for (const [key, set] of live) if (key.startsWith(`${type}|`)) out.push(...set)
      return out
    },
    uninstall() {
      if (had) {
        Object.defineProperty(target, 'addEventListener', { value: origAdd, configurable: true, writable: true })
        Object.defineProperty(target, 'removeEventListener', { value: origRemove, configurable: true, writable: true })
      } else {
        delete (target as unknown as Record<string, unknown>).addEventListener
        delete (target as unknown as Record<string, unknown>).removeEventListener
      }
    },
  }
}

// ---------- requestAnimationFrame ----------

export interface RafTracker {
  readonly live: ReadonlySet<number>
  uninstall(): void
}

/** Wraps the current (fake-timer) rAF/cAF on globalThis to count frames that are still scheduled. */
export function trackRaf(): RafTracker {
  const g = globalThis as unknown as {
    requestAnimationFrame: (cb: FrameRequestCallback) => number
    cancelAnimationFrame: (id: number) => void
  }
  const origRaf = g.requestAnimationFrame
  const origCaf = g.cancelAnimationFrame
  const live = new Set<number>()
  g.requestAnimationFrame = (cb) => {
    const id: number = origRaf((t) => {
      live.delete(id)
      cb(t)
    })
    live.add(id)
    return id
  }
  g.cancelAnimationFrame = (id) => {
    live.delete(id)
    origCaf(id)
  }
  return {
    live,
    uninstall() {
      g.requestAnimationFrame = origRaf
      g.cancelAnimationFrame = origCaf
    },
  }
}
