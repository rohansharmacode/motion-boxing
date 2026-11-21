// Stretch: POST /api/ask {player_id?, question} -> {answer, sql?}
// Text-to-SQL with Snowflake Cortex, guarded by sqlGuard (SELECT-only, table allowlist),
// wrapped in a hard row limit, and executed under a read-only role with a statement timeout.

import { Router } from 'express';
import type { AppConfig } from './config';
import type { Cortex } from './cortex';
import { HttpError } from './errors';
import type { Logger } from './logger';
import type { Repo } from './repo/types';
import { AskBody } from './schemas';
import { guardSql } from './sqlGuard';
import { errorMessage, withTimeout } from './util';

export const SCHEMA_DOC = `
Snowflake database MOTION_DB, schema PUBLIC. Timestamps are TIMESTAMP_NTZ in UTC.
PLAYERS(player_id, name, created_at)
SESSIONS(session_id, player_id, sport, started_at, ended_at, score, total_punches, avg_speed, max_speed,
  avg_reaction_ms, best_reaction_ms, accuracy /*0..1*/, ai_coach_json /*VARIANT {tips, drill, badge, summary}*/)
MOTION_EVENTS(event_id, session_id, player_id, sport, event_ts, event_type /*jab|cross|hook|uppercut|block*/,
  hand /*L|R*/, speed_mps, accuracy /*0..1, NULL for blocks*/, reaction_ms, guard_up BOOLEAN, points)
PRO_BENCHMARKS(sport, metric, p25, p50, p75, p90, pro_avg, higher_is_better)
  metrics: punch_speed_mps, reaction_ms (lower better), accuracy_pct, guard_pct, symmetry_pct, fatigue_drop_pct (lower better)
PLAYER_FORM(player_id, name, sessions, punches, avg_speed, max_speed, avg_reaction_ms, best_reaction_ms, accuracy_pct,
  fatigue_drop_pct, symmetry_pct, guard_pct, mix_jab_pct, mix_cross_pct, mix_hook_pct, mix_uppercut_pct, mix_block_pct,
  form_score /*0..100*/)
V_LEADERBOARD(rank, player_id, name, best_score, score, fastest_punch, best_reaction_ms)
V_GLOBAL_STATS(total_players, total_sessions, total_punches, avg_speed, max_speed)
V_SESSION_STATS(session_id, player_id, sport, started_at, ended_at, score, total_punches, avg_speed, max_speed,
  avg_reaction_ms, best_reaction_ms, accuracy, accuracy_pct, guard_pct, total_blocks, total_events, duration_s)
V_SPEED_OVER_TIME(session_id, player_id, bucket, bucket_start_s, minute, punches, avg_speed, max_speed)
V_FATIGUE_CURVE(player_id, quartile /*1-4*/, avg_speed, punches, sessions)
`.trim();

export function buildSqlPrompt(question: string, playerId?: string): string {
  return [
    'You translate questions about a boxing game into ONE Snowflake SQL SELECT statement.',
    'Schema:',
    SCHEMA_DOC,
    '',
    'Rules:',
    '- Output ONLY the SQL. No explanation, no markdown, no code fences, no comments, no semicolon.',
    '- A single SELECT (a WITH ... SELECT is fine). Never modify data. Use only the tables/views above.',
    '- Prefer the views and PLAYER_FORM for aggregates. Always add LIMIT 50 or less.',
    playerId
      ? `- "I", "me", "my" refer to the player with player_id = '${playerId}'.`
      : '- No current player is known; answer for all players.',
    "- If the question cannot be answered from this data, output exactly: SELECT 'unanswerable' AS note",
    '',
    `Question: ${JSON.stringify(question)}`,
    'SQL:',
  ].join('\n');
}

export function buildAnswerPrompt(question: string, sql: string, rows: Record<string, unknown>[]): string {
  let data = JSON.stringify(rows);
  if (data.length > 6000) data = data.slice(0, 6000) + ' ...(truncated)';
  return [
    'You are a friendly boxing coach. Answer the question in at most 3 short sentences using ONLY the query result.',
    'If the result is empty or says unanswerable, say you do not have that data yet. Plain text only.',
    `Question: ${JSON.stringify(question)}`,
    `SQL used: ${sql}`,
    `Result rows (JSON): ${data}`,
    'Answer:',
  ].join('\n');
}

/** Pull the SQL out of a model reply (handles code fences, "SQL:" prefixes and {"sql": ...}). */
export function extractSql(reply: string): string {
  let s = reply.trim();
  const fence = s.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) s = fence[1].trim();
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as { sql?: unknown };
      if (typeof obj.sql === 'string') s = obj.sql.trim();
    } catch {
      /* not JSON */
    }
  }
  s = s.replace(/^sql\s*:\s*/i, '').trim();
  return s;
}

function plainAnswer(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "I couldn't find any data for that yet.";
  const preview = rows
    .slice(0, 3)
    .map((r) =>
      Object.entries(r)
        .map(([k, v]) => `${k}: ${v === null ? '-' : String(v)}`)
        .join(', '),
    )
    .join('; ');
  return `Found ${rows.length} row${rows.length === 1 ? '' : 's'}. ${preview}`;
}

export function createAskRouter(deps: { repo: Repo; cortex: Cortex; config: AppConfig; log: Logger }): Router {
  const { repo, cortex, config, log } = deps;
  const router = Router();

  router.post('/api/ask', async (req, res) => {
    const { question, player_id } = AskBody.parse(req.body);
    const timeoutMs = config.ask.cortexTimeoutMs;

    let reply: string;
    try {
      reply = await withTimeout(cortex.complete(buildSqlPrompt(question, player_id), { purpose: 'sql', timeoutMs }), timeoutMs, 'cortex sql');
    } catch (err) {
      log.warn('ask: Cortex text-to-SQL failed', { error: errorMessage(err) });
      throw new HttpError(503, 'cortex_unavailable', 'The AI coach is unavailable right now, please try again');
    }

    const guarded = guardSql(typeof reply === 'string' ? extractSql(reply) : reply);
    if (!guarded.ok) {
      log.warn('ask: generated SQL rejected', { reason: guarded.reason });
      throw new HttpError(422, 'unsafe_sql', `Generated SQL was rejected: ${guarded.reason}`);
    }

    let rows: Record<string, unknown>[];
    try {
      rows = await repo.runReadOnlyQuery(guarded.sql, config.ask.rowLimit);
    } catch (err) {
      log.warn('ask: query failed', { error: errorMessage(err) });
      throw new HttpError(502, 'query_failed', 'Could not run the generated query', { sql: guarded.sql });
    }

    let answer: string;
    try {
      const text = await withTimeout(
        cortex.complete(buildAnswerPrompt(question, guarded.sql, rows), { purpose: 'answer', timeoutMs }),
        timeoutMs,
        'cortex answer',
      );
      answer = typeof text === 'string' && text.trim() ? text.trim().slice(0, 1000) : plainAnswer(rows);
    } catch (err) {
      log.warn('ask: Cortex answer failed; using plain summary', { error: errorMessage(err) });
      answer = plainAnswer(rows);
    }

    res.json({ answer, sql: guarded.sql });
  });

  return router;
}
