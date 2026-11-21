// Builders for Snowflake constant expressions. Only used for server-controlled values (JSON
// schemas, model parameters, search requests) that Snowflake requires as constants rather than
// bind variables.

export type LiteralValue = string | number | boolean | null | LiteralValue[] | { [key: string]: LiteralValue };

/** Single-quoted Snowflake string literal. Backslash is an escape character inside '...'. */
export function sqlString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** {'k': v} OBJECT constant / ['a', 'b'] ARRAY constant, recursively. */
export function toObjectLiteral(v: LiteralValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return sqlString(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number in SQL literal');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (Array.isArray(v)) return `[${v.map(toObjectLiteral).join(', ')}]`;
  const entries = Object.entries(v).map(([k, val]) => `${sqlString(k)}: ${toObjectLiteral(val)}`);
  return `{${entries.join(', ')}}`;
}

/**
 * JSON text wrapped in $$ ... $$. JSON allows $ for "$" inside strings and "$" never appears
 * outside strings, so this removes every "$$" (which would end the literal) without changing the value.
 */
export function dollarQuotedJson(value: unknown): string {
  const json = JSON.stringify(value).replace(/\$/g, '\\u0024');
  return '$$' + json + '$$';
}
