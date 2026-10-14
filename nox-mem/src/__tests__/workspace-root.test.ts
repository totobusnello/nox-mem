// Standalone workspace root (3.6.0, schema v20).
//
// Up to 3.5.x a standalone install keyed every file relative to
// /root/.openclaw/workspace, a directory it does not have. Keys came out as
// `../../../home/u/.nox-mem/memory/a.md`, so `memory/entities/` files never
// reached the entity ingest, `watch` watched nothing and `reindex` refused.
// 3.6.0 resolves the root to ~/.nox-mem and v20 rebases the old keys.
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/workspace-root.test.js)

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runCli, tmpRoot } from "./cli-helpers.js";
import { ORIGIN_WORKSPACE, workspaceRootWithSource } from "../lib/workspace.js";
import { STANDALONE_REBASE_MARKER } from "../db.js";

const ROOTS: string[] = [];
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

// The standalone path is unreachable on a machine that has the origin layout.
const ORIGIN_HERE = existsSync(ORIGIN_WORKSPACE);

test("workspaceRootWithSource: env, then the origin layout if present, then ~/.nox-mem", () => {
  assert.deepEqual(workspaceRootWithSource({ OPENCLAW_WORKSPACE: "/w" }, () => true), { root: "/w", source: "OPENCLAW_WORKSPACE" });
  assert.deepEqual(workspaceRootWithSource({}, (p) => p === ORIGIN_WORKSPACE), { root: ORIGIN_WORKSPACE, source: "origin-default" });
  const s = workspaceRootWithSource({}, () => false);
  assert.equal(s.source, "standalone");
  assert.ok(s.root.endsWith("/.nox-mem"), s.root);
  // Empty string is unset, not "the cwd".
  assert.equal(workspaceRootWithSource({ OPENCLAW_WORKSPACE: "" }, () => false).source, "standalone");
});

test("standalone: notes under ~/.nox-mem/memory get `memory/` keys and entity routing", { skip: ORIGIN_HERE }, () => {
  const home = realpathSync(tmpRoot("wsroot-fresh"));
  ROOTS.push(home);
  const mem = join(home, ".nox-mem", "memory");
  mkdirSync(join(mem, "entities", "projects"), { recursive: true });
  writeFileSync(join(mem, "a.md"), "# A\n\nThe compact job was paused in October and nothing else happened.\n");
  writeFileSync(
    join(mem, "entities", "projects", "alpha.md"),
    "---\ntype: project\nslug: alpha\n---\n\n## Compiled\n\nAlpha is the first project and it is compiled truth.\n\n## Timeline\n\n- 2026-10-14: started\n",
  );
  for (const f of [join(mem, "a.md"), join(mem, "entities", "projects", "alpha.md")]) {
    const r = runCli(["ingest", f], {}, home);
    assert.equal(r.status, 0, r.stderr);
  }
  const db = new Database(join(home, ".nox-mem", "nox.db"), { readonly: true });
  const keys = (db.prepare("SELECT DISTINCT source_file FROM chunks ORDER BY 1").all() as Array<{ source_file: string }>).map((r) => r.source_file);
  const sections = (db.prepare("SELECT DISTINCT section FROM chunks WHERE source_file LIKE 'memory/entities/%'").all() as Array<{ section: string | null }>).map((r) => r.section);
  db.close();
  assert.deepEqual(keys, ["memory/a.md", "memory/entities/projects/alpha.md"]);
  assert.ok(sections.includes("compiled") && sections.includes("frontmatter"), `entity file not routed: ${sections.join(",")}`);
});

