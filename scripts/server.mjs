// Cross-platform launcher for the API server (Windows PowerShell/cmd, macOS, Linux).
//   node scripts/server.mjs          -> Snowflake mode (server/.env)
//   node scripts/server.mjs --mock   -> in-memory mock, no Snowflake needed
// Installs server/node_modules on first run, then runs `npm run dev` in server/.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'server')
const mock = process.argv.includes('--mock')
// npm is npm.cmd on Windows; shell:true lets every platform resolve it.
const npmOpts = { cwd: serverDir, stdio: 'inherit', shell: true }

if (!existsSync(join(serverDir, 'node_modules'))) {
  console.log('Installing server dependencies (first run only)...')
  const install = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], npmOpts)
  if (install.status !== 0) process.exit(install.status ?? 1)
}

const env = { ...process.env, ...(mock ? { SNOWFLAKE_MOCK: '1' } : {}) }
const child = spawn('npm', ['run', 'dev'], { ...npmOpts, env })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
child.on('exit', (code) => process.exit(code ?? 0))
