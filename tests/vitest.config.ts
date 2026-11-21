// Vitest config for unit tests in tests/unit. Run with `npm test`.
// Pure logic runs in Node; files that need a DOM opt in with `// @vitest-environment happy-dom`.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    unstubGlobals: true,
    testTimeout: 20_000,
  },
})
