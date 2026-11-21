// Playwright config for browser smoke tests in tests/e2e. Run with `npm run test:e2e`.
// Uses the installed Microsoft Edge (channel 'msedge'), so no Playwright browser download is needed.
// Starts its own Vite dev server on a fixed port so it never reuses someone else's server.
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const PORT = 5199
const root = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  testDir: './e2e',
  outputDir: './.e2e-results',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'msedge',
    headless: true,
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        '--enable-unsafe-swiftshader',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    cwd: root,
    url: `http://localhost:${PORT}/tests/gk-shell.html`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
