// reindex safety (2026-09-28) — measured on a clean npm install before the fix:
//   1. no $OPENCLAW_WORKSPACE ⇒ the scan found 0 files ⇒ every chunk was deleted
//      as an "orphan"; the retention guard threw only AFTER the DELETE;
//   2. every reindex kept both the old row and the fresh copy of unchanged
//      content (10 chunks → 20).
// Also covers the shared DB path resolver (db.ts and op-audit must agree).
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/reindex-safety.test.js)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import {
  resolveDbPathWithSource,
  LEGACY_DB_PATH,
  DEFAULT_STANDALONE_DB_PATH,
  isInsideNodeModules,
} from "../lib/db-path.js";

// realpath: op-audit refuses snapshot dirs reached through a symlink (macOS /tmp → /private/tmp).
const TMP_ROOT = realpathSync(mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-reindex-test-")));
const WS = join(TMP_ROOT, "ws");
const MEM = join(WS, "memory");
mkdirSync(MEM, { recursive: true });
mkdirSync(join(WS, "tools", "nox-mem"), { recursive: true });
// DB derives from the workspace, as on the origin deployment (op-audit rejects a
// NOX_DB_PATH that disagrees with OPENCLAW_WORKSPACE).
delete process.env.NOX_DB_PATH;
delete process.env.NOX_REINDEX_ALLOW_WIPE;
process.env.OPENCLAW_WORKSPACE = WS;
const DB = join(WS, "tools", "nox-mem", "nox-mem.db");

// ─── DB path resolver (pure) ─────────────────────────────────────────────────

test("db-path: NOX_DB_PATH wins", () => {
  const r = resolveDbPathWithSource({ NOX_DB_PATH: "/x/y.db", OPENCLAW_WORKSPACE: "/ws" }, () => true);
  assert.deepEqual(r, { path: "/x/y.db", source: "NOX_DB_PATH" });
});

test("db-path: OPENCLAW_WORKSPACE next (origin layout unchanged)", () => {
  const r = resolveDbPathWithSource({ OPENCLAW_WORKSPACE: "/root/.openclaw/workspace" }, () => false);
  assert.deepEqual(r, { path: "/root/.openclaw/workspace/tools/nox-mem/nox-mem.db", source: "OPENCLAW_WORKSPACE" });
});

test("db-path: existing legacy <package>/nox-mem.db is kept (no silent move of live data)", () => {
  const r = resolveDbPathWithSource({}, (p) => p === LEGACY_DB_PATH);
  assert.deepEqual(r, { path: LEGACY_DB_PATH, source: "legacy-package" });
});

test("db-path: fresh install defaults to ~/.nox-mem/nox.db, not the package dir", () => {
  const r = resolveDbPathWithSource({}, () => false);
  assert.equal(r.source, "standalone-default");
  assert.equal(r.path, join(homedir(), ".nox-mem", "nox.db"));
  assert.equal(r.path, DEFAULT_STANDALONE_DB_PATH);
  assert.equal(isInsideNodeModules(r.path), false);
});

test("db-path: node_modules detection", () => {
  assert.equal(isInsideNodeModules("/usr/lib/node_modules/nox-mem/nox-mem.db"), true);
  assert.equal(isInsideNodeModules("/home/u/.nox-mem/nox.db"), false);
});

// ─── reindex against a real workspace ────────────────────────────────────────

let getDb: any, closeDb: any, reindex: any, assertReindexSource: any;
let ReindexSourceMissingError: any, ReindexWipeDetectedError: any, routeIngest: any;

const count = (): number => (getDb().prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c;
const ids = (): string => (getDb().prepare("SELECT group_concat(id) AS g FROM (SELECT id FROM chunks ORDER BY id)").get() as { g: string }).g;

before(async () => {
  ({ getDb, closeDb } = await import("../db.js"));
  ({ reindex, assertReindexSource, ReindexSourceMissingError, ReindexWipeDetectedError } = await import("../reindex.js"));
  ({ routeIngest } = await import("../lib/ingest-router.js"));
  for (let i = 1; i <= 10; i++) writeFileSync(join(MEM, `n${i}.md`), `# N${i}\nnote number ${i} about topic${i}.\n`);
  for (let i = 1; i <= 10; i++) await routeIngest(join(MEM, `n${i}.md`));
  assert.equal(getDb().prepare("SELECT 1").get() !== undefined, true);
});

after(() => {
  closeDb();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

test("reindex: unchanged content is not duplicated and keeps its ids", async () => {
  const before = ids();
  assert.equal(count(), 10);
  await reindex();
  assert.equal(count(), 10, "one reindex must not double the corpus");
  await reindex();
  assert.equal(count(), 10);
  assert.equal(ids(), before, "old rows (with their embeddings) are the ones kept");
});

test("reindex: edited file replaces its chunk, new file is added", async () => {
  writeFileSync(join(MEM, "n1.md"), "# N1\nnote number 1 EDITED.\n");
  writeFileSync(join(MEM, "n11.md"), "# N11\nbrand new note eleven.\n");
  await reindex();
  const q = (like: string) => (getDb().prepare("SELECT COUNT(*) AS c FROM chunks WHERE chunk_text LIKE ?").get(like) as { c: number }).c;
  assert.equal(q("%EDITED%"), 1);
  assert.equal(q("%number 1 about%"), 0);
  assert.equal(q("%eleven%"), 1);
  assert.equal(count(), 11);
});

test("reindex: retention guard refuses BEFORE deleting (rows survive the throw)", async () => {
  for (const i of [2, 3, 4, 5, 6]) unlinkSync(join(MEM, `n${i}.md`));
  const pre = count();
  await assert.rejects(() => reindex(), (e: Error) => e instanceof ReindexWipeDetectedError);
  assert.ok(count() >= pre, `no chunk may be deleted when the guard fires (pre=${pre}, now=${count()})`);
});

test("assertReindexSource: refuses when no source dir exists and the DB has chunks", () => {
  // The workspace path is captured at import, so empty the fixture instead.
  rmSync(MEM, { recursive: true, force: true });
  assert.throws(() => assertReindexSource(5), (e: Error) => e instanceof ReindexSourceMissingError && /no source directory/.test(e.message));
  assert.doesNotThrow(() => assertReindexSource(0), "an empty DB has nothing to lose");
});

test("assertReindexSource: refuses when the source dir exists but holds no file", () => {
  mkdirSync(MEM, { recursive: true });
  assert.throws(() => assertReindexSource(5), (e: Error) => e instanceof ReindexSourceMissingError && /found 0 files/.test(e.message));
});

test("reindex: refusal leaves every chunk in place", async () => {
  const pre = count();
  assert.ok(pre > 0);
  await assert.rejects(() => reindex(), (e: Error) => e instanceof ReindexSourceMissingError);
  assert.equal(count(), pre);
});

