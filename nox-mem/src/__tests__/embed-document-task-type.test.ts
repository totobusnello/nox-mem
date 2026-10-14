// Stored text must be embedded as a DOCUMENT, queries as a QUERY.
//
// Gemini embeds RETRIEVAL_DOCUMENT and RETRIEVAL_QUERY into different spaces.
// The batch `vectorize` path always used RETRIEVAL_DOCUMENT, but until 2026-10-14
// the inline auto-vectorize in ingest (and in crystallize) called embedText, the
// query-side function. A census of 1,000 production chunks found 26 (2.6%) stored
// with query embeddings. These tests pin which side each caller embeds.
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/embed-document-task-type.test.js)

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TMP_ROOT = realpathSync(mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-embed-kind-")));
process.env.NOX_DB_PATH = join(TMP_ROOT, "t.db");
delete process.env.OPENCLAW_WORKSPACE;
for (const k of ["GEMINI_API_KEY", "OPENAI_API_KEY", "NOX_EMBEDDING_API_KEY", "NOX_EMBED_API_KEY", "NOX_EMBEDDING_PROVIDER", "NOX_EMBED_PROVIDER"]) delete process.env[k];

let embed: any, dbmod: any;
const kinds: string[] = [];

before(async () => {
  embed = await import("../embed.js");
  dbmod = await import("../db.js");
});

afterEach(() => {
  embed.__setEmbedForTests(null);
  kinds.length = 0;
  delete process.env.GEMINI_API_KEY;
});

after(() => {
  try { dbmod.closeDb(); } catch { /* ignore */ }
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** Records the kind of every embedding call; never reaches the network. */
function recordKinds() {
  embed.__setEmbedForTests(async (_text: string, _signal?: AbortSignal, kind?: string) => {
    kinds.push(kind ?? "unspecified");
    return new Float32Array(embed.activeEmbeddingDim()).fill(0.01);
  });
  // ingest only auto-vectorizes when a key is present; the override keeps it offline.
  process.env.GEMINI_API_KEY = "test-not-a-real-key";
}

test("ingest auto-vectorize embeds chunks as documents", async () => {
  recordKinds();
  const { ingestFile } = await import("../ingest.js");
  const note = join(TMP_ROOT, "okapi.md");
  writeFileSync(note, "# Okapi\n\nThe okapi lives in the Ituri rainforest.\n\n## Diet\n\nLeaves, fruit and fungi.\n");
  await ingestFile(note);
  assert.ok(kinds.length > 0, "ingest made no embedding call");
  assert.deepEqual([...new Set(kinds)], ["document"]);
});

test("crystallize embeds the procedure as a document", async () => {
  recordKinds();
  const { crystallize } = await import("../crystallize.js");
  await crystallize({ title: "Rotate the okapi feed", steps: ["check stock", "refill"] });
  assert.ok(kinds.length > 0, "crystallize made no embedding call");
  assert.deepEqual([...new Set(kinds)], ["document"]);
});

test("embedText stays on the query side", async () => {
  recordKinds();
  await embed.embedText("where does the okapi live?");
  assert.deepEqual(kinds, ["query"]);
});
