import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from './logger';

/** Error that maps directly to an HTTP response: {error: code, message, details?}. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Await a storage call; any non-HTTP failure becomes 503 storage_unavailable. */
export async function db<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(503, 'storage_unavailable', 'The database is unavailable, please retry', { cause: msg.slice(0, 300) });
  }
}

export function zodDetails(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join('.') || '(body)', message: i.message }));
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` });
};

export function errorHandler(log: Logger): ErrorRequestHandler {
  // Express identifies error middleware by arity, so all four params must stay.
  return (err, req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'validation_error', message: 'Request body is invalid', details: zodDetails(err) });
      return;
    }
    // body-parser errors carry a `type` and `status`.
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large', message: 'Request body is too large' });
      return;
    }
    if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
      res.status(e.status).json({ error: 'bad_request', message: e.message ?? 'Bad request' });
      return;
    }
    log.error('unhandled error', { method: req.method, path: req.path, error: e?.message ?? String(err) });
    res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
  };
}
