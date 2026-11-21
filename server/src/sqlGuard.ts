// Strict guard for LLM-generated SQL (POST /api/ask). Defence in depth: this guard, a hard row
// limit, a statement timeout, and a SELECT-only Snowflake role. The guard errs on the side of
// rejecting: one SELECT (optionally WITH ...) over an allowlist of tables, no comments, no
// multiple statements, no DDL/DML/session keywords, no stages, no system/AI functions.

export const ALLOWED_TABLES = [
  'PLAYERS',
  'SESSIONS',
  'MOTION_EVENTS',
  'PRO_BENCHMARKS',
  'PLAYER_FORM',
  'V_LEADERBOARD',
  'V_GLOBAL_STATS',
  'V_SESSION_STATS',
  'V_SPEED_OVER_TIME',
  'V_FATIGUE_CURVE',
] as const;

const FORBIDDEN_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'CREATE', 'ALTER', 'DROP', 'UNDROP', 'TRUNCATE',
  'RENAME', 'GRANT', 'REVOKE', 'CALL', 'EXECUTE', 'EXEC', 'IMMEDIATE', 'PROCEDURE', 'COPY', 'PUT',
  'REMOVE', 'USE', 'SET', 'UNSET', 'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'DECLARE', 'LET',
  'SHOW', 'DESCRIBE', 'EXPLAIN', 'INTO', 'STAGE', 'PIPE', 'TASK', 'SNOWFLAKE', 'INFORMATION_SCHEMA',
  'ACCOUNT_USAGE', 'CORTEX', 'IDENTIFIER', 'RESULT_SCAN', 'GENERATOR', 'SYSTEM', 'GETVARIABLE',
  'SESSION_CONTEXT',
]);

const FROM_FUNCS = new Set(['EXTRACT', 'TRIM', 'SUBSTRING', 'SUBSTR', 'POSITION', 'OVERLAY']);

const CLAUSE_WORDS = new Set([
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'QUALIFY', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'EXCEPT',
  'MINUS', 'INTERSECT', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL',
  'ON', 'USING', 'WINDOW', 'SAMPLE', 'TABLESAMPLE', 'LATERAL', 'PIVOT', 'UNPIVOT',
  'MATCH_RECOGNIZE', 'AT', 'BEFORE', 'CHANGES', 'CONNECT', 'START', 'ASOF', 'SELECT', 'FROM', 'AS',
]);

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

type Tok =
  | { t: 'word'; v: string } // unquoted identifier/keyword, upper-cased
  | { t: 'qident'; v: string } // "Quoted" identifier, raw content
  | { t: 'str' }
  | { t: 'num' }
  | { t: 'punct'; v: string };

function fail(reason: string): GuardResult {
  return { ok: false, reason };
}

function tokenize(sql: string): Tok[] | string {
  const toks: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "'") {
      // Single-quoted string with '' and \' escapes.
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          closed = true;
          break;
        } else i++;
      }
      if (!closed) return 'unterminated string literal';
      toks.push({ t: 'str' });
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end < 0) return 'unterminated quoted identifier';
      toks.push({ t: 'qident', v: sql.slice(i + 1, end) });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      toks.push({ t: 'word', v: sql.slice(i, j).toUpperCase() });
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < sql.length && /[0-9.eE]/.test(sql[j]!)) j++;
      toks.push({ t: 'num' });
      i = j;
    } else {
      toks.push({ t: 'punct', v: c });
      i++;
    }
  }
  return toks;
}

function isWord(tok: Tok | undefined, v?: string): tok is { t: 'word'; v: string } {
  return tok?.t === 'word' && (v === undefined || tok.v === v);
}
function isPunct(tok: Tok | undefined, v: string): boolean {
  return tok?.t === 'punct' && tok.v === v;
}
function isIdent(tok: Tok | undefined): tok is { t: 'word'; v: string } | { t: 'qident'; v: string } {
  return tok?.t === 'word' || tok?.t === 'qident';
}

