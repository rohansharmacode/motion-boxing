import type { LogLevel } from './logger';

export interface SnowflakeConfig {
  account: string;
  username: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  privateKeyPass?: string;
  role: string;
  warehouse: string;
  database: string;
  schema: string;
  /** Role used only by POST /api/ask (text-to-SQL). Must be SELECT-only. */
  readOnlyRole: string;
  poolMax: number;
  /** Default per-statement timeout (ms) for normal app queries. */
  queryTimeoutMs: number;
}

export interface EventQueueConfig {
  /** Max events accepted in one POST /api/events request. */
  maxBatch: number;
  /** Max events written by one multi-row INSERT. */
  chunkSize: number;
  /** Max events buffered in memory before POST /api/events returns 503. */
  maxQueue: number;
  /** How long POST /api/events waits for the write before answering queued:true. */
  ackWaitMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** After this many failed attempts on one chunk, drop it if Snowflake itself is reachable (poison data). */
  maxAttemptsBeforeDrop: number;
}

export interface AppConfig {
  mock: boolean;
  port: number;
  corsOrigins: string[];
  logLevel: LogLevel;
  cortexModel: string;
  /** Hard timeout for the coach-card Cortex call (contract: 8 s). */
  coachTimeoutMs: number;
  /** POST /api/session/end waits this long for that session's queued events to land. */
  sessionEndFlushWaitMs: number;
  /** Converts the front end's peak_velocity (shoulder-widths/s) to m/s. */
  shoulderWidthM: number;
  events: EventQueueConfig;
  ask: { rowLimit: number; cortexTimeoutMs: number; queryTimeoutMs: number };
  /** Undefined in mock mode. */
  snowflake?: SnowflakeConfig;
}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${key}=${raw}: expected an integer in [${min}, ${max}]`);
  }
  return n;
}

function str(env: Env, key: string, def = ''): string {
  const v = env[key];
  return v === undefined || v.trim() === '' ? def : v.trim();
}

export function isTruthy(v: string | undefined): boolean {
  return v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

export function loadConfig(env: Env = process.env): AppConfig {
  const mock = isTruthy(env.SNOWFLAKE_MOCK);
  const logLevel = (str(env, 'LOG_LEVEL', 'info') as LogLevel);

  const cfg: AppConfig = {
    mock,
    port: int(env, 'PORT', 3001, 1, 65535),
    corsOrigins: str(env, 'CORS_ORIGIN', 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel,
    cortexModel: str(env, 'CORTEX_MODEL', 'mistral-large2'),
    coachTimeoutMs: int(env, 'COACH_TIMEOUT_MS', 8000, 100, 120_000),
    sessionEndFlushWaitMs: int(env, 'SESSION_END_FLUSH_WAIT_MS', 5000, 0, 60_000),
    shoulderWidthM: Number(str(env, 'SHOULDER_WIDTH_M', '0.4')) > 0 ? Number(str(env, 'SHOULDER_WIDTH_M', '0.4')) : 0.4,
    events: {
      maxBatch: int(env, 'EVENTS_MAX_BATCH', 500, 1, 5000),
      chunkSize: int(env, 'EVENTS_INSERT_CHUNK', 500, 1, 5000),
      maxQueue: int(env, 'EVENTS_MAX_QUEUE', 50_000, 1, 10_000_000),
      ackWaitMs: int(env, 'EVENTS_ACK_WAIT_MS', 50, 0, 10_000),
      retryBaseMs: int(env, 'EVENTS_RETRY_BASE_MS', 250, 1, 60_000),
      retryMaxMs: int(env, 'EVENTS_RETRY_MAX_MS', 15_000, 1, 600_000),
      maxAttemptsBeforeDrop: int(env, 'EVENTS_MAX_ATTEMPTS', 8, 1, 1000),
    },
    ask: {
      rowLimit: int(env, 'ASK_ROW_LIMIT', 100, 1, 1000),
      cortexTimeoutMs: int(env, 'ASK_CORTEX_TIMEOUT_MS', 15_000, 100, 120_000),
      queryTimeoutMs: int(env, 'ASK_QUERY_TIMEOUT_MS', 10_000, 100, 120_000),
    },
  };

  if (!mock) {
    const missing = ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USER'].filter((k) => !str(env, k));
    const hasKey = Boolean(str(env, 'SNOWFLAKE_PRIVATE_KEY_PATH') || str(env, 'SNOWFLAKE_PRIVATE_KEY'));
    const hasPassword = Boolean(str(env, 'SNOWFLAKE_PASSWORD'));
    if (!hasKey && !hasPassword) missing.push('SNOWFLAKE_PRIVATE_KEY_PATH (or SNOWFLAKE_PRIVATE_KEY / SNOWFLAKE_PASSWORD)');
    if (missing.length) {
      throw new Error(
        `Missing Snowflake settings: ${missing.join(', ')}. ` +
          `Copy server/.env.example to server/.env and fill it in, or set SNOWFLAKE_MOCK=1 to run without Snowflake.`,
      );
    }
    cfg.snowflake = {
      account: str(env, 'SNOWFLAKE_ACCOUNT'),
      username: str(env, 'SNOWFLAKE_USER'),
      password: str(env, 'SNOWFLAKE_PASSWORD') || undefined,
      // Allow the PEM to be pasted on one line with literal "\n" sequences.
      privateKey: str(env, 'SNOWFLAKE_PRIVATE_KEY').replace(/\\n/g, '\n') || undefined,
      privateKeyPath: str(env, 'SNOWFLAKE_PRIVATE_KEY_PATH') || undefined,
      privateKeyPass: str(env, 'SNOWFLAKE_PRIVATE_KEY_PASSPHRASE') || undefined,
      role: str(env, 'SNOWFLAKE_ROLE', 'MOTION_APP_ROLE'),
      warehouse: str(env, 'SNOWFLAKE_WAREHOUSE', 'MOTION_WH'),
      database: str(env, 'SNOWFLAKE_DATABASE', 'MOTION_DB'),
      schema: str(env, 'SNOWFLAKE_SCHEMA', 'PUBLIC'),
      readOnlyRole: str(env, 'SNOWFLAKE_READONLY_ROLE', 'MOTION_READONLY_ROLE'),
      poolMax: int(env, 'SNOWFLAKE_POOL_MAX', 4, 1, 32),
      queryTimeoutMs: int(env, 'SNOWFLAKE_QUERY_TIMEOUT_MS', 20_000, 100, 600_000),
    };
  }
  return cfg;
}
