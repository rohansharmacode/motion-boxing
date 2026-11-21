import { COACH_MODEL_PARAMETERS, coachResponseFormatLiteral } from './coachStructured';
import type { SqlExecutor } from './snowflake/executor';
import { toObjectLiteral } from './sqlLiteral';
import { TimeoutError, errorMessage, withTimeout } from './util';

export type CortexPurpose = 'coach' | 'sql' | 'answer';

export interface CompleteOptions {
  purpose: CortexPurpose;
  timeoutMs: number;
}

export type FeatureState = 'up' | 'missing' | 'error' | 'unknown' | 'mock';

/** What the server has observed about Cortex so far (GET /api/snowflake/status; no LLM call needed). */
export interface CortexHealth {
  complete: { status: FeatureState; detail?: string };
  structured: { status: FeatureState; detail?: string };
}

/** AI_COMPLETE structured output is not available here (unknown function / unsupported argument). */
export class StructuredUnsupportedError extends Error {
  constructor(cause: string) {
    super(`structured output unsupported: ${cause}`);
    this.name = 'StructuredUnsupportedError';
  }
}

/**
 * Errors that mean "this account / model cannot do structured output" rather than a transient
 * failure. Snowflake reports both as SQL compilation errors.
 */
export function isUnsupportedError(err: unknown): boolean {
  if (err instanceof TimeoutError) return false;
  return /SQL compilation error|unknown function|invalid argument|unsupported|not supported|does not support|invalid identifier|response_format/i.test(
    errorMessage(err),
  );
}

/** LLM completion surface (Snowflake Cortex in real mode, canned replies in mock mode). */
export interface Cortex {
  readonly model: string;
  complete(prompt: string, opts: CompleteOptions): Promise<string>;
  /**
   * Coach card with the COACH_CARD_SCHEMA response_format. Returns the raw OBJECT (or its JSON
   * text). Throws StructuredUnsupportedError when structured output cannot work here.
   */
  completeStructured?(prompt: string, opts: CompleteOptions): Promise<unknown>;
  /** False once structured output is known not to work (remembered for the process lifetime). */
  structuredAvailable?(): boolean;
  health?(): CortexHealth;
}

/** SELECT AI_COMPLETE(model => ?, prompt => ?, model_parameters => {...}, response_format => {...}). */
export function structuredCompleteSql(): string {
  return [
    'SELECT AI_COMPLETE(',
    '  model => ?,',
    '  prompt => ?,',
    `  model_parameters => ${toObjectLiteral(COACH_MODEL_PARAMETERS)},`,
    `  response_format => ${coachResponseFormatLiteral()}`,
    ') AS response',
  ].join('\n');
}

/** SNOWFLAKE.CORTEX.COMPLETE(model, prompt) with both arguments bound. */
export class SnowflakeCortex implements Cortex {
  private completeState: CortexHealth['complete'] = { status: 'unknown' };
  private structuredState: CortexHealth['structured'];
  private structuredOff: boolean;

  constructor(
    private readonly db: SqlExecutor,
    readonly model: string,
    opts: { structured?: boolean } = {},
  ) {
    this.structuredOff = opts.structured === false;
    this.structuredState = this.structuredOff ? { status: 'missing', detail: 'disabled (CORTEX_STRUCTURED=0)' } : { status: 'unknown' };
  }

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    // The executor cancels the statement on timeout; withTimeout is a second, JS-side guard
    // (covers time spent waiting for a pooled connection).
    try {
      const { rows } = await withTimeout(
        this.db.query('SELECT SNOWFLAKE.CORTEX.COMPLETE(?, ?) AS response', [this.model, prompt], { timeoutMs: opts.timeoutMs }),
        opts.timeoutMs,
        `cortex ${opts.purpose}`,
      );
      const v = rows[0]?.response;
      if (typeof v !== 'string') throw new Error('Cortex returned no text');
      this.completeState = { status: 'up', detail: `SNOWFLAKE.CORTEX.COMPLETE ok (${this.model})` };
      return v;
    } catch (err) {
      // A timeout says nothing about availability; keep the last known state.
      if (!(err instanceof TimeoutError)) this.completeState = { status: 'error', detail: errorMessage(err).slice(0, 200) };
      throw err;
    }
  }

  structuredAvailable(): boolean {
    return !this.structuredOff;
  }

  async completeStructured(prompt: string, opts: CompleteOptions): Promise<unknown> {
    if (this.structuredOff) throw new StructuredUnsupportedError(this.structuredState.detail ?? 'disabled');
    try {
      const { rows } = await withTimeout(
        this.db.query(structuredCompleteSql(), [this.model, prompt], { timeoutMs: opts.timeoutMs }),
        opts.timeoutMs,
        `cortex ${opts.purpose} (structured)`,
      );
      const v = rows[0]?.response;
      if (v === null || v === undefined) throw new Error('AI_COMPLETE returned no value');
      this.structuredState = { status: 'up', detail: `AI_COMPLETE response_format ok (${this.model})` };
      this.completeState = { status: 'up', detail: `AI_COMPLETE ok (${this.model})` };
      return v;
    } catch (err) {
      if (isUnsupportedError(err)) {
        this.structuredOff = true;
        this.structuredState = { status: 'missing', detail: errorMessage(err).slice(0, 200) };
        throw new StructuredUnsupportedError(errorMessage(err));
      }
      throw err;
    }
  }

  health(): CortexHealth {
    return { complete: { ...this.completeState }, structured: { ...this.structuredState } };
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

/** What AI_COMPLETE with the coach response_format returns (an OBJECT). */
export const MOCK_STRUCTURED_CARD = {
  headline: 'Quick hands, now lock in that guard.',
  summary: 'Solid round with quick hands; tighten the guard and keep the pace through the final quarter.',
  tips: [
    'Bring your rear hand back to your chin straight after every cross.',
    'Exhale sharply on each punch to keep your speed up in the last quarter.',
    'Mix in more hooks off the lead hand to balance your left and right.',
  ],
  drill: {
    name: 'Glove-to-Chin Rounds',
    description: '3 x 1 min of jab-cross-hook; the non-punching glove touches the chin before every punch.',
  },
  badge: { name: 'Sharp Shooter', description: 'Fast, accurate hands this round.' },
  focus: 'guard',
};

/** Canned replies so every endpoint works without credentials (SNOWFLAKE_MOCK=1). */
export class MockCortex implements Cortex {
  readonly model = 'mock';
  readonly calls: { prompt: string; purpose: CortexPurpose; structured?: boolean }[] = [];

  async completeStructured(prompt: string, opts: CompleteOptions): Promise<unknown> {
    this.calls.push({ prompt, purpose: opts.purpose, structured: true });
    return structuredClone(MOCK_STRUCTURED_CARD);
  }

  structuredAvailable(): boolean {
    return true;
  }

  health(): CortexHealth {
    return { complete: { status: 'mock' }, structured: { status: 'mock' } };
  }

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
