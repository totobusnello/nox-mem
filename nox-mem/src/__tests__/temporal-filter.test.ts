// P3 — temporal filter (--as-of / --changed-since) as a hard SQL pre-filter.
//
// Covers the parser, the SQL fragment, and the real search() path against a
// throwaway DB, including the two traps the staged P3 patch had:
//   - `created_at` holds datetime('now') text ("YYYY-MM-DD HH:MM:SS") while the
//     bound value is ISO ("...T...Z"); a raw string comparison gets it wrong;
//   - there is no deleted_at column, so a clause that names it fails at runtime.
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/temporal-filter.test.js)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseFlexibleDate,
  parseTemporalFilter,
  buildTemporalClause,
  TemporalParseError,
} from "../lib/dates.js";

const TMP_ROOT = mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-temporal-test-"));
process.env.NOX_DB_PATH = join(TMP_ROOT, "test.db");
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;

const NOW = Date.parse("2026-09-28T12:00:00Z");

// ─── parser ──────────────────────────────────────────────────────────────────

test("parseFlexibleDate: date-only is midnight UTC", () => {
  assert.equal(parseFlexibleDate("2026-05-01", NOW).toISOString(), "2026-05-01T00:00:00.000Z");
});

test("parseFlexibleDate: full ISO", () => {
  assert.equal(parseFlexibleDate("2026-05-01T10:30:00Z", NOW).toISOString(), "2026-05-01T10:30:00.000Z");
  assert.equal(parseFlexibleDate("2026-05-01T10:30:00-03:00", NOW).toISOString(), "2026-05-01T13:30:00.000Z");
});

test("parseFlexibleDate: ISO without offset is UTC, not local time", () => {
  assert.equal(parseFlexibleDate("2026-05-01T10:30:00", NOW).toISOString(), "2026-05-01T10:30:00.000Z");
});

test("parseTemporalFilter: date-only as-of is END of day, changed-since START of day", () => {
  const f = parseTemporalFilter({ asOf: "2026-05-01", changedSince: "2026-05-01" }, NOW)!;
  assert.equal(f.asOf!.toISOString(), "2026-05-01T23:59:59.999Z");
  assert.equal(f.changedSince!.toISOString(), "2026-05-01T00:00:00.000Z");
});

test("parseFlexibleDate: relative units count back from now", () => {
  assert.equal(parseFlexibleDate("15m", NOW).getTime(), NOW - 15 * 60_000);
  assert.equal(parseFlexibleDate("2h", NOW).getTime(), NOW - 2 * 3_600_000);
  assert.equal(parseFlexibleDate("7d", NOW).getTime(), NOW - 7 * 86_400_000);
  assert.equal(parseFlexibleDate("1w", NOW).getTime(), NOW - 7 * 86_400_000);
  assert.equal(parseFlexibleDate("7D", NOW).getTime(), NOW - 7 * 86_400_000);
});

test("parseFlexibleDate: rejects what Date.parse would guess at", () => {
  for (const bad of ["", "   ", "1mo", "yesterday", "May 1", "12345", "2026-13-45", "7x"]) {
    assert.throws(() => parseFlexibleDate(bad, NOW), TemporalParseError, `should reject ${JSON.stringify(bad)}`);
  }
});

test("parseTemporalFilter: nothing set ⇒ undefined (callers keep the unfiltered path)", () => {
  assert.equal(parseTemporalFilter({}, NOW), undefined);
  assert.equal(parseTemporalFilter({ asOf: "", changedSince: undefined }, NOW), undefined);
  assert.equal(parseTemporalFilter({ asOf: null, changedSince: null }, NOW), undefined);
});

test("parseTemporalFilter: a bad value throws instead of being dropped", () => {
  assert.throws(() => parseTemporalFilter({ asOf: "2026-05-01", changedSince: "soon" }, NOW), TemporalParseError);
});

// ─── SQL fragment ────────────────────────────────────────────────────────────

test("buildTemporalClause: empty filter ⇒ null, so the search SQL is unchanged", () => {
  assert.equal(buildTemporalClause(undefined), null);
  assert.equal(buildTemporalClause({}), null);
});

test("buildTemporalClause: never references deleted_at (column does not exist)", () => {
  const c = buildTemporalClause({ asOf: new Date(NOW), changedSince: new Date(NOW) })!;
  assert.doesNotMatch(c.sql, /deleted_at/);
  assert.equal(c.params.length, 3);
});

// ─── search() against a real schema ──────────────────────────────────────────

let getDb: any, closeDb: any, search: any, searchSemantic: any;

before(async () => {
  ({ getDb, closeDb } = await import("../db.js"));
  ({ search, searchSemantic } = await import("../search.js"));
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO chunks (source_file, chunk_type, chunk_text, source_date, created_at, updated_at)
     VALUES (?, 'other', ?, NULL, ?, ?)`,
  );
  // created_at in the format SQLite's DEFAULT writes…
  ins.run("old.md", "zebra migration notes, first draft", "2026-01-10 08:00:00", "2026-01-10 08:00:00");
  // …a row edited long after it was created…
  ins.run("edited.md", "zebra migration notes, revised", "2026-01-15 08:00:00", "2026-09-27 09:00:00");
  // …a recent row stored as ISO…
  ins.run("new.md", "zebra migration notes, final", "2026-09-26T10:00:00.000Z", "2026-09-26T10:00:00.000Z");
  // …and a legacy row with no created_at at all.
  ins.run("legacy.md", "zebra migration notes, legacy import", null, null);
});

after(() => {
  closeDb();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const files = (rs: Array<{ source_file: string }>) => rs.map((r) => r.source_file).sort();

test("search: no filter returns every match (baseline)", () => {
  assert.deepEqual(files(search("zebra", 10, false)), ["edited.md", "legacy.md", "new.md", "old.md"]);
});

test("search: as-of keeps what existed then, plus legacy rows (spec: NULL = always existed)", () => {
  const f = parseTemporalFilter({ asOf: "2026-02-01" }, NOW);
  assert.deepEqual(files(search("zebra", 10, false, f)), ["edited.md", "legacy.md", "old.md"]);
});

test("search: as-of compares datetimes, not strings ('2026-01-10 08:00:00' vs '2026-01-10T…')", () => {
  // String comparison would say "2026-01-10 08:00:00" <= "2026-01-10T06:00:00.000Z"
  // (space sorts before 'T') and wrongly keep old.md, created at 08:00.
  const f = parseTemporalFilter({ asOf: "2026-01-10T06:00:00Z" }, NOW);
  assert.deepEqual(files(search("zebra", 10, false, f)), ["legacy.md"]);
});

test("search: date-only as-of includes rows created later that same day", () => {
  const f = parseTemporalFilter({ asOf: "2026-01-10" }, NOW);
  assert.deepEqual(files(search("zebra", 10, false, f)), ["legacy.md", "old.md"]);
});

test("search: changed-since picks created OR updated after the date", () => {
  const f = parseTemporalFilter({ changedSince: "7d" }, NOW);
  assert.deepEqual(files(search("zebra", 10, false, f)), ["edited.md", "new.md"]);
});

test("search: both flags AND together", () => {
  const f = parseTemporalFilter({ asOf: "2026-02-01", changedSince: "7d" }, NOW);
  assert.deepEqual(files(search("zebra", 10, false, f)), ["edited.md"]);
});

test("searchSemantic: the FTS fallback (empty vector index) keeps the filter", async () => {
  const f = parseTemporalFilter({ changedSince: "7d" }, NOW);
  assert.deepEqual(files(await searchSemantic("zebra", 10, false, f)), ["edited.md", "new.md"]);
});
