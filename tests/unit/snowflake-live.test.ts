// @vitest-environment happy-dom
// Live Snowflake counter (upload stats) and the highlights feed: src/api/client.ts + src/ui widgets.
// client.ts reads VITE_API_URL at import, so each test re-imports it with the env it needs.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MotionEvent, UploadStats } from '../../src/api/types.ts'
import { highlightText, timeAgo } from '../../src/ui/HighlightsTicker.ts'

type Client = typeof import('../../src/api/client.ts')

async function loadClient(apiUrl: string | null): Promise<Client> {
  vi.resetModules()
  vi.stubEnv('VITE_API_URL', apiUrl ?? '')
  vi.stubEnv('VITE_USE_MOCK', 'false')
  return import('../../src/api/client.ts')
}

let seq = 0
function punch(): MotionEvent {
  seq++
  return {
    event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    session_id: 'sess-1',
    player_id: 'player-1',
    sport: 'BOXING',
    event_ts: new Date().toISOString(),
    round_ms: seq * 100,
    event_type: 'PUNCH',
    peak_velocity: 3.2,
    reaction_ms: null,
    accuracy_score: 80,
    symmetry_ratio: null,
    metrics: { punchType: 'jab', hand: 'left', landed: true },
  }
}

const flush = () => new Promise<void>((r) => queueMicrotask(r))

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('upload stats: mock mode (no API)', () => {
  test('counts captured rows locally, never claims they were sent', async () => {
    const c = await loadClient(null)
    expect(c.USE_MOCK).toBe(true)
    c.queueEvents([punch(), punch(), punch()])
    const s = c.getUploadStats()
    expect(s.mode).toBe('mock')
    expect(s.captured).toBe(3)
    expect(s.sent).toBe(0)
  })

  test('onUploadStats fires once straight away and once per burst', async () => {
    const c = await loadClient(null)
    const seen: UploadStats[] = []
    const off = c.onUploadStats((s) => seen.push(s))
    expect(seen).toHaveLength(1)
    c.queueEvents([punch(), punch()])
    c.queueEvents([punch()])
    await flush()
    expect(seen).toHaveLength(2) // three rows, one coalesced callback
    expect(seen[1].captured).toBe(3)
    off()
    c.queueEvents([punch()])
    await flush()
    expect(seen).toHaveLength(2)
  })
})

describe('upload stats: live API', () => {
  test('sent counts rows the server accepted', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: 2 }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const c = await loadClient('http://api.test')
    c.queueEvents([punch(), punch()])
    expect(c.getUploadStats().queued).toBe(2)
    await c.flushQueue()
    const s = c.getUploadStats()
    expect(s.mode).toBe('live')
    expect(s.sent).toBe(2)
    expect(s.queued).toBe(0)
    expect(s.lastBatch).toBe(2)
    expect(s.lastSentAt).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/events', expect.objectContaining({ method: 'POST' }))
  })

  test('a failing server leaves rows queued and reports offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
    const c = await loadClient('http://api.test')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    c.queueEvents([punch(), punch(), punch()])
    await c.flushQueue()
    const s = c.getUploadStats()
    expect(s.mode).toBe('offline')
    expect(s.sent).toBe(0)
    expect(s.queued).toBe(3)
  })
})

describe('getHighlights', () => {
  test('mock mode returns plausible highlights marked mock', async () => {
    const c = await loadClient(null)
    const res = await c.getHighlights(5)
    expect(res.source).toBe('mock')
    expect(res.highlights.length).toBeGreaterThan(0)
    expect(res.highlights.length).toBeLessThanOrEqual(5)
    for (const h of res.highlights) expect(h.name).not.toBe('')
  })

  test('live mode reads /api/highlights and hides anti-cheat rows', async () => {
    const rows = [
      { highlight_id: 'a', created_at: new Date().toISOString(), kind: 'speed_record', player_id: 'p1', name: 'Kestrel', session_id: 's', value: 4.6, unit: 'm/s', message: 'x' },
      { highlight_id: 'b', created_at: new Date().toISOString(), kind: 'suspicious_speed', player_id: 'p2', name: 'Cheat', session_id: 's', value: 25, unit: 'm/s', message: 'x' },
      { highlight_id: 'c', created_at: new Date().toISOString(), kind: 'punch_milestone', player_id: 'p3', name: 'Lumen', session_id: 's', value: 500, unit: 'punches', message: 'x' },
    ]
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ available: true, highlights: rows }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const c = await loadClient('http://api.test')
    const res = await c.getHighlights(10)
    expect(res.source).toBe('live')
    expect(res.highlights.map((h) => h.highlight_id)).toEqual(['a', 'c'])
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/highlights?limit=')
  })

  test('live failure falls back to mock instead of rejecting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })))
    const c = await loadClient('http://api.test')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await c.getHighlights(3)
    expect(res.source).toBe('mock')
  })
})

describe('highlight text', () => {
  test('uses shoulder-widths per second, not the server m/s label', () => {
    expect(highlightText({ kind: 'speed_record', name: 'Kestrel', value: 4.56 })).toBe('Kestrel · new fastest punch 4.6 SW/s')
    expect(highlightText({ kind: 'personal_best_speed', name: 'Orbit', value: 3 })).toBe('Orbit · personal best 3.0 SW/s')
  })

  test('reaction and milestones', () => {
    expect(highlightText({ kind: 'reaction_record', name: 'VoltJab', value: 212.4 })).toBe('VoltJab · fastest reaction 212 ms')
    expect(highlightText({ kind: 'punch_milestone', name: 'Lumen', value: 1000 })).toBe('Lumen · 1,000 punches thrown')
  })

  test('relative time', () => {
    const now = Date.parse('2026-11-21T15:00:00Z')
    expect(timeAgo('2026-11-21T14:59:40Z', now)).toBe('just now')
    expect(timeAgo('2026-11-21T14:57:00Z', now)).toBe('3 min ago')
    expect(timeAgo('2026-11-21T12:00:00Z', now)).toBe('3 h ago')
    expect(timeAgo('not a date', now)).toBe('')
  })
})

describe('widgets', () => {
  test('SnowflakeCounter counts this round only and labels mock mode honestly', async () => {
    const c = await loadClient(null)
    const { SnowflakeCounter } = await import('../../src/ui/SnowflakeCounter.ts')
    c.queueEvents([punch(), punch()])
    const counter = new SnowflakeCounter(document.body)
    counter.resetRound()
    c.queueEvents([punch(), punch(), punch()])
    await flush()
    expect(counter.element.dataset.mode).toBe('mock')
    expect(counter.element.querySelector('.kr-sf-count')?.textContent).toBe('3')
    expect(counter.element.textContent).toContain('Local only')
    counter.destroy()
    expect(document.querySelector('.kr-sf')).toBeNull()
  })

  test('HighlightsTicker shows a line, rotates, and cleans up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await loadClient(null)
    const { HighlightsTicker } = await import('../../src/ui/HighlightsTicker.ts')
    const t = new HighlightsTicker(document.body, { rotateMs: 1000, refreshMs: 60_000 })
    await t.refresh()
    expect(t.element.hidden).toBe(false)
    const first = t.element.querySelector('.kr-hl-line')?.textContent
    expect(first).toMatch(/ · /)
    await vi.advanceTimersByTimeAsync(1100)
    expect(t.element.querySelector('.kr-hl-line')?.textContent).not.toBe(first)
    t.destroy()
    expect(document.querySelector('.kr-hl')).toBeNull()
  })
})
