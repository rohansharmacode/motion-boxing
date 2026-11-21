// Smoke test: dashboard -> goalkeeper (mouse mode via ?auto=mouse) -> full 5-kick shootout -> result
// screen -> Home. Runs against the real shell + game in /tests/gk-shell.html (real Three.js WebGL via
// swiftshader). Fails on any uncaught page error or console.error.
import { expect, test } from '@playwright/test'
import type { ConsoleMessage, Page } from '@playwright/test'

interface MotionEvent {
  sport: string
  event_type: string
  metrics: Record<string, unknown>
}

/** Collects page errors and console.error lines for the whole test. */
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })
  return errors
}

test('dashboard → goalkeeper via ?auto=mouse → result screen → Home', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = watchErrors(page)

  await page.goto('/tests/gk-shell.html?auto=mouse')

  // Dashboard
  const tile = page.locator('.shell-tile[data-id=goalkeeper]')
  await expect(tile).toBeVisible()
  await expect(tile).toHaveAttribute('data-ready', 'true')
  await expect(page.locator('.shell')).toHaveAttribute('data-view', 'home')
  await tile.click()

  // auto=mouse skips the start screen straight into play.
  const hud = page.locator('.gk-hud')
  await expect(hud).toHaveAttribute('data-view', 'play', { timeout: 15_000 })
  await expect(page.locator('.shell')).toHaveAttribute('data-view', 'game')
  expect(await page.evaluate(() => (window as unknown as { __shell: { current: string | null } }).__shell.current)).toBe(
    'goalkeeper',
  )
  await expect(page.locator('.gk-badge')).toHaveAttribute('data-mode', 'mouse')

  // Sweep the mouse around the canvas until the shootout ends.
  const canvas = page.locator('.gk-root canvas')
  await expect(canvas).toHaveCount(1)
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas has no bounding box')
  const deadline = Date.now() + 90_000
  let t = 0
  while ((await hud.getAttribute('data-view')) !== 'end') {
    if (Date.now() > deadline) throw new Error('shootout did not reach the end screen within 90 s')
    t += 1
    const x = box.x + box.width * (0.5 + 0.3 * Math.sin(t * 0.7))
    const y = box.y + box.height * (0.5 + 0.2 * Math.cos(t * 1.1))
    await page.mouse.move(x, y, { steps: 4 })
    await page.waitForTimeout(150)
  }

  // Result screen
  const end = page.locator('.gk-end')
  await expect(end).toBeVisible()
  const heading = end.locator('.gk-end-saves')
  await expect(heading).toHaveText(/^SAVES [0-5]\/5$/)
  await expect(end.locator('.gk-kicks tbody tr')).toHaveCount(5)
  const statLabels = await end.locator('.gk-stats dt').allTextContents()
  expect(statLabels).toEqual(['Score', 'Avg reaction', 'Best glove'])
  await expect(end.getByRole('button', { name: 'Again' })).toBeVisible()
  await expect(end.getByRole('button', { name: 'Home' })).toBeVisible()

  // Telemetry: exactly 5 kick results and one summary TICK.
  const events = await page.evaluate(() => (window as unknown as { __events: MotionEvent[] }).__events)
  const kicks = events.filter((e) => e.event_type === 'SAVE' || e.event_type === 'GOAL')
  expect(kicks).toHaveLength(5)
  for (const k of kicks) expect(k.sport).toBe('GOALKEEPER')
  const summaries = events.filter((e) => e.event_type === 'TICK' && e.metrics.summary === true)
  expect(summaries).toHaveLength(1)
  // Heading agrees with the SAVE events.
  const saves = kicks.filter((k) => k.event_type === 'SAVE').length
  await expect(heading).toHaveText(`SAVES ${saves}/5`)

  // Home tears the game down.
  await end.getByRole('button', { name: 'Home' }).click()
  await expect(page.locator('.shell')).toHaveAttribute('data-view', 'home')
  expect(await page.evaluate(() => (window as unknown as { __shell: { current: string | null } }).__shell.current)).toBeNull()
  await expect(page.locator('.gk-root')).toHaveCount(0)
  await expect(page.locator('canvas')).toHaveCount(0)

  // Dashboard record updated from the summary TICK.
  const record = await page.evaluate(() => {
    const raw = localStorage.getItem('motion-sports.records.v1')
    return raw ? (JSON.parse(raw) as Record<string, { rounds: number }>) : null
  })
  expect(record?.goalkeeper?.rounds ?? 0).toBeGreaterThanOrEqual(1)
  await expect(page.locator('.shell-tile[data-id=goalkeeper] .shell-tile-best')).toContainText('1 round')

  expect(errors).toEqual([])
})
