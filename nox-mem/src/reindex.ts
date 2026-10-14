// reindex.ts — UPSERT-based reindex (emergency fix 2026-05-23)
//
// 🚨 INCIDENT HISTORY (3 occurrences):
//   - 2026-04-25: end-of-day cron reindex wiped section/retention metadata of 183 entities.
//                 Patched by switching cron to `consolidate`. Reindex CODE itself still buggy.
//   - 2026-05-19: eval ingest cruzou pro main DB (~5828 chunks lost). PR #145 4-layer guard.
//   - 2026-05-23 23:17 BRT: nightly reindex overwrote chunks. Recovery via pre-op snapshot
//                 in /var/backups/nox-mem/pre-op/ (69032 chunks).
//
// ROOT CAUSE (3rd incident):
//   Pre-fix flow was DESTRUCTIVE-THEN-REBUILD:
//     1. SELECT access metadata into in-memory Map (snapshot)
//     2. `DELETE FROM chunks`               <- IRREVERSIBLE in-band
//     3. For each file: routeIngest (re-INSERT)
//     4. UPDATE chunks SET tier=... (restore from Map by prefix match)
//
//   Failure modes:
//     a) Gemini API quota / network failure mid-ingest -> partial DB
//     b) Single bad file throw -> caught per-file but no resume
//     c) Map key collision (chunk_text prefix 80 chars) -> restore mis-attributes
//     d) sqlite-vec trigger failure -> DELETE itself fails (fixed 2026-05-21)
//     e) Concurrent watcher write between DELETE and routeIngest -> race
//
// FIX — 4 DEFENSE LAYERS:
//
//   Layer 1 (UPSERT): replace destructive DELETE+INSERT with content-addressed UPSERT.
//                     New chunks added, existing chunks preserved (no metadata loss),
//                     orphaned chunks (file deleted on disk) marked tombstone for review.
//   Layer 2 (Audit):  wrap entire flow in withOpAudit('reindex', ...) - already present,
//                     kept for snapshot-pre-op + audit log.
//   Layer 3 (Dry-run): expand --dry-run preview with row-count delta projection.
//   Layer 4 (Invariant): post-reindex sanity check: row_count >= MIN(pre, projected) * 0.90
//                     (allow up to 10% legitimate dedup; abort + rollback if more).
//                     Throws OnWipeDetected so withOpAudit failure path runs and
//                     operator can restore via safeRestore().

import { getDb } from "./db.js";
import { withOpAudit } from "./lib/op-audit.js";
import { routeIngestSync } from "./lib/ingest-router.js";
import { ensureTombstoneTable, tombstoneFile } from "./lib/tombstone.js";
import { existsSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { join, relative, resolve } from "path";
import { ReindexWipeDetectedError, ReindexSourceMissingError, ReindexWorkspaceMismatchError, MIN_RETENTION_RATIO } from "./reindex-errors.js";

export { ReindexWipeDetectedError, ReindexSourceMissingError, ReindexWorkspaceMismatchError } from "./reindex-errors.js";

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || "/root/.openclaw/workspace";

// Layer 4: tunable safety thresholds (env-overridable for emergency operations).
// MIN_RETENTION_RATIO imported from reindex-errors.ts (single source of truth).
const ALLOW_WIPE = process.env.NOX_REINDEX_ALLOW_WIPE === "1";

function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
        results.push(...findFiles(fullPath, extensions));
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(fullPath);
      }
    }
  } catch {
    /* dir may not exist; e.g. shared/ absent on fresh deploy */
  }
  return results;
}

/** The directories reindex rebuilds from, in scan order. */
export function reindexRoots(): string[] {
  return [resolve(WORKSPACE, "memory"), resolve(WORKSPACE, "shared")];
}

function collectReindexFiles(): { memoryFiles: string[]; sharedFiles: string[] } {
  const [memoryRoot, sharedRoot] = reindexRoots();
  return {
    memoryFiles: findFiles(memoryRoot!, [".md", ".json"]),
    sharedFiles: findFiles(sharedRoot!, [".md"]),
  };
}

