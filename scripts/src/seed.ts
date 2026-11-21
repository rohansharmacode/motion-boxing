import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { generate, SEED_TAG, type GenResult } from './generator.js';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const val = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

const seed = Number(val('seed') ?? 42);
const data = generate({ seed, players: Number(val('players') ?? 20), sessionsPerPlayer: Number(val('sessions') ?? 3) });

function summary(d: GenResult) {
  const ev = d.sessions.reduce((a, s) => a + s.events.length, 0);
  console.log(`seed=${d.seed} players=${d.players.length} sessions=${d.sessions.length} events=${ev}`);
  for (const s of d.sessions.slice(0, 3)) {
    const p = d.players.find((x) => x.player_id === s.player_id)!;
    console.log(`  ${p.name}: ${s.events.length} events`, JSON.stringify(s.stats));
  }
}

// ---------- API mode ----------
async function viaApi(base: string, d: GenResult) {
  const call = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
    return r.json() as Promise<any>;
  };
  if (flag('reset')) console.warn('--reset is not supported in --api mode (no delete endpoint); ignoring');
  const ids = new Map<string, string>();
  for (const p of d.players) ids.set(p.player_id, (await call('/api/players', { name: p.name })).player_id);
  let n = 0;
  for (const s of d.sessions) {
    const pid = ids.get(s.player_id)!;
    const sid = (await call('/api/session/start', { player_id: pid, sport: 'boxing' })).session_id;
    for (let i = 0; i < s.events.length; i += 50) {
      await call('/api/events', s.events.slice(i, i + 50).map((e) => ({ ...e, session_id: sid, player_id: pid, sport: 'boxing' })));
    }
    await call('/api/session/end', { session_id: sid });
    n += s.events.length;
  }
  console.log(`API seed done: ${d.players.length} players, ${d.sessions.length} sessions, ${n} events -> ${base}`);
}

// ---------- Snowflake mode ----------
function loadEnvFile() {
  for (const f of ['../server/.env', '.env']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (v: number | null) => (v == null ? 'NULL' : String(v));

async function viaSnowflake(d: GenResult) {
  loadEnvFile();
  const e = process.env;
  const missing = ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USER', 'SNOWFLAKE_PASSWORD'].filter((k) => !e[k]);
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
  const sf: any = (await import('snowflake-sdk')).default;
  const conn = sf.createConnection({
    account: e.SNOWFLAKE_ACCOUNT, username: e.SNOWFLAKE_USER, password: e.SNOWFLAKE_PASSWORD,
    role: e.SNOWFLAKE_ROLE ?? 'MOTION_APP_ROLE', warehouse: e.SNOWFLAKE_WAREHOUSE ?? 'MOTION_WH',
    database: e.SNOWFLAKE_DATABASE ?? 'MOTION_DB', schema: e.SNOWFLAKE_SCHEMA ?? 'PUBLIC',
  });
  await new Promise<void>((res, rej) => conn.connect((err: Error) => (err ? rej(err) : res())));
  const run = (sqlText: string) => new Promise<any[]>((res, rej) =>
    conn.execute({ sqlText, complete: (err: Error, _s: unknown, rows: any[]) => (err ? rej(err) : res(rows ?? [])) }));
  const batched = async (head: string, rows: string[], size = 200) => {
    for (let i = 0; i < rows.length; i += size) await run(`${head} VALUES ${rows.slice(i, i + size).join(',')}`);
  };
  try {
    if (flag('reset')) {
      const tag = `name LIKE '%${SEED_TAG.replace(/'/g, "''")}'`;
      const sub = `SELECT player_id FROM PLAYERS WHERE ${tag}`;
      await run(`DELETE FROM MOTION_EVENTS WHERE player_id IN (${sub})`);
      await run(`DELETE FROM SESSIONS WHERE player_id IN (${sub})`);
      await run(`DELETE FROM PLAYERS WHERE ${tag}`);
      console.log('reset: removed prior seeded rows');
    }
    await batched('INSERT INTO PLAYERS (player_id, name, created_at)', d.players.map((p) => `(${q(p.player_id)},${q(p.name)},CURRENT_TIMESTAMP())`));
    await batched('INSERT INTO SESSIONS (session_id, player_id, sport, started_at, ended_at, score, total_punches, avg_speed, max_speed, avg_reaction_ms, best_reaction_ms, accuracy)',
      d.sessions.map((s) => `(${q(s.session_id)},${q(s.player_id)},'boxing',${q(s.started_at.slice(0, 23))},${q(s.ended_at.slice(0, 23))},${s.stats.score},${s.stats.total_punches},${s.stats.avg_speed},${s.stats.max_speed},${num(s.stats.avg_reaction_ms)},${num(s.stats.best_reaction_ms)},${s.stats.accuracy})`));
    const evRows: string[] = [];
    let k = 0;
    for (const s of d.sessions) for (const ev of s.events) {
      evRows.push(`(${q(`${s.session_id.slice(0, 27)}${String(k++).padStart(9, '0')}`)},${q(s.session_id)},${q(s.player_id)},'boxing',${q(ev.event_ts.slice(0, 23))},${q(ev.event_type)},${q(ev.hand)},${ev.speed_mps},${num(ev.accuracy)},${num(ev.reaction_ms)},${ev.guard_up},${ev.points})`);
    }
    await batched('INSERT INTO MOTION_EVENTS (event_id, session_id, player_id, sport, event_ts, event_type, hand, speed_mps, accuracy, reaction_ms, guard_up, points)', evRows, 500);
    console.log(`Snowflake seed done: ${d.players.length} players, ${d.sessions.length} sessions, ${evRows.length} events`);
  } finally {
    conn.destroy(() => {});
  }
}

async function main() {
  const out = val('json');
  if (out) { writeFileSync(out, JSON.stringify(data, null, 2)); console.log(`wrote ${out}`); }
  if (flag('dry-run')) return summary(data);
  if (out && !flag('api') && !val('api')) return;
  summary(data);
  const api = val('api');
  if (api) return viaApi(api.replace(/\/$/, ''), data);
  return viaSnowflake(data);
}
main().catch((err) => { console.error(err); process.exit(1); });
