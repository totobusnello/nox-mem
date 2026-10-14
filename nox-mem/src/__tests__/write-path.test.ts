// Write path without loss (ROADMAP v6 item 3, 2026-10-14):
//   (a) re-ingesting a file keeps the row (id + vector) of every unchanged chunk;
//   (b) a file that leaves the disk is tombstoned, never deleted; a rename keeps ids;
//   (c) ingest never closes the getDb() handle its caller holds.
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/write-path.test.js)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync, renameSync } from "fs";
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
let tombstoneFile: any, listTombstones: any, keepTombstone: any, purgeTombstone: any, sourceKey: any, resolveSourceArg: any;

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
  ({ tombstoneFile, listTombstones, keepTombstone, purgeTombstone, sourceKey, resolveSourceArg } = await import("../lib/tombstone.js"));
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

// ─── Codex review of nox-workspace#56 (2026-10-14) ─────────────────────────────

test("Codex#1: a shared paragraph is not a rename — partial overlap adopts nothing", async () => {
  writeFileSync(join(MEM, "old1.md"), [SECTION(40), SECTION(41)].join("\n\n"));
  await routeIngest(join(MEM, "old1.md"));
  const oldIds = rows("memory/old1.md").map((r) => r.id);
  unlinkSync(join(MEM, "old1.md"));
  tombstoneFile(getDb(), "memory/old1.md", false, "deleted");

  writeFileSync(join(MEM, "new1.md"), [SECTION(40), SECTION(42)].join("\n\n"));
  const r = await routeIngest(join(MEM, "new1.md"));
  assert.equal(r.adopted, 0);
  // Editing the shared paragraph out of the new file must not touch the old file's row.
  writeFileSync(join(MEM, "new1.md"), SECTION(42));
  await routeIngest(join(MEM, "new1.md"));
  assert.deepEqual(rows("memory/old1.md").map((x) => x.id), oldIds);
});

test("Codex#1: a whole file inside a bigger new one (rename + additions) is adopted", async () => {
  writeFileSync(join(MEM, "old2.md"), SECTION(43));
  await routeIngest(join(MEM, "old2.md"));
  const id = rows("memory/old2.md")[0]!.id;
  unlinkSync(join(MEM, "old2.md"));
  tombstoneFile(getDb(), "memory/old2.md", false, "deleted");
  writeFileSync(join(MEM, "new2.md"), [SECTION(43), SECTION(44)].join("\n\n"));
  const r = await routeIngest(join(MEM, "new2.md"));
  assert.deepEqual([r.adopted, r.inserted.length], [1, 1]);
  assert.ok(rows("memory/new2.md").some((x) => x.id === id));
});

test("Codex#2: a file tombstoned by reindex (missing-at-reindex) is never adopted", async () => {
  getDb().prepare("INSERT INTO chunks (source_file, chunk_type, chunk_text) VALUES ('memory/mac-docs/PESSOAL/old.md', 'other', ?)").run(SECTION(45));
  tombstoneFile(getDb(), "memory/mac-docs/PESSOAL/old.md", false, "missing-at-reindex");
  writeFileSync(join(MEM, "fortyfive.md"), SECTION(45));
  const r = await routeIngest(join(MEM, "fortyfive.md"));
  assert.equal(r.adopted, 0);
  assert.equal(rows("memory/mac-docs/PESSOAL/old.md").length, 1);
});

