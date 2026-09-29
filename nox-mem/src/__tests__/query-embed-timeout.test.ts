// A slow embedding provider is not an error, so before 2026-09-28 a search whose
// query embedding hung simply waited: the FTS5 fallback in searchSemantic only runs
// on a thrown error. The query embedding now has a time budget
// (NOX_QUERY_EMBED_TIMEOUT_MS, default 5000 ms, 0 = off); on expiry search falls
// back to FTS5 instead of waiting.
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/query-embed-timeout.test.js)

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TMP_ROOT = realpathSync(mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-embed-timeout-")));
process.env.NOX_DB_PATH = join(TMP_ROOT, "t.db");
delete process.env.OPENCLAW_WORKSPACE;
for (const k of ["GEMINI_API_KEY", "OPENAI_API_KEY", "NOX_EMBEDDING_API_KEY", "NOX_EMBED_API_KEY"]) delete process.env[k];

let embed: any, search: any, dbmod: any;

/** An embedding call that never resolves; records whether it was aborted. */
function hangingEmbed(state: { aborted: boolean }) {
  return (_text: string, signal?: AbortSignal) =>
    new Promise<Float32Array>(() => {
      signal?.addEventListener("abort", () => { state.aborted = true; });
    });
}

before(async () => {
  embed = await import("../embed.js");
  search = await import("../search.js");
  dbmod = await import("../db.js");
  const { ingestFile } = await import("../ingest.js");
  const note = join(TMP_ROOT, "zebra.md");
  writeFileSync(note, "# Zebra\n\nThe zebra migration happened in the spring.\n");
  await ingestFile(note);
  // Make the vector index look non-empty so searchSemantic reaches the embed call.
  const db = dbmod.getDb();
  embed.ensureVecTable(db);
  const id = (db.prepare("SELECT id FROM chunks LIMIT 1").get() as { id: number }).id;
  db.prepare("INSERT INTO vec_chunk_map (vec_rowid, chunk_id) VALUES (?, ?)").run(1, id);
});

afterEach(() => {
  embed.__setEmbedForTests(null);
  delete process.env.NOX_QUERY_EMBED_TIMEOUT_MS;
});

after(() => {
  try { dbmod.closeDb(); } catch { /* ignore */ }
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

test("queryEmbedTimeoutMs: default 5000, env override, 0 disables, junk falls back", () => {
  assert.equal(embed.queryEmbedTimeoutMs({}), 5000);
  assert.equal(embed.queryEmbedTimeoutMs({ NOX_QUERY_EMBED_TIMEOUT_MS: "1200" }), 1200);
  assert.equal(embed.queryEmbedTimeoutMs({ NOX_QUERY_EMBED_TIMEOUT_MS: "0" }), 0);
  assert.equal(embed.queryEmbedTimeoutMs({ NOX_QUERY_EMBED_TIMEOUT_MS: "abc" }), 5000);
  assert.equal(embed.queryEmbedTimeoutMs({ NOX_QUERY_EMBED_TIMEOUT_MS: "-5" }), 5000);
});

test("embedText with a budget rejects with EmbedTimeoutError and aborts the request", async () => {
  const state = { aborted: false };
  embed.__setEmbedForTests(hangingEmbed(state));
  const t0 = Date.now();
  await assert.rejects(embed.embedText("q", { timeoutMs: 50 }), (e: Error) => e instanceof embed.EmbedTimeoutError);
  assert.ok(Date.now() - t0 < 1000, "rejected within the budget, not after it");
  assert.equal(state.aborted, true, "the in-flight request is aborted");
});

test("embedText without a budget is unchanged: a fast provider resolves", async () => {
  embed.__setEmbedForTests(async () => new Float32Array([1, 2, 3]));
  const v = await embed.embedText("q");
  assert.deepEqual(Array.from(v), [1, 2, 3]);
});

test("searchSemantic: a hanging embedding falls back to FTS5 within the budget", async () => {
  process.env.NOX_QUERY_EMBED_TIMEOUT_MS = "100";
  embed.__setEmbedForTests(hangingEmbed({ aborted: false }));
  const results = await Promise.race([
    search.searchSemantic("zebra migration", 5, false),
    new Promise((r) => setTimeout(() => r("still waiting after 3 s"), 3000)),
  ]);
  assert.ok(Array.isArray(results), `search did not return: ${String(results)}`);
  assert.ok((results as { source_file: string }[]).some((r: { source_file: string }) => r.source_file.endsWith("zebra.md")), "FTS5 found the note");
});

test("positive control: with the budget disabled the same search is still waiting", async () => {
  process.env.NOX_QUERY_EMBED_TIMEOUT_MS = "0";
  embed.__setEmbedForTests(hangingEmbed({ aborted: false }));
  const outcome = await Promise.race([
    search.searchSemantic("zebra migration", 5, false).then(() => "returned"),
    new Promise((r) => setTimeout(() => r("still waiting"), 500)),
  ]);
  assert.equal(outcome, "still waiting");
});
