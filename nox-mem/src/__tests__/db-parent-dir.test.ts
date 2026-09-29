// An explicit NOX_DB_PATH whose parent directory does not exist used to crash
// with "Cannot open database because the directory does not exist". The parent is
// now created (mkdir -p, mode 0700) before the database is opened.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureDbParentDir } from "../lib/db-path.js";
import { runCli, tmpRoot } from "./cli-helpers.js";

const ROOT = tmpRoot("db-parent");
after(() => rmSync(ROOT, { recursive: true, force: true }));

test("CLI: NOX_DB_PATH under a directory that does not exist is created, mode 0700", () => {
  const db = join(ROOT, "a", "b", "nox.db");
  assert.equal(existsSync(join(ROOT, "a")), false);
  const r = runCli(["stats"], { NOX_DB_PATH: db }, ROOT);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /directory does not exist/);
  assert.ok(existsSync(db), "database file was created");
  if (process.platform !== "win32") {
    assert.equal(statSync(join(ROOT, "a", "b")).mode & 0o777, 0o700);
  }
});

test("ensureDbParentDir: creates once, then is a no-op that never changes an existing dir's mode", () => {
  const dir = join(ROOT, "pre", "existing");
  assert.equal(ensureDbParentDir(join(dir, "x.db")), true);
  assert.equal(ensureDbParentDir(join(dir, "x.db")), false);
  const other = join(ROOT, "open-dir");
  mkdirSync(other, { mode: 0o755 });
  assert.equal(ensureDbParentDir(join(other, "x.db")), false);
  if (process.platform !== "win32") assert.equal(statSync(other).mode & 0o777, 0o755);
});
