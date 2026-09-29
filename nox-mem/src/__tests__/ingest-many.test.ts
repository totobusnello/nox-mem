// `nox-mem ingest <files...>` ingests every path, not just the first.
//
// Before: the command was `ingest <file>`, so `nox-mem ingest a.md b.md` indexed
// a.md and silently dropped b.md. Now each path is ingested; a directory (or a
// missing path) gets a clear error naming it, the rest still run, and the exit
// code is 1 if any failed.
//
// Runs the compiled CLI against an isolated DB (NOX_DB_PATH in a temp dir).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ingestMany } from "../lib/ingest-many.js";
import { runCli, tmpRoot } from "./cli-helpers.js";

const ROOT = tmpRoot("ingest-many");
const DB = join(ROOT, "db", "n.db");
const A = join(ROOT, "a.md");
const B = join(ROOT, "b.md");
const C = join(ROOT, "c.md");
const DIR = join(ROOT, "somedir");

before(() => {
  writeFileSync(A, "# A\nalpaca corral notes\n");
  writeFileSync(B, "# B\nbuffalo herd notes\n");
  writeFileSync(C, "# C\ncapybara river notes\n");
  mkdirSync(DIR);
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

function sources(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT DISTINCT source_file FROM chunks ORDER BY source_file").all() as Array<{ source_file: string }>)
      .map((r) => r.source_file);
  } finally {
    db.close();
  }
}

test("CLI: several paths ⇒ every one is ingested (was: only the first)", () => {
  const r = runCli(["ingest", A, B, C], { NOX_DB_PATH: DB }, ROOT);
  assert.equal(r.status, 0, r.stderr);
  const s = sources(DB);
  assert.equal(s.length, 3, `expected 3 source files, got ${JSON.stringify(s)}`);
  for (const name of ["a.md", "b.md", "c.md"]) assert.ok(s.some((x) => x.endsWith(name)), `${name} missing`);
});

test("CLI: a directory is a named error, the other files still run, exit 1", () => {
  const db2 = join(ROOT, "db2", "n.db");
  const r = runCli(["ingest", A, DIR, B], { NOX_DB_PATH: db2 }, ROOT);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(DIR), `error must name the path:\n${r.stderr}`);
  assert.match(r.stderr, /is a directory/);
  assert.doesNotMatch(r.stderr + r.stdout, /EISDIR/);
  // both files around the directory were ingested
  assert.equal(sources(db2).length, 2);
});

test("CLI: a missing path is a named error with exit 1", () => {
  const missing = join(ROOT, "does-not-exist.md");
  const r = runCli(["ingest", missing], { NOX_DB_PATH: join(ROOT, "db3", "n.db") }, ROOT);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(missing), r.stderr);
});

test("ingestMany: ok/failed accounting and per-path isolation", async () => {
  const seen: string[] = [];
  const errors: string[] = [];
  const res = await ingestMany([A, DIR, B], {
    ingestOne: async (p) => {
      seen.push(p);
      if (p === B) throw new Error("boom");
      return { chunks: 1, kind: "markdown", routedTo: "t" };
    },
    log: () => {},
    error: (l) => errors.push(l),
  });
  assert.deepEqual(seen, [A, B], "the directory is never handed to the ingester");
  assert.deepEqual(res, { ok: 1, failed: 2 });
  assert.ok(errors.some((e) => e.includes(DIR)));
  assert.ok(errors.some((e) => e.includes(B) && e.includes("boom")));
});
