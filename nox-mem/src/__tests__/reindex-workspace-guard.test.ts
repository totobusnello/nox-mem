// reindex with NOX_DB_PATH set and OPENCLAW_WORKSPACE unset (2026-09-28).
// Reindex then scans the default workspace (/root/.openclaw/workspace) and would
// treat every chunk of the NOX_DB_PATH database that did not come from there as
// an orphan. The guard refuses unless the DB is that workspace's own DB.
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/reindex-workspace-guard.test.js)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TMP_ROOT = mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-ws-guard-test-"));
process.env.NOX_DB_PATH = join(TMP_ROOT, "standalone.db");
delete process.env.OPENCLAW_WORKSPACE;
delete process.env.NOX_REINDEX_ALLOW_WIPE;
for (const k of ["GEMINI_API_KEY", "OPENAI_API_KEY", "NOX_EMBEDDING_API_KEY", "NOX_EMBED_API_KEY"]) delete process.env[k];

let assertReindexSource: any, ReindexWorkspaceMismatchError: any, ReindexSourceMissingError: any;

before(async () => {
  ({ assertReindexSource, ReindexWorkspaceMismatchError, ReindexSourceMissingError } = await import("../reindex.js"));
});

after(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

test("NOX_DB_PATH set, OPENCLAW_WORKSPACE unset, DB is not the default workspace's ⇒ refused", () => {
  assert.throws(
    () => assertReindexSource(5),
    (e: Error) => e instanceof ReindexWorkspaceMismatchError && /OPENCLAW_WORKSPACE/.test(e.message),
  );
});

test("the mismatch is refused even for an empty DB (it is about identity, not data loss)", () => {
  assert.throws(() => assertReindexSource(0), (e: Error) => e instanceof ReindexWorkspaceMismatchError);
});

test("NOX_DB_PATH pointing at the default workspace's own DB passes the identity check (origin crons)", () => {
  const saved = process.env.NOX_DB_PATH;
  process.env.NOX_DB_PATH = "/root/.openclaw/workspace/tools/nox-mem/nox-mem.db";
  try {
    // Identity passes; on a machine without that workspace the SOURCE guard is what refuses.
    assert.throws(() => assertReindexSource(5), (e: Error) => !(e instanceof ReindexWorkspaceMismatchError) && e instanceof ReindexSourceMissingError);
  } finally {
    process.env.NOX_DB_PATH = saved;
  }
});

test("OPENCLAW_WORKSPACE set ⇒ this guard steps aside (op-audit owns that case)", () => {
  process.env.OPENCLAW_WORKSPACE = join(TMP_ROOT, "ws");
  try {
    assert.throws(() => assertReindexSource(5), (e: Error) => !(e instanceof ReindexWorkspaceMismatchError));
  } finally {
    delete process.env.OPENCLAW_WORKSPACE;
  }
});
