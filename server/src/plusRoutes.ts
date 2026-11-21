// Snowflake Plus endpoints (sql/PLUS_CONTRACT.md "New server endpoints"). Every route answers 200
// with available:false when its Snowflake objects are missing, so the original game never depends
// on the PLUS SQL files having been run.

import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from './config';
import type { Cortex } from './cortex';
import { FOCUSES, type DrillSearchResult } from './drills';
import { FOCUS_QUERY } from './coachStructured';
import { HttpError, db, zodDetails } from './errors';
import type { Logger } from './logger';
import type { Repo } from './repo/types';
import { IdSchema } from './schemas';
import type { FeatureProbe, RepoFeatureProbes } from './types';
import { errorMessage } from './util';

const intParam = (min: number, max: number, def: number) => z.coerce.number().int().min(min).max(max).default(def);

export const HighlightsQuery = z.object({ limit: intParam(1, 50, 20) });
export const ProgressQuery = z.object({ limit: intParam(1, 200, 50) });
export const DrillSearchQuery = z.object({
  q: z.string().trim().max(200, 'must be at most 200 characters').optional(),
  focus: z.enum(FOCUSES).optional(),
  limit: intParam(1, 10, 5),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, 'validation_error', `Invalid ${what}`, zodDetails(r.error));
  return r.data;
}

/** Small TTL cache with a size cap; also shares one in-flight computation per key. */
class TtlCache<T> {
  private entries = new Map<string, { at: number; value: Promise<T> }>();
  constructor(
    private readonly ttlMs: number,
    private readonly cap = 200,
  ) {}

  get(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = compute();
    this.entries.set(key, { at: Date.now(), value });
    value.catch(() => this.entries.delete(key));
    if (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return value;
  }
}

export interface SnowflakeStatus {
  mode: 'snowflake' | 'mock';
  features: Record<
    'dynamic_tables' | 'cortex_complete' | 'structured_output' | 'cortex_search' | 'streams_tasks' | 'vectors' | 'cortex_analyst',
    FeatureProbe
  >;
  player_form_last_refresh?: string | null;
  checked_at: string;
}

export function createPlusRouter({ repo, cortex, config, log }: { repo: Repo; cortex: Cortex; config: AppConfig; log: Logger }): Router {
  const router = Router();
  const drillCache = new TtlCache<DrillSearchResult>(60_000);
  const statusCache = new TtlCache<SnowflakeStatus>(config.statusCacheMs, 1);

  async function requirePlayer(raw: unknown): Promise<string> {
    const id = parse(IdSchema, raw, 'player id');
    const player = await db(repo.getPlayer(id));
    if (!player) throw new HttpError(404, 'player_not_found', `Unknown player_id ${id}`);
    return id;
  }

  router.get('/api/player/:id/style', async (req, res) => {
    const id = await requirePlayer(req.params.id);
    res.json(await db(repo.playerStyle(id)));
  });

  router.get('/api/player/:id/progress', async (req, res) => {
    const id = await requirePlayer(req.params.id);
    const { limit } = parse(ProgressQuery, req.query, 'query');
    res.json(await db(repo.playerProgress(id, limit)));
  });

  router.get('/api/highlights', async (req, res) => {
    const { limit } = parse(HighlightsQuery, req.query, 'query');
    res.json(await db(repo.highlights(limit)));
  });

  router.get('/api/drills/search', async (req, res) => {
    const { q, focus, limit } = parse(DrillSearchQuery, req.query, 'query');
    const query = q || (focus ? FOCUS_QUERY[focus] : 'boxing drill');
    const key = JSON.stringify([query.toLowerCase(), focus ?? null, limit]);
    const result = await db(drillCache.get(key, () => repo.searchDrills(query, { focus: focus ?? null, limit, timeoutMs: config.drillSearchTimeoutMs })));
    res.json(result);
  });

  async function buildStatus(): Promise<SnowflakeStatus> {
    let probes: RepoFeatureProbes;
    try {
      probes = await repo.probeFeatures(config.statusProbeTimeoutMs);
    } catch (err) {
      // probeFeatures should never throw; this keeps the endpoint at 200 even if it does.
      const error: FeatureProbe = { status: 'error', detail: errorMessage(err).slice(0, 200) };
      probes = { dynamic_tables: error, cortex_search: error, streams_tasks: error, vectors: error };
    }
    const mock = repo.mode === 'mock';
    const health = cortex.health?.();
    const unknown: FeatureProbe = { status: mock ? 'mock' : 'unknown', detail: 'no Cortex call observed yet' };
    return {
      mode: repo.mode,
      features: {
        dynamic_tables: probes.dynamic_tables,
        cortex_complete: health?.complete.status === 'unknown' ? unknown : (health?.complete ?? unknown),
        structured_output: health?.structured.status === 'unknown' ? unknown : (health?.structured ?? unknown),
        cortex_search: probes.cortex_search,
        streams_tasks: probes.streams_tasks,
        vectors: probes.vectors,
        cortex_analyst: { status: 'streamlit', detail: 'Cortex Analyst runs in Streamlit in Snowflake (streamlit/), semantic model @MOTION_DB.PUBLIC.SEMANTIC_MODELS/motion_boxing.yaml' },
      },
      ...(probes.player_form_last_refresh !== undefined ? { player_form_last_refresh: probes.player_form_last_refresh } : {}),
      checked_at: new Date().toISOString(),
    };
  }

  router.get('/api/snowflake/status', async (_req, res) => {
    try {
      res.json(await statusCache.get('status', buildStatus));
    } catch (err) {
      log.warn('snowflake status failed', { error: errorMessage(err) });
      const error: FeatureProbe = { status: 'error', detail: 'status check failed' };
      res.json({
        mode: repo.mode,
        features: {
          dynamic_tables: error,
          cortex_complete: error,
          structured_output: error,
          cortex_search: error,
          streams_tasks: error,
          vectors: error,
          cortex_analyst: { status: 'streamlit' },
        },
        checked_at: new Date().toISOString(),
      });
    }
  });

  return router;
}
