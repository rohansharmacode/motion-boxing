import type { SqlExecutor } from './snowflake/executor';
import { withTimeout } from './util';

export type CortexPurpose = 'coach' | 'sql' | 'answer';

export interface CompleteOptions {
  purpose: CortexPurpose;
  timeoutMs: number;
}

/** LLM completion surface (Snowflake Cortex in real mode, canned replies in mock mode). */
export interface Cortex {
  readonly model: string;
  complete(prompt: string, opts: CompleteOptions): Promise<string>;
}

/** SNOWFLAKE.CORTEX.COMPLETE(model, prompt) with both arguments bound. */
export class SnowflakeCortex implements Cortex {
  constructor(
    private readonly db: SqlExecutor,
    readonly model: string,
  ) {}

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    // The executor cancels the statement on timeout; withTimeout is a second, JS-side guard
    // (covers time spent waiting for a pooled connection).
    const { rows } = await withTimeout(
      this.db.query('SELECT SNOWFLAKE.CORTEX.COMPLETE(?, ?) AS response', [this.model, prompt], { timeoutMs: opts.timeoutMs }),
      opts.timeoutMs,
      `cortex ${opts.purpose}`,
    );
    const v = rows[0]?.response;
    if (typeof v !== 'string') throw new Error('Cortex returned no text');
    return v;
  }
}

export const MOCK_COACH_REPLY = JSON.stringify({
  tips: [
    'Bring your rear hand back to your chin straight after every cross.',
    'Exhale sharply on each punch to keep your speed up in the last quarter.',
    'Mix in more hooks off the lead hand to balance your left and right.',
  ],
  drill: '3 x 1-minute rounds of jab-cross-hook combinations, 30 s rest, guard checked in a mirror.',
  badge: 'Sharp Shooter',
  summary: 'Solid round with quick hands; tighten the guard and keep the pace through the final quarter.',
});

export const MOCK_SQL_REPLY =
  'SELECT rank, name, score, fastest_punch, best_reaction_ms FROM V_LEADERBOARD ORDER BY rank LIMIT 10';

export const MOCK_ANSWER_REPLY =
  'Mock mode: here is the current leaderboard. Connect Snowflake (unset SNOWFLAKE_MOCK) for real answers to your question.';

/** Canned replies so every endpoint works without credentials (SNOWFLAKE_MOCK=1). */
export class MockCortex implements Cortex {
  readonly model = 'mock';
  readonly calls: { prompt: string; purpose: CortexPurpose }[] = [];

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    this.calls.push({ prompt, purpose: opts.purpose });
    switch (opts.purpose) {
      case 'coach':
        return MOCK_COACH_REPLY;
      case 'sql':
        return MOCK_SQL_REPLY;
      case 'answer':
        return MOCK_ANSWER_REPLY;
    }
  }
}
