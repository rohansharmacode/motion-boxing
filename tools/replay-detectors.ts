// Replays motion recordings through every detector and prints recall, precision and false triggers per motion.
//
//   npm run replay                              # all of recordings/
//   npm run replay -- recordings/ana_*.json.gz  # some takes
//   npm run replay -- --by person               # one table per person (or distance, lighting)
//   npm run replay -- --boxing '{"cooldownMs":180,"hookMinSpeed":3}'   # try boxing config overrides
//
// Needs Node 22.18+ (runs the TypeScript directly). Recordings come from the motion lab (/record.html).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { GAMES, gameOf, parseRecording, type GameId, type Recording } from '../src/dev/recordingFormat.ts'
import { emptyScores, formatConfusion, formatScores, replayTake, scoreTake, type ReplayOptions, type Scores } from './replay/score.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const by = flag('by') as 'person' | 'distance' | 'lighting' | undefined
const boxingJson = flag('boxing')
const opts: ReplayOptions = boxingJson ? { boxing: JSON.parse(boxingJson) } : {}

function listFiles(paths: string[]): string[] {
  const out: string[] = []
  for (const p of paths.length ? paths : ['recordings']) {
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      for (const f of readdirSync(p).sort()) if (/\.json(\.gz)?$/.test(f)) out.push(join(p, f))
    } else out.push(p)
  }
  return out
}

function load(file: string): Recording {
  const buf = readFileSync(file)
  return parseRecording((file.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'))
}

const files = listFiles(args)
if (!files.length) {
  console.log('No recordings found. Record some at /record.html on the dev server (see recordings/README.md).')
  process.exit(0)
}

/** Scores are kept per game: a boxing take is only charged with boxing detections, and so on. */
const perGame = new Map<GameId | 'unknown', { all: Scores; groups: Map<string, Scores> }>()
console.log(`## Takes${opts.boxing ? ` (boxing overrides: ${JSON.stringify(opts.boxing)})` : ''}\n`)
console.log('| File | Person | Dist | Light | Frames | Pose | fps | Inference ms | Calibrated | Events |')
console.log('|---|---|---|---|---|---|---|---|---|---|')
for (const file of files) {
  let rec: Recording
  try { rec = load(file) } catch (err) { console.log(`| ${file} | unreadable: ${String(err)} |`); continue }
  const take = replayTake(rec, opts)
  const cal = take.calibratedAt !== null ? `after ${((take.calibratedAt - (rec.frames.find((f) => f)?.[0] ?? 0)) / 1000).toFixed(1)} s` : 'NEVER (start takes with a 2 s guard hold)'
  console.log(`| ${file.split('/').pop()} | ${rec.person} | ${rec.distanceM} m | ${rec.lighting} | ${take.frames} | ${take.poseFrames} | ${take.fps.toFixed(0)} | ${rec.inferenceMs} | ${cal} | ${take.events.length} |`)
  const g = gameOf(rec) ?? 'unknown'
  const types = g === 'unknown' ? undefined : GAMES[g].labels
  const bucket = perGame.get(g) ?? perGame.set(g, { all: emptyScores(), groups: new Map() }).get(g)!
  scoreTake(rec, take, bucket.all, types)
  if (by) {
    const key = by === 'distance' ? `${rec.distanceM} m` : by === 'person' ? rec.person : rec.lighting
    scoreTake(rec, take, bucket.groups.get(key) ?? bucket.groups.set(key, emptyScores()).get(key)!, types)
  }
}

for (const [g, { all, groups }] of perGame) {
  const name = g === 'unknown' ? 'Unknown game' : GAMES[g].name
  console.log(`\n## ${name}\n\n${formatScores(all)}\n\n### What fired during each labelled set\n\n${formatConfusion(all)}`)
  for (const [key, s] of groups) console.log(`\n### ${name}, ${by}: ${key}\n\n${formatScores(s)}`)
}
console.log('\nTargets: each motion >= 90% detected, false triggers < 5% of reps, idle fires nothing. ⚠ = below target.')
