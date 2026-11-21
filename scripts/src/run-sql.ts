// Runs sql/*.sql files against Snowflake using server/.env. Usage:
//   npx tsx src/run-sql.ts ../sql/setup.sql ../sql/analytics.sql [--role ACCOUNTADMIN]
// The setup files start with USE ROLE ACCOUNTADMIN, so the .env user must have that role.
import { readFileSync } from 'node:fs';
import { connect, splitSql } from './sf';

const args = process.argv.slice(2);
const roleIdx = args.indexOf('--role');
const role = roleIdx >= 0 ? args.splice(roleIdx, 2)[1]! : 'ACCOUNTADMIN';
if (!args.length) {
  console.error('usage: run-sql.ts <file.sql>... [--role ROLE]');
  process.exit(2);
}

const conn = await connect({ role, database: null });
let failed = 0;
try {
  for (const file of args) {
    const stmts = splitSql(readFileSync(file, 'utf8'));
    console.log(`== ${file}: ${stmts.length} statements`);
    for (const [n, s] of stmts.entries()) {
      const label = s.replace(/\s+/g, ' ').slice(0, 90);
      const t = Date.now();
      try {
        const rows = await conn.exec(s);
        console.log(`  ok  ${String(n + 1).padStart(3)} ${label} (${Date.now() - t} ms${rows.length ? `, ${rows.length} rows` : ''})`);
        if (/^\s*select/i.test(s) && rows.length && rows.length <= 40) console.table(rows);
      } catch (err) {
        failed++;
        console.log(`  ERR ${String(n + 1).padStart(3)} ${label}\n      ${(err as Error).message}`);
      }
    }
  }
} finally {
  await conn.close();
}
if (failed) {
  console.error(`${failed} statement(s) failed`);
  process.exit(1);
}
