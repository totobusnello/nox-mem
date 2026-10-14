// Write path without loss (ROADMAP v6 item 3, 2026-10-14):
//   (a) re-ingesting a file keeps the row (id + vector) of every unchanged chunk;
//   (b) a file that leaves the disk is tombstoned, never deleted; a rename keeps ids;
//   (c) ingest never closes the getDb() handle its caller holds.
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/write-path.test.js)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync, renameSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TMP_ROOT = realpathSync(mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-write-path-")));
const WS = join(TMP_ROOT, "ws");
const MEM = join(WS, "memory");
const ENT = join(MEM, "entities", "projects");
mkdirSync(ENT, { recursive: true });
mkdirSync(join(WS, "tools", "nox-mem"), { recursive: true });
delete process.env.NOX_DB_PATH;
// Hermetic: no embedding key ⇒ no inline embedding, no API spend.
for (const k of ["GEMINI_API_KEY", "OPENAI_API_KEY", "NOX_EMBEDDING_API_KEY", "NOX_EMBED_API_KEY"]) delete process.env[k];
process.env.OPENCLAW_WORKSPACE = WS;

let getDb: any, closeDb: any, routeIngest: any;
let tombstoneFile: any, listTombstones: any, keepTombstone: any, purgeTombstone: any;

const rows = (rel: string) =>
  getDb().prepare("SELECT id, chunk_text, section FROM chunks WHERE source_file = ? ORDER BY id").all(rel) as Array<{
    id: number; chunk_text: string; section: string | null;
  }>;
const idOf = (rel: string, like: string) =>
  (getDb().prepare("SELECT id FROM chunks WHERE source_file = ? AND chunk_text LIKE ?").get(rel, like) as { id: number } | undefined)?.id;

const SECTION = (k: number, tag = "") =>
  `## Section ${k}\nparagraph ${k}${tag} has enough words in it to be a chunk of its own and not get merged away.`;
const doc = (n: number, edits: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, k) => SECTION(k, edits[k] ?? "")).join("\n\n");

before(async () => {
  ({ getDb, closeDb } = await import("../db.js"));
  ({ routeIngest } = await import("../lib/ingest-router.js"));
  ({ tombstoneFile, listTombstones, keepTombstone, purgeTombstone } = await import("../lib/tombstone.js"));
  getDb().exec("CREATE TABLE IF NOT EXISTS vec_chunk_map (vec_rowid INTEGER PRIMARY KEY, chunk_id INTEGER NOT NULL UNIQUE)");
});