export function guardSql(raw: unknown, opts: { allowedTables?: readonly string[]; maxLength?: number } = {}): GuardResult {
  if (typeof raw !== 'string') return fail('no SQL generated');
  const allowed = new Set((opts.allowedTables ?? ALLOWED_TABLES).map((t) => t.toUpperCase()));
  let sql = raw.trim();
  if (sql.endsWith(';')) sql = sql.slice(0, -1).trim();
  if (!sql) return fail('empty SQL');
  if (sql.length > (opts.maxLength ?? 4000)) return fail('SQL is too long');
  if (/--|\/\*|\*\/|\/\//.test(sql)) return fail('comments are not allowed');
  if (sql.includes('$$')) return fail('dollar-quoted strings are not allowed');

  const toks = tokenize(sql);
  if (typeof toks === 'string') return fail(toks);
  if (toks.length === 0) return fail('empty SQL');

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (tok.t === 'punct') {
      if (tok.v === ';') return fail('multiple statements are not allowed');
      if (tok.v === '@') return fail('stage references are not allowed');
      if (tok.v === '$') return fail('positional/stage columns are not allowed');
      if (tok.v === '{' || tok.v === '}') return fail('unexpected braces');
    }
    if (tok.t === 'word') {
      if (FORBIDDEN_WORDS.has(tok.v)) return fail(`keyword ${tok.v} is not allowed`);
      if (tok.v.includes('$')) return fail(`identifier ${tok.v} is not allowed`);
      // AI_COMPLETE(), AI_CLASSIFY(), ... (but not columns such as ai_coach_json)
      if (/^AI_/.test(tok.v) && isPunct(toks[i + 1], '(')) return fail(`function ${tok.v} is not allowed`);
    }
  }

  const first = toks[0];
  if (!isWord(first, 'SELECT') && !isWord(first, 'WITH')) return fail('only SELECT queries are allowed');

  // CTE names: <name> AS (
  const ctes = new Set<string>();
  for (let i = 0; i + 2 < toks.length; i++) {
    const a = toks[i];
    if (isIdent(a) && isWord(toks[i + 1], 'AS') && isPunct(toks[i + 2], '(')) ctes.add(a.v.toUpperCase());
  }

  // Walk FROM / JOIN clauses and validate every table reference.
  const parenOwner: (string | null)[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (isPunct(tok, '(')) {
      const prev = toks[i - 1];
      parenOwner.push(isWord(prev) ? prev.v : null);
      continue;
    }
    if (isPunct(tok, ')')) {
      parenOwner.pop();
      continue;
    }
    if (!isWord(tok, 'FROM') && !isWord(tok, 'JOIN')) continue;
    if (tok.v === 'FROM') {
      const owner = parenOwner[parenOwner.length - 1];
      if (owner && FROM_FUNCS.has(owner)) continue; // EXTRACT(year FROM ts) etc.
      if (isWord(toks[i - 1], 'DISTINCT')) continue; // IS [NOT] DISTINCT FROM
    }
    const err = checkFromList(toks, i + 1, tok.v === 'FROM', allowed, ctes);
    if (err) return fail(err);
  }

  return { ok: true, sql };
}

/** Validates the table list starting at toks[i]. Returns an error string or null. */
function checkFromList(toks: Tok[], i: number, allowComma: boolean, allowed: Set<string>, ctes: Set<string>): string | null {
  for (;;) {
    const tok = toks[i];
    if (!tok) return 'missing table after FROM/JOIN';
    if (isPunct(tok, '(')) return null; // subquery: its own FROM clauses are checked by the main walk
    if (isWord(tok, 'LATERAL')) {
      i++;
      if (!isWord(toks[i], 'FLATTEN') || !isPunct(toks[i + 1], '(')) return 'only LATERAL FLATTEN(...) is allowed';
      return null;
    }
    if (isWord(tok, 'TABLE')) {
      if (isPunct(toks[i + 1], '(') && isWord(toks[i + 2], 'FLATTEN')) return null;
      return 'table functions are not allowed';
    }
    if (isWord(tok, 'FLATTEN') && isPunct(toks[i + 1], '(')) return null;
    if (!isIdent(tok)) return 'invalid table reference';

    // Dotted name: a[.b[.c]]
    const parts: string[] = [tok.v.toUpperCase()];
    i++;
    while (isPunct(toks[i], '.') && isIdent(toks[i + 1])) {
      parts.push((toks[i + 1] as { v: string }).v.toUpperCase());
      i += 2;
    }
    if (isPunct(toks[i], '(')) return `table function ${parts.join('.')} is not allowed`;
    const table = parts[parts.length - 1]!;
    const qual = parts.slice(0, -1).join('.');
    if (parts.length > 3) return `invalid table name ${parts.join('.')}`;
    if (qual && qual !== 'PUBLIC' && qual !== 'MOTION_DB.PUBLIC') return `schema ${qual} is not allowed`;
    if (!allowed.has(table) && !(parts.length === 1 && ctes.has(table))) return `table ${parts.join('.')} is not allowed`;

    // Optional alias.
    if (isWord(toks[i], 'AS')) i += 2;
    else if (toks[i]?.t === 'qident' || (isWord(toks[i]) && !CLAUSE_WORDS.has((toks[i] as { v: string }).v))) i++;

    if (allowComma && isPunct(toks[i], ',')) {
      i++;
      continue;
    }
    return null;
  }
}