/**
 * Refuses (throws) when reindex has nothing trustworthy to rebuild from.
 * Only fires in wipe conditions — a deployment whose workspace holds files
 * passes untouched. Overridable with NOX_REINDEX_ALLOW_WIPE=1.
 */
export function assertReindexSource(preCount: number): void {
  // The DB must belong to the workspace being scanned. Only reachable with
  // NOX_DB_PATH set and OPENCLAW_WORKSPACE unset (both set and disagreeing is
  // already refused by op-audit). NOX_DB_PATH pointing at the default
  // workspace's own DB — how origin crons call it — passes.
  if (process.env.NOX_DB_PATH && !process.env.OPENCLAW_WORKSPACE) {
    const dbPath = resolve(process.env.NOX_DB_PATH);
    const workspaceDbPath = resolve(WORKSPACE, "tools", "nox-mem", "nox-mem.db");
    if (dbPath !== workspaceDbPath) throw new ReindexWorkspaceMismatchError(dbPath, workspaceDbPath);
  }
  if (ALLOW_WIPE) return;
  const roots = reindexRoots();
  const existing = roots.filter((r) => existsSync(r));
  if (existing.length === 0) {
    if (preCount > 0) throw new ReindexSourceMissingError(roots, preCount, "no-source-dir");
    return;
  }
  const { memoryFiles, sharedFiles } = collectReindexFiles();
  const found = memoryFiles.length + sharedFiles.length;
  if (found === 0 && preCount > 0) throw new ReindexSourceMissingError(existing, preCount, "no-files");
}

// Content-addressed fingerprint for UPSERT identity.
// (source_file, sha256(chunk_text)) is stable across reindex runs as long as the
// chunker output is deterministic for the same input file. The schema's autoincrement
// `id` is NOT suitable as upsert key because routeIngest produces fresh ids on each call.
function chunkFingerprint(sourceFile: string, chunkText: string): string {
  return createHash("sha256").update(sourceFile).update("\0").update(chunkText).digest("hex").substring(0, 32);
}

interface ReindexImplResult {
  files: number;
  chunks: number;
  preCount: number;
  postCount: number;
  /** rows whose content was unchanged: same id, same vector */
  kept: number;
  inserted: number;
  /** rows removed because their file's content changed (edited away) */
  deleted: number;
  /** rows re-pointed from a tombstoned path (rename) */
  adopted: number;
  /** files with chunks that were no longer on disk — marked, not deleted */
  tombstoned: number;
}

/**
 * Core reindex — a per-file diff, in ONE transaction (2026-10-14, ROADMAP v6 item 3).
 *
 *   1. Files under the reindex roots that left the disk are TOMBSTONED, first —
 *      so a file moved to a new path is adopted (ids kept) when step 2 reaches it.
 *      Their chunks stay. Before, reindex DELETEd every chunk whose file it did
 *      not walk, which included content kept on purpose (D-2026-09-30).
 *   2. Every walked file goes through routeIngestSync → chunk-sync: unchanged
 *      chunks keep their row, new text is inserted, edited-away text removed.
 *      Duplicate rows of the same content (left by the pre-2026-09-28 reindex)
 *      collapse to one, keeping the embedded copy.
 *   3. Distinct content retained is checked BEFORE commit; a breach throws and
 *      the whole transaction rolls back (withOpAudit keeps the snapshot anyway).
 *
 * Chunks of files outside the roots (agents/, sessions/, …) are not touched.
 */