after(() => {
  closeDb();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

test("(c) ingest leaves the caller's getDb() handle open", async () => {
  const db = getDb();
  writeFileSync(join(MEM, "handle.md"), doc(2));
  await routeIngest(join(MEM, "handle.md"));
  assert.equal(db.open, true, "ingest closed the shared handle");
  assert.doesNotThrow(() => db.prepare("SELECT 1").get());
});

test("(a) unchanged file: same ids, nothing inserted or deleted, vector mapping untouched", async () => {
  writeFileSync(join(MEM, "a.md"), doc(4));
  const first = await routeIngest(join(MEM, "a.md"));
  assert.equal(first.inserted.length, 4);
  const before = rows("memory/a.md");
  getDb().prepare("INSERT INTO vec_chunk_map (vec_rowid, chunk_id) VALUES (?, ?)").run(800001, before[0]!.id);

  const again = await routeIngest(join(MEM, "a.md"));
  assert.deepEqual([again.inserted.length, again.kept, again.deleted], [0, 4, 0]);
  assert.deepEqual(rows("memory/a.md"), before);
  const mapped = getDb().prepare("SELECT chunk_id FROM vec_chunk_map WHERE vec_rowid = 800001").get() as { chunk_id: number };
  assert.equal(mapped.chunk_id, before[0]!.id);
});

test("(a) one edited section: only that chunk gets a new id", async () => {
  const before = rows("memory/a.md");
  writeFileSync(join(MEM, "a.md"), doc(4, { 2: " EDITED" }));
  const r = await routeIngest(join(MEM, "a.md"));
  assert.deepEqual([r.inserted.length, r.kept, r.deleted], [1, 3, 1]);
  const after = rows("memory/a.md");
  const keptIds = before.filter((b) => !b.chunk_text.includes("paragraph 2 ")).map((b) => b.id);
  for (const id of keptIds) assert.ok(after.some((a) => a.id === id), `id ${id} should survive`);
  assert.equal(after.filter((a) => a.chunk_text.includes("EDITED")).length, 1);
});

test("(a) a repeated paragraph keeps one row per occurrence; extra stored copies collapse to the embedded one", async () => {
  const twice = [SECTION(1), SECTION(1), SECTION(2)].join("\n\n");
  writeFileSync(join(MEM, "dup.md"), twice);
  await routeIngest(join(MEM, "dup.md"));
  assert.equal(rows("memory/dup.md").length, 3);

  // Simulate the pre-2026-09-28 reindex: every row stored twice; the HIGHER-id copy of section 2 is embedded.
  const db = getDb();
  db.exec("INSERT INTO chunks (source_file, chunk_type, chunk_text, source_date) SELECT source_file, chunk_type, chunk_text, source_date FROM chunks WHERE source_file = 'memory/dup.md'");
  const s2 = db.prepare("SELECT id FROM chunks WHERE source_file = 'memory/dup.md' AND chunk_text LIKE '%paragraph 2 %' ORDER BY id").all() as Array<{ id: number }>;
  assert.equal(s2.length, 2);
  db.prepare("INSERT INTO vec_chunk_map (vec_rowid, chunk_id) VALUES (?, ?)").run(800002, s2[1]!.id);

  const r = await routeIngest(join(MEM, "dup.md"));
  assert.deepEqual([r.inserted.length, r.kept, r.deleted], [0, 3, 3]);
  const left = rows("memory/dup.md");
  assert.equal(left.length, 3);
  assert.ok(left.some((x) => x.id === s2[1]!.id), "the embedded copy is the one kept");
});

test("(a) empty file changes nothing", async () => {
  const before = rows("memory/a.md");
  writeFileSync(join(MEM, "a.md"), "   \n");
  const r = await routeIngest(join(MEM, "a.md"));
  assert.equal(r.chunks, 0);
  assert.deepEqual(rows("memory/a.md"), before);
  writeFileSync(join(MEM, "a.md"), doc(4, { 2: " EDITED" }));
});

const entity = (compiled: string, timeline: string[]) =>
  `---\nname: Apollo\ntype: project\n---\n\n${compiled}\n\n---\n\n## Timeline\n\n${timeline.map((t) => `- ${t}`).join("\n")}\n`;

test("(a) entity: new compiled truth gets one new row; frontmatter and timeline keep theirs", async () => {
  const f = join(ENT, "apollo.md");
  writeFileSync(f, entity("Status: planning the first launch window.", ["**2026-10-01** — kickoff", "**2026-10-05** — budget approved"]));
  const r1 = await routeIngest(f);
  assert.equal(r1.kind, "entity");
  const before = rows("memory/entities/projects/apollo.md");
  assert.deepEqual(before.map((x) => x.section).sort(), ["compiled", "frontmatter", "timeline", "timeline"]);

  writeFileSync(f, entity("Status: launch window confirmed for November.", ["**2026-10-01** — kickoff", "**2026-10-05** — budget approved"]));
  const r2 = await routeIngest(f);
  assert.deepEqual([r2.inserted.length, r2.kept, r2.deleted], [1, 3, 1]);
  const after = rows("memory/entities/projects/apollo.md");
  for (const b of before.filter((x) => x.section !== "compiled")) assert.ok(after.some((a) => a.id === b.id));
  const sec = (s: string) => after.filter((a) => a.section === s).length;
  assert.equal(sec("compiled"), sec("frontmatter"), "compiled == frontmatter (CLAUDE.md rule 6)");
});

test("(a) entity: compiledChunkId points at the compiled row, kept or new", async () => {
  const { ingestEntitySync } = await import("../ingest-entity.js");
  const r = ingestEntitySync(getDb(), join(ENT, "apollo.md"));
  assert.equal(r.kept, 4);
  const sec = (getDb().prepare("SELECT section FROM chunks WHERE id = ?").get(r.compiledChunkId) as { section: string }).section;
  assert.equal(sec, "compiled");
});

test("(b) a deleted file is tombstoned: chunks stay, listed for review", async () => {
  writeFileSync(join(MEM, "gone.md"), doc(3));
  await routeIngest(join(MEM, "gone.md"));
  const before = rows("memory/gone.md");
  unlinkSync(join(MEM, "gone.md"));

  const r = tombstoneFile(getDb(), "memory/gone.md", false, "deleted");
  assert.deepEqual(r, { status: "tombstoned", chunks: 3 });
  assert.deepEqual(rows("memory/gone.md"), before, "nothing deleted");
  assert.equal(tombstoneFile(getDb(), "memory/gone.md", false, "deleted").status, "already");
  const listed = listTombstones(getDb()).find((t: any) => t.source_file === "memory/gone.md");
  assert.equal(listed.live_chunks, 3);
});

test("(b) a file still on disk is never tombstoned", () => {
  assert.equal(tombstoneFile(getDb(), "memory/a.md", true, "deleted").status, "exists-on-disk");
});

test("(b) the file coming back removes its tombstone and keeps the ids", async () => {
  const before = rows("memory/gone.md");
  writeFileSync(join(MEM, "gone.md"), doc(3));
  await routeIngest(join(MEM, "gone.md"));
  assert.deepEqual(rows("memory/gone.md"), before);
  assert.equal(listTombstones(getDb(), { all: true }).some((t: any) => t.source_file === "memory/gone.md"), false);
});

test("(b) rename: the new path adopts the tombstoned rows (same ids), tombstone records renamed_to", async () => {
  const before = rows("memory/gone.md").map((x) => x.id);
  renameSync(join(MEM, "gone.md"), join(MEM, "moved.md"));
  tombstoneFile(getDb(), "memory/gone.md", false, "deleted");
  const r = await routeIngest(join(MEM, "moved.md"));
  assert.deepEqual([r.inserted.length, r.adopted], [0, 3]);
  assert.deepEqual(rows("memory/moved.md").map((x) => x.id), before);
  assert.equal(rows("memory/gone.md").length, 0);
  const t = listTombstones(getDb(), { all: true }).find((x: any) => x.source_file === "memory/gone.md");
  assert.equal(t.renamed_to, "memory/moved.md");
  assert.equal(listTombstones(getDb()).some((x: any) => x.source_file === "memory/gone.md"), false, "resolved: out of the review queue");
});

test("(b) no adoption from a file that is merely absent from disk (D-2026-09-30 keeps those on purpose)", async () => {
  const db = getDb();
  db.prepare("INSERT INTO chunks (source_file, chunk_type, chunk_text) VALUES ('memory/mac-docs/PESSOAL/x.md', 'other', ?)").run(SECTION(7));
  writeFileSync(join(MEM, "seven.md"), SECTION(7));
  const r = await routeIngest(join(MEM, "seven.md"));
  assert.equal(r.adopted, 0);
  assert.equal(rows("memory/mac-docs/PESSOAL/x.md").length, 1);
});

test("(b) a tombstone reviewed as kept is not adopted and leaves the queue", async () => {
  writeFileSync(join(MEM, "keep.md"), SECTION(8));
  await routeIngest(join(MEM, "keep.md"));
  unlinkSync(join(MEM, "keep.md"));
  tombstoneFile(getDb(), "memory/keep.md", false, "deleted");
  assert.equal(keepTombstone(getDb(), "memory/keep.md"), true);
  assert.equal(listTombstones(getDb()).some((x: any) => x.source_file === "memory/keep.md"), false);
  writeFileSync(join(MEM, "eight.md"), SECTION(8));
  const r = await routeIngest(join(MEM, "eight.md"));
  assert.equal(r.adopted, 0);
  assert.equal(rows("memory/keep.md").length, 1);
});

test("(b) purge: refuses on disk / kept / never tombstoned; deletes only on explicit call", async () => {
  const db = getDb();
  assert.equal(purgeTombstone(db, "memory/a.md", true).refused, "exists-on-disk");
  assert.equal(purgeTombstone(db, "memory/keep.md", false).refused, "kept");
  assert.equal(purgeTombstone(db, "memory/mac-docs/PESSOAL/x.md", false).refused, "no-tombstone");

  writeFileSync(join(MEM, "trash.md"), doc(2));
  await routeIngest(join(MEM, "trash.md"));
  unlinkSync(join(MEM, "trash.md"));
  tombstoneFile(db, "memory/trash.md", false, "deleted");
  assert.deepEqual(purgeTombstone(db, "memory/trash.md", false, { dryRun: true }), { chunks: 2 });
  assert.equal(rows("memory/trash.md").length, 2, "dry run writes nothing");
  assert.deepEqual(purgeTombstone(db, "memory/trash.md", false), { chunks: 2 });
  assert.equal(rows("memory/trash.md").length, 0);
  assert.equal(listTombstones(db, { all: true }).some((x: any) => x.source_file === "memory/trash.md"), false);
});
