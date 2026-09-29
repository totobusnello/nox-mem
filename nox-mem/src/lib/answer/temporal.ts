/**
 * src/lib/answer/temporal.ts — turns the raw `as_of` / `changed_since` values each
 * answer surface receives (CLI flag, HTTP body field, MCP argument) into the same
 * TemporalFilter that `search` uses, with one rule added on top of parseTemporalFilter:
 *
 *   a value that was PROVIDED must be usable. parseTemporalFilter reads "" (and
 *   whitespace) as "not set", which is right for an absent query-string key but would
 *   turn `--as-of ""` / `{"as_of": ""}` into a silently unfiltered answer — so here a
 *   blank string, or anything that is not a string, throws TemporalParseError.
 *
 * `undefined` / `null` still mean "not set". Each surface maps the thrown
 * TemporalParseError to its own error channel (CLI exit 2 / HTTP 400 / MCP isError).
 */

import { parseTemporalFilter, TemporalParseError, type TemporalFilter } from "../dates.js";

export interface RawTemporalInput {
  asOf?: unknown;
  changedSince?: unknown;
}

function checked(name: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new TemporalParseError(`temporal: ${name} must be a string (ISO 8601 date or relative like "7d")`);
  }
  if (value.trim() === "") {
    throw new TemporalParseError(
      `temporal: ${name} is empty — omit it to answer without a temporal filter`
    );
  }
  return value;
}

export function resolveTemporalFilter(
  raw: RawTemporalInput,
  nowMs: number = Date.now()
): TemporalFilter | undefined {
  const asOfStr = checked("as_of", raw.asOf);
  const sinceStr = checked("changed_since", raw.changedSince);

  const filter: TemporalFilter = {};
  if (asOfStr !== undefined) {
    try {
      filter.asOf = parseTemporalFilter({ asOf: asOfStr }, nowMs)?.asOf;
    } catch (err) {
      if (err instanceof TemporalParseError) throw new TemporalParseError(`as_of: ${err.message}`);
      throw err;
    }
  }
  if (sinceStr !== undefined) {
    try {
      filter.changedSince = parseTemporalFilter({ changedSince: sinceStr }, nowMs)?.changedSince;
    } catch (err) {
      if (err instanceof TemporalParseError) throw new TemporalParseError(`changed_since: ${err.message}`);
      throw err;
    }
  }
  return filter.asOf || filter.changedSince ? filter : undefined;
}