async function _reindexImpl(): Promise<ReindexImplResult> {
  const db = getDb();

  // Load sqlite-vec extension so the vec cascade trigger on chunks can run.
  // Dynamic import via Function() avoids TS2307 in the staged-dir build (no sqlite-vec
  // dep here — real module installed on VPS via package.json at deploy target).
  try {
    const dynImport = new Function("m", "return import(m)") as (m: string) => Promise<{ load: (db: unknown) => void }>;
    const sqliteVec = await dynImport("sqlite-vec");
    sqliteVec.load(db);
  } catch (err) {
    console.error(`[reindex] WARN: failed to load sqlite-vec extension: ${err}`);
    throw new Error(
      "sqlite-vec module not available; cannot safely reindex (vec_chunks trigger would fail)",
    );
  }

  const preCount = (db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c;

  // ── Phase 0 guard (read-only so far): the rebuild source must exist ────────
  // Measured 2026-09-28 on a clean npm install: no $OPENCLAW_WORKSPACE ⇒ the scan
  // found 0 files ⇒ every chunk became an "orphan" and was deleted. Refuse here.
  assertReindexSource(preCount);

  // Retention is measured on DISTINCT content, not rows: removing a redundant
  // copy of content that is still present is not a loss. Measured on rows, a DB
  // doubled by the old bug (2N → N) read as a 50% wipe.
  const distinctContent = (): number =>
    new Set(
      (db.prepare("SELECT source_file, chunk_text FROM chunks").all() as Array<{ source_file: string; chunk_text: string }>)
        .map((r) => chunkFingerprint(r.source_file, r.chunk_text)),
    ).size;
  const preDistinct = distinctContent();
  console.log(`[reindex] Phase 1: ${preCount} chunks, ${preDistinct} distinct`);

  // Same scan as assertReindexSource — one definition of "the source".
  const { memoryFiles, sharedFiles } = collectReindexFiles();
  const allFiles = [...memoryFiles, ...sharedFiles];
  const roots = reindexRoots().map((r) => relative(WORKSPACE, r) + "/");
  const fileErrors: Array<{ file: string; error: string }> = [];
  const t = { chunks: 0, kept: 0, inserted: 0, deleted: 0, adopted: 0, tombstoned: 0 };
  let retainedDistinct = preDistinct;

  ensureTombstoneTable(db);
  db.transaction(() => {
    // ── Phase 2: tombstone what left the disk (before ingest, so renames adopt) ──
    const sources = db.prepare("SELECT DISTINCT source_file FROM chunks").all() as Array<{ source_file: string }>;
    for (const { source_file } of sources) {
      if (!roots.some((r) => source_file.startsWith(r))) continue;
      if (existsSync(resolve(WORKSPACE, source_file))) continue;
      if (tombstoneFile(db, source_file, false, "missing-at-reindex").status === "tombstoned") t.tombstoned++;
    }

    // ── Phase 3: per-file diff ──────────────────────────────────────────────
    for (const file of allFiles) {
      try {
        const r = routeIngestSync(db, file);
        t.chunks += r.chunks;
        t.kept += r.kept ?? 0;
        t.inserted += r.inserted?.length ?? 0;
        t.deleted += r.deleted ?? 0;
        t.adopted += r.adopted ?? 0;
        if (process.env.NOX_REINDEX_VERBOSE === "1") console.log(`[reindex] ${file}: ${r.chunks} chunks`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fileErrors.push({ file, error: msg });
        console.error(`[reindex] ERROR ingesting ${file}: ${msg}`);
      }
    }

    // ── Phase 4: core tier retention_days = NULL contract (preserved) ─────────
    const cols = new Set((db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>).map((r) => r.name));
    if (cols.has("retention_days") && cols.has("tier")) {
      db.exec("UPDATE chunks SET retention_days = NULL WHERE tier = 'core'");
    }

    // ── Layer 4: invariant check, BEFORE commit ─────────────────────────────
    // An edited file replaces content — it is not a loss — so this counts what
    // is present now. A breach throws and rolls the whole reindex back.
    retainedDistinct = distinctContent();
    if (preDistinct > 0 && retainedDistinct / preDistinct < MIN_RETENTION_RATIO && !ALLOW_WIPE) {
      throw new ReindexWipeDetectedError(preDistinct, retainedDistinct, MIN_RETENTION_RATIO);
    }
  })();

  // Re-rebuild FTS index (cheap, idempotent — content= table optimization).
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");

  const postCount = (db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c;
  const ratio = preDistinct === 0 ? 1 : retainedDistinct / preDistinct;
  console.log(
    `[reindex] DONE files=${allFiles.length} pre=${preCount} post=${postCount} ` +
      `ratio=${(ratio * 100).toFixed(1)}% kept=${t.kept} inserted=${t.inserted} deleted=${t.deleted} ` +
      `adopted=${t.adopted} tombstoned=${t.tombstoned} ingest-errors=${fileErrors.length}`,
  );
  if (fileErrors.length > 0) {
    console.error(`[reindex] ${fileErrors.length} files failed; first 5:`);
    for (const fe of fileErrors.slice(0, 5)) console.error(`  - ${fe.file}: ${fe.error}`);
  }

  return { files: allFiles.length, preCount, postCount, ...t };
}

interface ReindexResult {
  files: number;
  chunks: number;
  affected_rows?: number;
  notes?: string;
  dryRun?: boolean;
  preCount?: number;
  postCount?: number;
  /** rows kept unchanged (name kept for API compatibility) */
  upserted?: number;
  inserted?: number;
  /** rows removed because their content was edited away (name kept for API compatibility) */
  orphaned?: number;
  adopted?: number;
  tombstoned?: number;
}

export async function reindex(opts?: { dryRun?: boolean }): Promise<ReindexResult> {
  if (opts?.dryRun) {
    const db = getDb();
    const { memoryFiles, sharedFiles } = collectReindexFiles();
    const allFiles = [...memoryFiles, ...sharedFiles];
    const currentChunks = (db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c;
    const entityFiles = allFiles.filter((f) => f.includes("/memory/entities/")).length;
    const macDocsFiles = allFiles.filter((f) => f.includes("/memory/mac-docs/")).length;
    const sharedCount = sharedFiles.length;
    const otherMemory = memoryFiles.length - entityFiles - macDocsFiles;
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          operation: "reindex",
          mode: "per-file diff in one transaction (2026-10-14)",
          wouldUpsert: {
            currentChunks,
            note: "unchanged chunks keep their row (id, vector, history); files gone from disk are tombstoned, not deleted",
          },
          wouldProcess: {
            totalFiles: allFiles.length,
            breakdown: {
              entityFiles,
              macDocsFiles,
              sharedFiles: sharedCount,
              otherMemoryFiles: otherMemory,
            },
          },
          protected: {
            snapshotPreOp: "YES via withOpAudit",
            coreTierRetention: "YES",
            entityRouting: "YES via routeIngest",
            wipeGuard: `YES via Layer-4 invariant (min ratio ${MIN_RETENTION_RATIO})`,
            upsert: "YES via chunk-sync (DELETE only for text edited away from a file still on disk)",
            missingFiles: "tombstoned (nox-mem tombstones), never deleted",
          },
          estimatedDuration: "2-5 min depending on Gemini API latency",
        },
        null,
        2,
      ),
    );
    return { files: allFiles.length, chunks: currentChunks, dryRun: true };
  }

  // NOTE: withOpAudit(opName, fn) — 2 args, matches prod src/lib/op-audit.ts.
  // db_source context (was "main") folded into notes for audit row visibility.
  return withOpAudit<ReindexResult>("reindex", async () => {
    const r = await _reindexImpl();
    return {
      files: r.files,
      chunks: r.chunks,
      // rows written; kept rows are untouched by design
      affected_rows: r.inserted + r.deleted + r.adopted,
      notes: `db_source=main | ${r.files} files reindexed | pre=${r.preCount} post=${r.postCount} ` +
        `kept=${r.kept} new=${r.inserted} deleted=${r.deleted} adopted=${r.adopted} tombstoned=${r.tombstoned}`,
      preCount: r.preCount,
      postCount: r.postCount,
      upserted: r.kept,
      inserted: r.inserted,
      orphaned: r.deleted,
      adopted: r.adopted,
      tombstoned: r.tombstoned,
    };
  });
}