test("v20 rebases 3.5.x keys: re-ingest after upgrade writes no second copy; backup kept", { skip: ORIGIN_HERE }, () => {
  const home = realpathSync(tmpRoot("wsroot-upgrade"));
  ROOTS.push(home);
  const dbPath = join(home, ".nox-mem", "nox.db");
  mkdirSync(join(home, ".nox-mem", "memory"), { recursive: true });
  mkdirSync(join(home, "notes"), { recursive: true });
  const inMem = join(home, ".nox-mem", "memory", "a.md");
  const elsewhere = join(home, "notes", "b.md");
  writeFileSync(inMem, "# A\n\nThe compact job was paused in October and nothing else happened.\n");
  writeFileSync(elsewhere, "# B\n\nSalience mixes importance, recency, pain and access in one score.\n");

  // 3.5.x state: keys relative to the origin default (what it used with no env), schema 19.
  for (const f of [inMem, elsewhere]) {
    const r = runCli(["ingest", f], { OPENCLAW_WORKSPACE: ORIGIN_WORKSPACE, NOX_DB_PATH: dbPath }, home);
    assert.equal(r.status, 0, r.stderr);
  }
  let db = new Database(dbPath);
  const before = db.prepare("SELECT id, source_file FROM chunks ORDER BY id").all() as Array<{ id: number; source_file: string }>;
  assert.ok(before.every((r) => r.source_file.startsWith("../")), JSON.stringify(before));
  db.exec("UPDATE meta SET value = '19' WHERE key = 'schema_version'");
  db.prepare("DELETE FROM meta WHERE key = ?").run(STANDALONE_REBASE_MARKER);
  db.pragma("user_version = 19");
  db.close();

  // Upgrade: first open under 3.6.0, standalone (no env), then re-ingest both files.
  for (const f of [inMem, elsewhere]) {
    const r = runCli(["ingest", f], {}, home);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /0 new, 1 unchanged/, `re-ingest after upgrade duplicated: ${r.stdout}${r.stderr}`);
  }
  db = new Database(dbPath, { readonly: true });
  const after = db.prepare("SELECT id, source_file FROM chunks ORDER BY id").all() as Array<{ id: number; source_file: string }>;
  const fts = db.prepare("SELECT COUNT(*) AS c FROM chunks_fts WHERE chunks_fts MATCH 'source_file:memory'").get() as { c: number };
  db.close();
  assert.deepEqual(after.map((r) => r.id), before.map((r) => r.id), "ids changed");
  assert.deepEqual(after.map((r) => r.source_file), ["memory/a.md", "../notes/b.md"]);
  assert.equal(fts.c, 1, "FTS index still carries the old key");
  assert.ok(existsSync(`${dbPath}.pre-v20-keys.bak`), "no backup before the rewrite");
});

test("v20 key rebase runs once (marker), and never outside standalone", async () => {
  const dir = realpathSync(tmpRoot("wsroot-once"));
  ROOTS.push(dir);
  const db = new Database(join(dir, "x.db"));
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY, source_file TEXT NOT NULL, chunk_text TEXT);
    INSERT INTO chunks (source_file, chunk_text) VALUES ('../../../home/u/.nox-mem/memory/a.md', 't');
    INSERT INTO chunks (source_file, chunk_text) VALUES ('../../../home/u/notes/b.md', 'u');
  `);
  // A file outside ~/.nox-mem keeps a `../` key after the rebase; a second pass
  // would rebase it again from the wrong base. Only the marker stops that.
  const { migrateStandaloneKeys } = await import("../db.js");
  assert.equal(migrateStandaloneKeys(db, { root: "/home/u/.nox-mem", source: "origin-default" }), 0);
  assert.equal(migrateStandaloneKeys(db, { root: "/home/u/.nox-mem", source: "standalone" }), 2);
  assert.equal(migrateStandaloneKeys(db, { root: "/home/u/.nox-mem", source: "standalone" }), 0, "ran twice");
  const keys = (db.prepare("SELECT source_file FROM chunks ORDER BY id").all() as Array<{ source_file: string }>).map((r) => r.source_file);
  assert.deepEqual(keys, ["memory/a.md", "../notes/b.md"]);
  db.close();
});
