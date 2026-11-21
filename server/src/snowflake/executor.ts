import type { SnowflakeConfig } from '../config';
import { TimeoutError } from '../util';

export type Bind = string | number | boolean | null;
export type Row = Record<string, unknown>;

export interface QueryResult {
  /** Rows with lower-cased column keys (Snowflake returns UPPERCASE). */
  rows: Row[];
  /** For DML: number of rows inserted/updated, when the driver reports it. */
  numUpdated?: number;
}

/** Minimal SQL execution surface used by SnowflakeRepo / SnowflakeCortex (fakeable in tests). */
export interface SqlExecutor {
  query(sqlText: string, binds?: Bind[], opts?: { timeoutMs?: number }): Promise<QueryResult>;
  close(): Promise<void>;
}

/** Lower-case keys and turn driver-specific values into plain JSON-able values. */
export function normalizeRow(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k.toLowerCase()] = normalizeValue(v);
  return out;
}

function normalizeValue(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function' && !Array.isArray(v)) {
    // SfDate / SfTimestamp
    return (v as { toJSON: () => unknown }).toJSON();
  }
  return v;
}

/**
 * snowflake-sdk backed executor with a small connection pool. Every statement is sent with bind
 * variables; a JS-side timeout cancels the running statement.
 */
export async function createSnowflakeExecutor(cfg: SnowflakeConfig, role: string): Promise<SqlExecutor> {
  // Lazy import so mock mode never loads the driver.
  const snowflake = (await import('snowflake-sdk')).default;
  snowflake.configure({ logLevel: 'ERROR' });

  const options: Record<string, unknown> = {
    account: cfg.account,
    username: cfg.username,
    role,
    warehouse: cfg.warehouse,
    database: cfg.database,
    schema: cfg.schema,
    application: 'motion-boxing-server',
    clientSessionKeepAlive: true,
  };
  if (cfg.privateKey || cfg.privateKeyPath) {
    options.authenticator = 'SNOWFLAKE_JWT';
    if (cfg.privateKey) options.privateKey = cfg.privateKey;
    else options.privateKeyPath = cfg.privateKeyPath;
    if (cfg.privateKeyPass) options.privateKeyPass = cfg.privateKeyPass;
  } else {
    options.password = cfg.password;
  }

  const pool = snowflake.createPool(options as never, {
    max: cfg.poolMax,
    min: 0,
    acquireTimeoutMillis: 30_000,
    testOnBorrow: true,
    evictionRunIntervalMillis: 60_000,
    idleTimeoutMillis: 300_000,
  });

  return {
    async query(sqlText, binds = [], opts = {}) {
      const timeoutMs = opts.timeoutMs ?? cfg.queryTimeoutMs;
      return pool.use(
        (conn) =>
          new Promise<QueryResult>((resolve, reject) => {
            let settled = false;
            let timer: NodeJS.Timeout | undefined;
            const stmt = conn.execute({
              sqlText,
              binds,
              complete: (err, st, rows) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (err) return reject(err);
                let numUpdated: number | undefined;
                try {
                  numUpdated = (st as { getNumUpdatedRows?: () => number | undefined }).getNumUpdatedRows?.();
                } catch {
                  numUpdated = undefined;
                }
                resolve({ rows: (rows ?? []).map((r) => normalizeRow(r as Row)), numUpdated });
              },
            });
            if (timeoutMs > 0) {
              timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try {
                  stmt.cancel(() => undefined);
                } catch {
                  /* best effort */
                }
                reject(new TimeoutError('snowflake query', timeoutMs));
              }, timeoutMs);
            }
          }),
      );
    },
    async close() {
      await pool.drain();
      await pool.clear();
    },
  };
}
