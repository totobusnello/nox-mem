// The large-DB ingest guard must tell an ordinary user what to do: the message
// names NOX_ALLOW_PROD_INGEST=1 and --allow-prod, and no longer points at
// docs/INCIDENTS.md (which does not exist in this repo). End to end: a DB over
// the threshold refuses `ingest`, and both opt-ins get through.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { largeDbGuardMessage } from "../db.js";
import { runCli, tmpRoot } from "./cli-helpers.js";

const ROOT = tmpRoot("large-guard");
const DB = join(ROOT, "big.db");
const NOTE = join(ROOT, "note.md");

before(() => {
  writeFileSync(NOTE, "# N\nguard test note\n");
  // Let the CLI create the schema, then pad it past the 10,000-chunk threshold.
  const r = runCli(["ingest", NOTE], { NOX_DB_PATH: DB }, ROOT);
  assert.equal(r.status, 0, r.stderr);
  const db = new Database(DB);
  const ins = db.prepare("INSERT INTO chunks (source_file, chunk_type, chunk_text) VALUES (?, 'other', ?)");
  db.transaction(() => {
    for (let i = 0; i < 10_001; i++) ins.run(`pad-${i}.md`, `pad ${i}`);
  })();
  db.close();
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

test("message: tells the user both ways out, cites no missing file", () => {
  const m = largeDbGuardMessage("ingest", "/x/nox.db", 12345);
  assert.match(m, /NOX_ALLOW_PROD_INGEST=1/);
  assert.match(m, /--allow-prod/);
  assert.match(m, /NOX_DB_PATH/);
  assert.match(m, /12345/);
  assert.doesNotMatch(m, /INCIDENTS/);
  assert.doesNotMatch(m, /wipe incident/i);
});

test("CLI: over the threshold, ingest refuses with the actionable message", () => {
  const r = runCli(["ingest", NOTE], { NOX_DB_PATH: DB }, ROOT);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NOX_ALLOW_PROD_INGEST=1/);
  assert.match(r.stderr, /--allow-prod/);
  assert.doesNotMatch(r.stderr, /INCIDENTS/);
});

test("CLI: --allow-prod and NOX_ALLOW_PROD_INGEST=1 both get through", () => {
  const viaFlag = runCli(["ingest", "--allow-prod", NOTE], { NOX_DB_PATH: DB }, ROOT);
  assert.equal(viaFlag.status, 0, viaFlag.stderr);
  const viaEnv = runCli(["ingest", NOTE], { NOX_DB_PATH: DB, NOX_ALLOW_PROD_INGEST: "1" }, ROOT);
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
});
