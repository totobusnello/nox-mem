// tombstone.ts — what happens to chunks when their file leaves the disk
// (ROADMAP v6 item 3b, 2026-10-14).
//
// Before: the watcher ignored deletions (chunks stayed forever, unmarked) and
// reindex DELETEd every chunk whose file it did not find — including files kept
// on purpose after their source left the disk (D-2026-09-30: mac-docs PESSOAL /
// BANCOS). A rename left the old path's chunks behind as duplicates.
//
// Now a file that leaves the disk gets a TOMBSTONE row. Its chunks stay where
// they are, searchable as before — nothing here deletes on its own:
//   - a later ingest of the same path removes the tombstone (the file came back);
//   - an ingest of a NEW path with identical chunk text adopts the rows
//     (chunk-sync.ts), so a rename keeps ids and vectors; the tombstone then
//     records `renamed_to`;
//   - `kept_at` marks a tombstone reviewed as "keep this content" (excluded from
//     adoption and from the default listing);
//   - only purgeTombstone(), called by an explicit operator command under
//     withOpAudit, deletes chunks.
//
// Ranking is NOT touched: demoting tombstoned chunks is a scoring change and
// goes through its own feat(search) + shadow (CLAUDE.md rule 5).
//
// The table is created lazily (like ensureVecTable) instead of by a schema
// bump: the npm and production lineages number their schema versions
// differently, and a CREATE TABLE IF NOT EXISTS lands the same on both.

import Database from "better-sqlite3";
import { relative, resolve } from "path";
import { workspaceRoot } from "./workspace.js";

/**
 * The `source_file` key ingest writes for `path`: `relative(WORKSPACE, filePath)`
 * in ingest.ts and ingest-router.ts, where `relative()` resolves a relative
 * argument against the cwd. Every command that names a file by path has to land
 * on this same key, or it silently misses the chunks.
 *
 * On a standalone install nothing lives under the default workspace, so keys
 * start with `../`; that is the key, not an error.
 */
export function sourceKey(path: string): string {
  return relative(workspaceRoot(), resolve(path));
}

/**
 * What a CLI argument names: either a key exactly as `nox-mem tombstones` lists
 * it (the review workflow pastes it back), or a path on disk relative to the cwd
 * (`sourceKey`). The two coincide when the cwd is the workspace. When they differ
 * and both are stored, they are two different files, so refuse rather than guess.
 */
export function resolveSourceArg(db: Database.Database, arg: string): string {
  ensureTombstoneTable(db);
  const fromPath = sourceKey(arg);
  const stored = (k: string) =>
    db.prepare("SELECT 1 FROM chunks WHERE source_file = ? UNION ALL SELECT 1 FROM chunk_tombstones WHERE source_file = ? LIMIT 1").get(k, k) !== undefined;
  const hits = [...new Set([arg, fromPath])].filter(stored);
  if (hits.length > 1) {
    throw new Error(`ambiguous: "${arg}" is a stored key, and as a path from the cwd it is "${fromPath}", also stored. Pass an absolute path, or run from the workspace.`);
  }
  return hits[0] ?? fromPath;
}

export type TombstoneReason = "deleted" | "missing-at-reindex";