test("Codex#3: explicit values (refreshKept) land on a kept row; id stays", async () => {
  const { syncFileChunks } = await import("../lib/chunk-sync.js");
  const db = getDb();
  const base = { section: "compiled", chunk_type: "lesson", source_date: null, tier: "working", importance: 0.9, retention_days: 180, section_boost: 2 };
  const first = syncFileChunks(db, "memory/entities/lessons/ep1.md", [{ ...base, chunk_text: "same text", pain: 0.2, metadata: "{}" }]);
  const again = syncFileChunks(db, "memory/entities/lessons/ep1.md",
    [{ ...base, chunk_text: "same text", pain: 1.0, metadata: '{"p2":{"severity":"S4"}}' }],
    { refreshKept: { pain: true, metadata: true } });
  assert.deepEqual(again.ids, first.ids);
  const row = db.prepare("SELECT pain, metadata FROM chunks WHERE id = ?").get(first.ids[0]) as { pain: number; metadata: string };
  assert.equal(row.pain, 1.0);
  assert.equal(row.metadata, '{"p2":{"severity":"S4"}}');
  // without refreshKept, a plain re-ingest keeps the stored values
  syncFileChunks(db, "memory/entities/lessons/ep1.md", [{ ...base, chunk_text: "same text", pain: 0.2, metadata: "{}" }]);
  assert.equal((db.prepare("SELECT pain FROM chunks WHERE id = ?").get(first.ids[0]) as { pain: number }).pain, 1.0);
});

test("Codex#4: a core chunk keeps retention_days = NULL across re-ingest", async () => {
  writeFileSync(join(MEM, "core.md"), SECTION(46));
  await routeIngest(join(MEM, "core.md"));
  const id = rows("memory/core.md")[0]!.id;
  getDb().prepare("UPDATE chunks SET tier = 'core', retention_days = NULL WHERE id = ?").run(id);
  await routeIngest(join(MEM, "core.md"));
  const row = getDb().prepare("SELECT retention_days FROM chunks WHERE id = ?").get(id) as { retention_days: number | null };
  assert.equal(row.retention_days, null);
});

test("Codex#5: a moved directory — tombstone by prefix, then its files adopt by path", async () => {
  const { tombstonePrefix } = await import("../lib/tombstone.js");
  const { existsSync } = await import("fs");
  mkdirSync(join(MEM, "foo"), { recursive: true });
  writeFileSync(join(MEM, "foo", "a.md"), SECTION(47));
  writeFileSync(join(MEM, "foo", "b.md"), SECTION(48));
  await routeIngest(join(MEM, "foo", "a.md"));
  await routeIngest(join(MEM, "foo", "b.md"));
  const before = [...rows("memory/foo/a.md"), ...rows("memory/foo/b.md")].map((x) => x.id).sort();
  renameSync(join(MEM, "foo"), join(MEM, "bar"));

  const t = tombstonePrefix(getDb(), "memory/foo", (p: string) => existsSync(join(WS, p)), "deleted");
  assert.deepEqual(t, { files: 2, chunks: 2 });
  await routeIngest(join(MEM, "bar", "a.md"));
  await routeIngest(join(MEM, "bar", "b.md"));
  const after = [...rows("memory/bar/a.md"), ...rows("memory/bar/b.md")].map((x) => x.id).sort();
  assert.deepEqual(after, before);
});

// ─── Kimi review of nox-workspace#56 (2026-10-14) ──────────────────────────────

test("Kimi: a tombstoned file restored to disk (not yet re-ingested) is not adopted by another path", async () => {
  writeFileSync(join(MEM, "back.md"), SECTION(50));
  await routeIngest(join(MEM, "back.md"));
  const id = rows("memory/back.md")[0]!.id;
  unlinkSync(join(MEM, "back.md"));
  tombstoneFile(getDb(), "memory/back.md", false, "deleted");
  writeFileSync(join(MEM, "back.md"), SECTION(50)); // restored while the watcher was down
  writeFileSync(join(MEM, "copycat.md"), SECTION(50));
  const r = await routeIngest(join(MEM, "copycat.md"));
  assert.equal(r.adopted, 0);
  assert.equal(rows("memory/back.md")[0]!.id, id);
});

