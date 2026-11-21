// Vite uses its defaults for everything; this file only adds dev-server endpoints for the record/train page
// (/record.html, src/dev/recordPage.ts). Dev server only, never part of a production build:
//   POST /__recordings?name=<file>.json   save the JSON body gzipped as recordings/<file>.json.gz
//   GET  /__recordings                    list recordings/*.json(.gz): [{ file, bytes, mtime }]
//   GET  /__recordings/<file>             one recording as JSON (gunzipped)
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { defineConfig, type Plugin } from 'vite'

const MAX_BYTES = 60 * 1024 * 1024
const SAFE_NAME = /^[a-z0-9][a-z0-9_+.-]{0,118}\.json$/i
const SAFE_FILE = /^[a-z0-9][a-z0-9_+.-]{0,118}\.json(\.gz)?$/i

function recordingsEndpoint(): Plugin {
  return {
    name: 'motion-recordings',
    apply: 'serve',
    configureServer(server) {
      const dir = join(server.config.root, 'recordings')
      // Latest calibration diagnostics from /record.html (numbers only), for reading from a terminal while helping.
      server.middlewares.use('/__lab-status', (req, res) => {
        const file = join(server.config.root, 'node_modules', '.cache', 'motion-lab-status.json')
        if (req.method === 'GET') {
          res.setHeader('content-type', 'application/json')
          try { return res.end(readFileSync(file)) } catch { return res.end('{}') }
        }
        let body = ''
        req.on('data', (c: Buffer) => { if (body.length < 10_000) body += c.toString('utf8') })
        req.on('end', () => {
          try { JSON.parse(body); mkdirSync(join(server.config.root, 'node_modules', '.cache'), { recursive: true }); writeFileSync(file, body) } catch { /* ignore */ }
          res.end('ok')
        })
      })
      server.middlewares.use('/__recordings', (req, res) => {
        const fail = (code: number, msg: string): void => {
          res.statusCode = code
          res.end(msg)
        }
        const json = (v: unknown): void => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(v))
        }
        const url = new URL(req.url ?? '/', 'http://x')
        const file = decodeURIComponent(url.pathname.replace(/^\//, ''))

        if (req.method === 'GET' && !file) {
          let files: string[] = []
          try { files = readdirSync(dir).filter((f) => SAFE_FILE.test(f)).sort() } catch { /* no folder yet */ }
          return json(files.map((f) => { const st = statSync(join(dir, f)); return { file: f, bytes: st.size, mtime: st.mtimeMs } }))
        }
        if (req.method === 'GET') {
          if (!SAFE_FILE.test(file)) return fail(400, 'bad file name')
          try {
            const buf = readFileSync(join(dir, file))
            res.setHeader('content-type', 'application/json')
            return res.end(file.endsWith('.gz') ? gunzipSync(buf) : buf)
          } catch {
            return fail(404, 'not found')
          }
        }
        if (req.method !== 'POST') return fail(405, 'GET or POST')

        const name = url.searchParams.get('name') ?? ''
        if (!SAFE_NAME.test(name)) return fail(400, 'bad file name')
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_BYTES) req.destroy()
          else chunks.push(c)
        })
        req.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8')
            JSON.parse(text) // reject anything that is not JSON
            mkdirSync(dir, { recursive: true })
            const gz = gzipSync(text, { level: 9 })
            writeFileSync(join(dir, `${name}.gz`), gz)
            json({ file: `recordings/${name}.gz`, bytes: gz.length })
          } catch (err) {
            fail(400, String(err))
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [recordingsEndpoint()],
})