export function ensureTombstoneTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS chunk_tombstones (
    source_file TEXT PRIMARY KEY,
    tombstoned_at TEXT NOT NULL DEFAULT (datetime('now')),
    reason TEXT NOT NULL,
    chunks_at_tombstone INTEGER NOT NULL,
    renamed_to TEXT,
    kept_at TEXT
  )`);
}

export type TombstoneStatus = "tombstoned" | "already" | "no-chunks" | "exists-on-disk";

/**
 * Mark `relPath` as gone from disk. `existsOnDisk` is passed in (not probed
 * here) so the caller decides how a path resolves against its workspace.
 */
export function tombstoneFile(
  db: Database.Database,
  relPath: string,
  existsOnDisk: boolean,
  reason: TombstoneReason,
): { status: TombstoneStatus; chunks: number } {
  ensureTombstoneTable(db);
  if (existsOnDisk) return { status: "exists-on-disk", chunks: 0 };
  const chunks = (db.prepare("SELECT COUNT(*) AS c FROM chunks WHERE source_file = ?").get(relPath) as { c: number }).c;
  if (chunks === 0) return { status: "no-chunks", chunks: 0 };
  const r = db
    .prepare("INSERT OR IGNORE INTO chunk_tombstones (source_file, reason, chunks_at_tombstone) VALUES (?, ?, ?)")
    .run(relPath, reason, chunks);
  return { status: r.changes > 0 ? "tombstoned" : "already", chunks };
}

/**
 * A directory left the disk (rm -r, or the old side of `mv dir/ other/`):
 * tombstone every stored file under it that is no longer on disk. inotify
 * reports a moved directory as ONE event, not one per file inside it.
 */
export function tombstonePrefix(
  db: Database.Database,
  relDir: string,
  existsOnDisk: (relPath: string) => boolean,
  reason: TombstoneReason,
): { files: number; chunks: number } {
  ensureTombstoneTable(db);
  const prefix = relDir.replace(/\/+$/, "") + "/";
  const files = db
    .prepare("SELECT DISTINCT source_file FROM chunks WHERE substr(source_file, 1, ?) = ?")
    .all(prefix.length, prefix) as Array<{ source_file: string }>;
  let n = 0, chunks = 0;
  db.transaction(() => {
    for (const { source_file } of files) {
      const r = tombstoneFile(db, source_file, existsOnDisk(source_file), reason);
      if (r.status === "tombstoned") { n++; chunks += r.chunks; }
    }
  })();
  return { files: n, chunks };
}

/** Called inside chunk-sync's transaction after a file is (re)ingested. */
export function resolveTombstoneOnIngest(db: Database.Database, relPath: string, adoptedFrom: string[]): void {
  db.prepare("DELETE FROM chunk_tombstones WHERE source_file = ?").run(relPath);
  const mark = db.prepare("UPDATE chunk_tombstones SET renamed_to = ? WHERE source_file = ?");
  for (const from of adoptedFrom) mark.run(relPath, from);
}

export interface TombstoneRow {
  source_file: string;
  tombstoned_at: string;
  reason: string;
  chunks_at_tombstone: number;
  renamed_to: string | null;
  kept_at: string | null;
  /** chunks still stored under this path */
  live_chunks: number;
  /** of those, how many have identical text stored under another path */
  duplicated_elsewhere: number;
}

/** Default: tombstones that still hold chunks and were not reviewed as kept. */
/**
 * One pass, no correlated subquery (2026-10-15). The previous form ran a correlated EXISTS on chunk_text
 * per tombstoned chunk; SQLite answered it with an automatic index over every chunk, and it took 8.5 min
 * on 52.9k chunks with 20 tombstones. A tombstoned chunk is "duplicated elsewhere" when its text is
 * stored under more than one path (its own is one of them), the same predicate as before.
 */
export const LIST_TOMBSTONES_SQL = `WITH tc AS (
         SELECT c.source_file, c.chunk_text FROM chunks c JOIN chunk_tombstones t ON t.source_file = c.source_file
       ),
       shared AS (
         SELECT o.chunk_text FROM chunks o
          WHERE o.chunk_text IN (SELECT chunk_text FROM tc)
          GROUP BY o.chunk_text HAVING COUNT(DISTINCT o.source_file) > 1
       ),
       agg AS (
         SELECT source_file, COUNT(*) AS live_chunks,
                SUM(chunk_text IN (SELECT chunk_text FROM shared)) AS duplicated_elsewhere
           FROM tc GROUP BY source_file
       )
       SELECT t.*, COALESCE(a.live_chunks, 0) AS live_chunks, COALESCE(a.duplicated_elsewhere, 0) AS duplicated_elsewhere
         FROM chunk_tombstones t LEFT JOIN agg a ON a.source_file = t.source_file
        ORDER BY t.tombstoned_at, t.source_file`;

export function listTombstones(db: Database.Database, opts: { all?: boolean } = {}): TombstoneRow[] {
  ensureTombstoneTable(db);
  const rows = db.prepare(LIST_TOMBSTONES_SQL).all() as TombstoneRow[];
  return opts.all ? rows : rows.filter((r) => r.live_chunks > 0 && r.kept_at === null);
}

/** Review outcome "keep": content stays, tombstone leaves the default listing. */
export function keepTombstone(db: Database.Database, relPath: string): boolean {
  ensureTombstoneTable(db);
  return db.prepare("UPDATE chunk_tombstones SET kept_at = datetime('now') WHERE source_file = ? AND kept_at IS NULL")
    .run(relPath).changes > 0;
}

export type PurgeRefusal = "no-tombstone" | "kept" | "exists-on-disk";

/**
 * The ONLY place that deletes a tombstoned file's chunks. Callers wrap it in
 * withOpAudit (snapshot first). Refuses when the file is back on disk, when it
 * was never tombstoned, or when it was reviewed as kept.
 */
export function purgeTombstone(
  db: Database.Database,
  relPath: string,
  existsOnDisk: boolean,
  opts: { dryRun?: boolean } = {},
): { refused?: PurgeRefusal; chunks: number } {
  ensureTombstoneTable(db);
  if (existsOnDisk) return { refused: "exists-on-disk", chunks: 0 };
  const t = db.prepare("SELECT kept_at FROM chunk_tombstones WHERE source_file = ?").get(relPath) as
    | { kept_at: string | null }
    | undefined;
  if (!t) return { refused: "no-tombstone", chunks: 0 };
  if (t.kept_at !== null) return { refused: "kept", chunks: 0 };
  const chunks = (db.prepare("SELECT COUNT(*) AS c FROM chunks WHERE source_file = ?").get(relPath) as { c: number }).c;
  if (opts.dryRun) return { chunks };
  db.transaction(() => {
    db.prepare("DELETE FROM chunks WHERE source_file = ?").run(relPath);
    db.prepare("DELETE FROM chunk_tombstones WHERE source_file = ?").run(relPath);
  })();
  return { chunks };
}