test("Codex r2: explicit values land on ADOPTED rows too", async () => {
  const { syncFileChunks } = await import("../lib/chunk-sync.js");
  const db = getDb();
  const base = { section: "compiled", chunk_type: "lesson", source_date: null, tier: "working", importance: 0.9, retention_days: 180, section_boost: 2 };
  const first = syncFileChunks(db, "memory/entities/lessons/ep-old.md", [{ ...base, chunk_text: "adopted text", pain: 0.2, metadata: "{}" }]);
  tombstoneFile(db, "memory/entities/lessons/ep-old.md", false, "deleted");
  const r = syncFileChunks(db, "memory/entities/lessons/ep-new.md",
    [{ ...base, chunk_text: "adopted text", pain: 1.0, metadata: "{\"p2\":1}" }],
    { refreshKept: { pain: true, metadata: true } });
  assert.deepEqual([r.adopted, r.ids[0]], [1, first.ids[0]]);
  const row = db.prepare("SELECT pain, metadata FROM chunks WHERE id = ?").get(first.ids[0]) as { pain: number; metadata: string };
  assert.deepEqual([row.pain, row.metadata], [1.0, "{\"p2\":1}"]);
});

test("sourceKey lands on the key ingest wrote — relative or absolute, inside or outside the workspace", async () => {
  // Standalone install: the notes live outside OPENCLAW_WORKSPACE, so keys start with `../`.
  // The CLI kept a relative argument as typed and refused `../` keys: `tombstone notes/x.md`
  // missed the chunks and an absolute path was rejected (found in the 3.6.0 tarball smoke).
  const notes = join(TMP_ROOT, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "x.md"), doc(2));
  const cwd = process.cwd();
  try {
    process.chdir(TMP_ROOT);
    await routeIngest("notes/x.md");
    const stored = getDb().prepare("SELECT DISTINCT source_file FROM chunks WHERE source_file LIKE '%notes/x.md'").all() as Array<{ source_file: string }>;
    assert.equal(stored.length, 1);
    const key = stored[0]!.source_file;
    assert.ok(key.startsWith("../"), key);
    assert.equal(sourceKey("notes/x.md"), key);
    assert.equal(sourceKey(join(notes, "x.md")), key);
    assert.equal(sourceKey(join(MEM, "a.md")), "memory/a.md");

    const ids = rows(key).map((r) => r.id);
    renameSync(join(notes, "x.md"), join(notes, "y.md"));
    assert.equal(tombstoneFile(getDb(), sourceKey("notes/x.md"), false, "deleted").status, "tombstoned");
    await routeIngest("notes/y.md");
    assert.deepEqual(rows(sourceKey("notes/y.md")).map((r) => r.id), ids, "rename outside the workspace lost the ids");
  } finally {
    process.chdir(cwd);
  }
});

test("every tombstone CLI command resolves its path through sourceKey", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "index.ts"), "utf8");
  const fn = src.slice(src.indexOf("async function tombstonePath"), src.indexOf("program", src.indexOf("async function tombstonePath")));
  assert.ok(fn.includes("resolveSourceArg(getDb(), arg)"), fn);
  assert.ok(!fn.includes('startsWith("..")'), "tombstonePath refuses keys outside the workspace again");
});

test("a CLI argument may be the key as `tombstones` lists it, or a path from the cwd; both stored ⇒ refuse", async () => {
  const cwd = process.cwd();
  try {
    writeFileSync(join(MEM, "k.md"), doc(2));
    await routeIngest(join(MEM, "k.md"));
    // Review workflow: paste the listed key back, from any cwd.
    process.chdir(TMP_ROOT);
    assert.equal(resolveSourceArg(getDb(), "memory/k.md"), "memory/k.md");
    // Path from the cwd, inside the workspace.
    process.chdir(WS);
    assert.equal(resolveSourceArg(getDb(), "memory/k.md"), "memory/k.md");
    process.chdir(MEM);
    assert.equal(resolveSourceArg(getDb(), "k.md"), "memory/k.md");
    // Nothing stored under either reading ⇒ the path reading (reports no-chunks downstream).
    assert.equal(resolveSourceArg(getDb(), "nope.md"), "memory/nope.md");
    // Two different stored files under the two readings ⇒ refuse.
    mkdirSync(join(MEM, "memory"), { recursive: true });
    writeFileSync(join(MEM, "memory", "k.md"), doc(3, { 0: " nested" }));
    await routeIngest(join(MEM, "memory", "k.md"));
    assert.throws(() => resolveSourceArg(getDb(), "memory/k.md"), /ambiguous/);
  } finally {
    process.chdir(cwd);
  }
});
