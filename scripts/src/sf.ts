// Shared Snowflake connection for the CLI scripts. Reads server/.env (never printed).
// Auth: SNOWFLAKE_PRIVATE_KEY_PATH (key pair) or SNOWFLAKE_PASSWORD.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadServerEnv(): NodeJS.ProcessEnv {
  const f = path.join(ROOT, 'server', '.env');
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2];
    }
  }
  return process.env;
}

export interface Conn {
  exec(sql: string, binds?: unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** role: override SNOWFLAKE_ROLE (e.g. ACCOUNTADMIN for setup). Pass null to use the user's default role. */
export async function connect(opts: { role?: string | null; database?: string | null } = {}): Promise<Conn> {
  const e = loadServerEnv();
  const missing = ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USER'].filter((k) => !e[k]);
  if (!e.SNOWFLAKE_PASSWORD && !e.SNOWFLAKE_PRIVATE_KEY_PATH) missing.push('SNOWFLAKE_PASSWORD or SNOWFLAKE_PRIVATE_KEY_PATH');
  if (missing.length) throw new Error(`server/.env is missing: ${missing.join(', ')}`);
  const sf: any = (await import('snowflake-sdk')).default;
  sf.configure?.({ logLevel: 'ERROR' });
  const auth = e.SNOWFLAKE_PRIVATE_KEY_PATH
    ? {
        authenticator: 'SNOWFLAKE_JWT',
        privateKeyPath: path.resolve(ROOT, 'server', e.SNOWFLAKE_PRIVATE_KEY_PATH),
        ...(e.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE ? { privateKeyPass: e.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE } : {}),
      }
    : { password: e.SNOWFLAKE_PASSWORD };
  const role = opts.role === undefined ? e.SNOWFLAKE_ROLE : opts.role;
  const database = opts.database === undefined ? e.SNOWFLAKE_DATABASE : opts.database;
  const conn = sf.createConnection({
    account: e.SNOWFLAKE_ACCOUNT,
    username: e.SNOWFLAKE_USER,
    ...auth,
    ...(role ? { role } : {}),
    ...(database ? { database, schema: e.SNOWFLAKE_SCHEMA ?? 'PUBLIC' } : {}),
    ...(e.SNOWFLAKE_WAREHOUSE ? { warehouse: e.SNOWFLAKE_WAREHOUSE } : {}),
  });
  await new Promise<void>((res, rej) => conn.connect((err: Error) => (err ? rej(err) : res())));
  return {
    exec: (sqlText, binds = []) =>
      new Promise((res, rej) =>
        conn.execute({ sqlText, binds, complete: (err: Error, _s: unknown, rows: Record<string, unknown>[]) => (err ? rej(err) : res(rows ?? [])) }),
      ),
    close: () => new Promise((res) => conn.destroy(() => res())),
  };
}

/** Splits a SQL script into statements; ignores ';' inside comments, '...' strings and $$ blocks. */
export function splitSql(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const two = text.slice(i, i + 2);
    if (two === '--' || two === '//') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end + 1;
      cur += '\n';
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      cur += ' ';
    } else if (two === '$$') {
      const end = text.indexOf('$$', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      cur += text.slice(i, stop);
      i = stop;
    } else if (c === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') j += 2;
        else if (text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === "'") break;
        else j++;
      }
      cur += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
