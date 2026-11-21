export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(level: LogLevel = 'info'): Logger {
  const min = ORDER[level] ?? ORDER.info;
  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, meta?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}${meta ? ' ' + safeJson(meta) : ''}`;
    if (lvl === 'error' || lvl === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
  };
}

export const silentLogger: Logger = createLogger('silent');

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
}
