// Times AI_COMPLETE with a coach-sized prompt (cold, then warm).
// Usage: npx tsx src/cortex-latency.ts [model] [runs]
import { connect, loadServerEnv } from './sf';

const model = process.argv[2] ?? loadServerEnv().CORTEX_MODEL ?? 'mistral-large3';
const runs = Number(process.argv[3] ?? 3);
const prompt =
  'You are a boxing coach. Round stats: {"score":420,"total_punches":38,"avg_speed_mps":6.4,"accuracy":0.71,"guard_up_pct":58}. ' +
  'Reply with ONLY JSON: {"tips":["","",""],"drill":"<Name>: <drill>","badge":"","summary":""}';
const conn = await connect();
try {
  for (let i = 0; i < runs; i++) {
    const t = Date.now();
    const rows = await conn.exec('SELECT AI_COMPLETE(?, ?) AS R', [model, prompt]);
    const ms = Date.now() - t;
    console.log(`${i === 0 ? 'cold' : 'warm'} run ${i + 1}: ${ms} ms ${ms < 5000 ? 'OK (<5s)' : 'SLOW (>=5s)'}  ${String(rows[0]?.R ?? '').slice(0, 80)}…`);
  }
} finally {
  await conn.close();
}
