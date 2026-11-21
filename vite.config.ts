// Vite uses its defaults for everything; this file only adds a dev-server endpoint for the motion recorder.
// POST /__recordings?name=<file>.json writes the body, gzipped, to recordings/<file>.json.gz (dev server only,
// never in production builds). See src/dev/recorder.ts and recordings/README.md.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { defineConfig, type Plugin } from 'vite'

const MAX_BYTES = 60 * 1024 * 1024

function recordingsEndpoint(): Plugin {
  return {
    name: 'motion-recordings',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__recordings', (req, res) => {
        const fail = (code: number, msg: string): void => {
          res.statusCode = code
          res.end(msg)
        }
        if (req.method !== 'POST') return fail(405, 'POST only')
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? ''
        if (!/^[a-z0-9][a-z0-9_+.-]{0,118}\.json$/i.test(name)) return fail(400, 'bad file name')
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
            const dir = join(server.config.root, 'recordings')
            mkdirSync(dir, { recursive: true })
            const gz = gzipSync(text, { level: 9 })
            writeFileSync(join(dir, `${name}.gz`), gz)
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ file: `recordings/${name}.gz`, bytes: gz.length }))
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
