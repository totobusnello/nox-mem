// reindex on a DB that the pre-2026-09-28 reindex already doubled, plus the
// adversarial-review findings on PR #29 (GLM + DeepSeek):
//   - the retention guard measured ROWS, so cleaning 2N → N read as a 50% wipe
//     and the first reindex after the fix was refused forever;
//   - among duplicates, the kept row must be the one holding the embedding;
//   - an edited file replaces content, it is not a loss;
//   - --dry-run must not write;
//   - the legacy DB path must equal the one db.ts used before the refactor.
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/reindex-dedup.test.js)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { LEGACY_DB_PATH } from "../lib/db-path.js";

const TMP_ROOT = realpathSync(mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-dedup-test-")));
const WS = join(TMP_ROOT, "ws");
const MEM = join(WS, "memory");
mkdirSync(MEM, { recursive: true });
mkdirSync(join(WS, "tools", "nox-mem"), { recursive: true });
delete process.env.NOX_DB_PATH;
delete process.env.NOX_REINDEX_ALLOW_WIPE;
process.env.OPENCLAW_WORKSPACE = WS;

let getDb: any, closeDb: any, reindex: any, routeIngest: any;
const N = 20;
const count = (): number => (getDb().prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c;

before(async () => {
  ({ getDb, closeDb } = await import("../db.js"));
  ({ reindex } = await import("../reindex.js"));
  ({ routeIngest } = await import("../lib/ingest-router.js"));
  for (let i = 1; i <= N; i++) writeFileSync(join(MEM, `n${i}.md`), `# N${i}\nnote number ${i} about topic${i}.\n`);
  for (let i = 1; i <= N; i++) await routeIngest(join(MEM, `n${i}.md`));
});

after(() => {
  closeDb();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

test("legacy DB path is the one db.ts used before the refactor (<package>/nox-mem.db)", () => {
  // this file compiles to dist/__tests__/…; db.ts compiled to dist/db.js and used resolve(dist, "..", "nox-mem.db")
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(LEGACY_DB_PATH, resolve(dist, "..", "nox-mem.db"));
});

test("--dry-run does not write", async () => {
  const pre = count();
  const maxId = (getDb().prepare("SELECT MAX(id) AS m FROM chunks").get() as { m: number }).m;
  await reindex({ dryRun: true });
  assert.equal(count(), pre);
  assert.equal((getDb().prepare("SELECT MAX(id) AS m FROM chunks").get() as { m: number }).m, maxId);
});

test("an already-doubled DB is cleaned (2N → N), not refused, and keeps the embedded copy", async () => {
  const db = getDb();
  db.exec("INSERT INTO chunks (source_file, chunk_type, chunk_text, source_date) SELECT source_file, chunk_type, chunk_text, source_date FROM chunks");
  assert.equal(count(), 2 * N);
  // Mark the HIGHER-id copy of n7 as the embedded one; lowest-id-wins alone would drop it.
  const copies = db.prepare("SELECT id FROM chunks WHERE chunk_text LIKE '%number 7 about%' ORDER BY id").all() as Array<{ id: number }>;
  assert.equal(copies.length, 2);
  db.exec("CREATE TABLE IF NOT EXISTS vec_chunk_map (vec_rowid INTEGER PRIMARY KEY, chunk_id INTEGER NOT NULL UNIQUE)");
  db.prepare("INSERT INTO vec_chunk_map (vec_rowid, chunk_id) VALUES (?, ?)").run(900001, copies[1]!.id);

  await reindex();

  assert.equal(count(), N, "one row per distinct content");
  const left = db.prepare("SELECT id FROM chunks WHERE chunk_text LIKE '%number 7 about%'").all() as Array<{ id: number }>;
  assert.deepEqual(left.map((r) => r.id), [copies[1]!.id], "the copy with the embedding survives");
});

test("editing many files is replacement, not loss (guard stays quiet)", async () => {
  // Rewrite half the corpus: every chunk of those files changes fingerprint.
  for (let i = 1; i <= N / 2; i++) writeFileSync(join(MEM, `n${i}.md`), `# N${i}\nnote number ${i} REWRITTEN.\n`);
  await reindex();
  assert.equal(count(), N);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS c FROM chunks WHERE chunk_text LIKE '%REWRITTEN%'").get() as { c: number }).c, N / 2);
});
