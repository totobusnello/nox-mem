// FTS5 OR fallback — natural-language questions on keyless installs.
//
// FTS5 ANDs a space-separated query, so "when was the zebra migration" matches
// nothing unless every filler word is in the chunk. search() retries with an OR
// of the content terms, but ONLY when the AND query returned zero rows, and only
// when NOX_FTS_OR_FALLBACK allows it (auto = no embedding key in the env).
//
// The DB is isolated with NOX_DB_PATH in a mkdtemp BEFORE db.js is imported.
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/fts-or-fallback.test.js)

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseTemporalFilter } from "../lib/dates.js";

const TMP_ROOT = mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-fts-or-test-"));
process.env.NOX_DB_PATH = join(TMP_ROOT, "test.db");
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.NOX_FTS_OR_FALLBACK;
delete process.env.NOX_EMBEDDING_API_KEY;
delete process.env.NOX_EMBED_API_KEY;

const NOW = Date.parse("2026-09-28T12:00:00Z");
const QUESTION = "when was the zebra migration";

let getDb: any, closeDb: any, search: any, buildFtsOrQuery: any, ftsOrFallbackEnabled: any;

before(async () => {
  ({ getDb, closeDb } = await import("../db.js"));
  ({ search, buildFtsOrQuery, ftsOrFallbackEnabled } = await import("../search.js"));
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO chunks (source_file, chunk_type, chunk_text, source_date, created_at, updated_at)
     VALUES (?, 'other', ?, NULL, ?, ?)`,
  );
  // The chunk the question must find (none of when/was/the is in it).
  ins.run("zebra.md", "zebra migration yesterday", "2026-09-01 08:00:00", "2026-09-01 08:00:00");
  // AND-vs-OR discriminator: "aardvark tunnel" ANDs to fig.md only; OR would add fig2.md.
  ins.run("fig.md", "aardvark tunnel survey", "2026-09-01 08:00:00", "2026-09-01 08:00:00");
  ins.run("fig2.md", "aardvark burrow notes", "2026-09-01 08:00:00", "2026-09-01 08:00:00");
  // Temporal pair for the OR branch: same words, different age.
  ins.run("quokka-old.md", "quokka census results", "2026-01-10 08:00:00", "2026-01-10 08:00:00");
  ins.run("quokka-new.md", "quokka census results", "2026-09-26T10:00:00.000Z", "2026-09-26T10:00:00.000Z");
});

after(() => {
  closeDb();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// Each test sets exactly the env it needs; the gate must be read per call.
beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.NOX_FTS_OR_FALLBACK;
});

const files = (rs: Array<{ source_file: string }>) => rs.map((r) => r.source_file).sort();

// ─── helpers ─────────────────────────────────────────────────────────────────

test("buildFtsOrQuery: stopwords out, terms quoted, ORed, deduplicated", () => {
  assert.equal(buildFtsOrQuery(QUESTION), '"zebra" OR "migration"');
  assert.equal(buildFtsOrQuery("Zebra zebra ZEBRA migration"), '"Zebra" OR "migration"');
  assert.equal(buildFtsOrQuery("quando foi a migração da zebra"), '"migração" OR "zebra"');
});

test("buildFtsOrQuery: only stopwords ⇒ null; embedded quotes are doubled", () => {
  assert.equal(buildFtsOrQuery("what is the"), null);
  assert.equal(buildFtsOrQuery("o que é"), null);
  assert.equal(buildFtsOrQuery('a"b'), '"a""b"');
});

test("ftsOrFallbackEnabled: gate matrix", () => {
  assert.equal(ftsOrFallbackEnabled({}), true);
  // Any key the embedding provider resolves counts as "has embeddings".
  assert.equal(ftsOrFallbackEnabled({ NOX_EMBEDDING_API_KEY: "k" }), false);
  assert.equal(ftsOrFallbackEnabled({ NOX_EMBED_API_KEY: "k" }), false);
  assert.equal(ftsOrFallbackEnabled({ NOX_FTS_OR_FALLBACK: "auto" }), true);
  assert.equal(ftsOrFallbackEnabled({ GEMINI_API_KEY: "k" }), false);
  assert.equal(ftsOrFallbackEnabled({ OPENAI_API_KEY: "k" }), false);
  assert.equal(ftsOrFallbackEnabled({ NOX_FTS_OR_FALLBACK: "on", GEMINI_API_KEY: "k" }), true);
  assert.equal(ftsOrFallbackEnabled({ NOX_FTS_OR_FALLBACK: "off" }), false);
});

// ─── search() ────────────────────────────────────────────────────────────────

test("(1) auto, no key: a natural-language question finds the chunk", () => {
  assert.deepEqual(files(search(QUESTION, 10, false)), ["zebra.md"]);
});

test("(2) auto WITH an embedding key in the env: same question returns [] as before", () => {
  process.env.GEMINI_API_KEY = "test-key";
  assert.deepEqual(search(QUESTION, 10, false), []);
  delete process.env.GEMINI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  assert.deepEqual(search(QUESTION, 10, false), []);
});

test("(3) off: [] even without a key", () => {
  process.env.NOX_FTS_OR_FALLBACK = "off";
  assert.deepEqual(search(QUESTION, 10, false), []);
});

test("on: forces the fallback even with a key", () => {
  process.env.NOX_FTS_OR_FALLBACK = "on";
  process.env.GEMINI_API_KEY = "test-key";
  assert.deepEqual(files(search(QUESTION, 10, false)), ["zebra.md"]);
});

test("(4) AND already hits: result identical (order and scores) with the fallback on and off", () => {
  process.env.NOX_FTS_OR_FALLBACK = "on";
  const on = search("aardvark tunnel", 10, false);
  process.env.NOX_FTS_OR_FALLBACK = "off";
  const off = search("aardvark tunnel", 10, false);
  assert.deepEqual(files(off), ["fig.md"]); // OR would also have pulled fig2.md
  assert.deepEqual(on, off);
});

test("(5) stopwords only: no fallback, even forced on", () => {
  process.env.NOX_FTS_OR_FALLBACK = "on";
  assert.deepEqual(search("what was the", 10, false), []);
  assert.deepEqual(search("o que é a", 10, false), []);
});

test("(6) the temporal filter is honoured on the OR branch", () => {
  const q = "when was the quokka census";
  assert.deepEqual(files(search(q, 10, false)), ["quokka-new.md", "quokka-old.md"]);
  const since = parseTemporalFilter({ changedSince: "7d" }, NOW);
  assert.deepEqual(files(search(q, 10, false, since)), ["quokka-new.md"]);
  const asOf = parseTemporalFilter({ asOf: "2026-02-01" }, NOW);
  assert.deepEqual(files(search(q, 10, false, asOf)), ["quokka-old.md"]);
});
