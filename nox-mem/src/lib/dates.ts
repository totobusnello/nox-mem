/**
 * src/lib/dates.ts — flexible date parsing for the temporal search filter (P3).
 *
 * Accepted:
 *   ISO 8601 date:   "2026-05-01"            (midnight UTC)
 *   ISO 8601 full:   "2026-05-01T12:00:00Z"
 *   Relative:        "15m" | "2h" | "7d" | "1w"   (that long before `nowMs`)
 *
 * "1mo" is deliberately unsupported (months have no fixed length) — use "30d".
 * Throws TemporalParseError on anything else, so surfaces can answer 400 / exit 2
 * instead of silently searching without the filter.
 */

export class TemporalParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemporalParseError";
  }
}

const RELATIVE_RE = /^(\d+)(m|h|d|w)$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Requires at least YYYY-MM-DDTHH:MM so bare numbers or "May 1" are rejected
// (Date.parse accepts both, with locale-dependent results).
const ISO_FULL_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseFlexibleDate(input: string, nowMs: number = Date.now()): Date {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) throw new TemporalParseError("temporal: empty date string");

  const rel = RELATIVE_RE.exec(trimmed);
  if (rel) {
    const n = parseInt(rel[1]!, 10);
    return new Date(nowMs - n * UNIT_MS[rel[2]!.toLowerCase()]!);
  }

  let normalised: string | null = null;
  if (DATE_ONLY_RE.test(trimmed)) normalised = `${trimmed}T00:00:00Z`;
  else if (ISO_FULL_RE.test(trimmed)) normalised = trimmed;

  const d = normalised ? new Date(normalised) : null;
  if (!d || isNaN(d.getTime())) {
    throw new TemporalParseError(
      `temporal: cannot parse date "${input}". ` +
        `Accepted: ISO 8601 ("2026-05-01" or "2026-05-01T00:00:00Z") ` +
        `or relative ("15m", "2h", "7d", "1w"). "1mo" is not supported — use "30d".`,
    );
  }
  return d;
}

export interface TemporalFilter {
  /** Time-travel: only chunks that existed at this instant. */
  asOf?: Date;
  /** Recency window: only chunks created or updated after this instant. */
  changedSince?: Date;
}

/** Parses the raw strings each surface receives; undefined/empty means "not set". */
export function parseTemporalFilter(
  raw: { asOf?: string | null; changedSince?: string | null },
  nowMs: number = Date.now(),
): TemporalFilter | undefined {
  const filter: TemporalFilter = {};
  if (raw.asOf != null && String(raw.asOf).trim() !== "") filter.asOf = parseFlexibleDate(raw.asOf, nowMs);
  if (raw.changedSince != null && String(raw.changedSince).trim() !== "") {
    filter.changedSince = parseFlexibleDate(raw.changedSince, nowMs);
  }
  return filter.asOf || filter.changedSince ? filter : undefined;
}

/**
 * SQL fragment over the `chunks` alias `c` (semantics: docs/PRIMITIVES.md §3).
 *
 *   asOf:          created_at IS NULL (legacy rows count as "always existed")
 *                  OR created_at <= asOf
 *   changedSince:  updated_at > since OR created_at > since
 *
 * Both sides go through datetime(): the columns hold `datetime('now')` text
 * ("YYYY-MM-DD HH:MM:SS") while the bound value is ISO ("...T...Z"), and a
 * plain string comparison between the two formats is wrong (' ' < 'T').
 * There is no soft-delete column in the schema, so no deleted_at leg.
 *
 * Returns null when the filter is empty so callers keep their exact SQL.
 */
export function buildTemporalClause(filter: TemporalFilter | undefined): { sql: string; params: string[] } | null {
  if (!filter || (!filter.asOf && !filter.changedSince)) return null;
  const parts: string[] = [];
  const params: string[] = [];
  if (filter.asOf) {
    parts.push("(c.created_at IS NULL OR datetime(c.created_at) <= datetime(?))");
    params.push(filter.asOf.toISOString());
  }
  if (filter.changedSince) {
    const ts = filter.changedSince.toISOString();
    parts.push("(datetime(c.updated_at) > datetime(?) OR datetime(c.created_at) > datetime(?))");
    params.push(ts, ts);
  }
  return { sql: parts.join(" AND "), params };
}
