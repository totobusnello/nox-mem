// reindex-errors.ts — error classes for reindex.ts, extracted so the canary
// test can import them without pulling getDb / op-audit / ingest-router deps.

export const MIN_RETENTION_RATIO = Number(
  process.env.NOX_REINDEX_MIN_RETENTION_RATIO ?? "0.90",
);

export class ReindexWipeDetectedError extends Error {
  readonly preCount: number;
  readonly postCount: number;
  readonly ratio: number;
  constructor(preCount: number, postCount: number, ratio: number) {
    super(
      `[reindex] WIPE DETECTED: post-reindex chunks=${postCount} < ${(ratio * 100).toFixed(1)}% of pre=${preCount} ` +
        `(threshold=${(ratio * 100).toFixed(1)}%). ` +
        `Aborting via thrown error so withOpAudit() runs the failure path and preserves the pre-op snapshot. ` +
        `Recover via safeRestore() from your configured snapshot dir ` +
        `($NOX_PRE_OP_SNAPSHOT_DIR; default /var/backups/nox-mem/pre-op on origin, ` +
        `<NOX_MEM_DIR|DB dir>/.nox-snapshots standalone)/reindex-<src>-<ts>-*.db. ` +
        `Set NOX_REINDEX_ALLOW_WIPE=1 ONLY if intentional content removal is expected.`,
    );
    this.name = "ReindexWipeDetectedError";
    this.preCount = preCount;
    this.postCount = postCount;
    this.ratio = ratio;
  }
}

/**
 * Thrown BEFORE any mutation when the rebuild source cannot be what the caller
 * thinks it is: no source directory exists, or the scan found no file while
 * the DB holds chunks. Without this, a reindex on a machine without
 * $OPENCLAW_WORKSPACE scanned nothing and then deleted every chunk as "orphan";
 * the ratio guard only fired after the DELETE (2026-09-28).
 */
export class ReindexSourceMissingError extends Error {
  readonly roots: string[];
  readonly preCount: number;
  readonly reason: "no-source-dir" | "no-files";
  constructor(roots: string[], preCount: number, reason: "no-source-dir" | "no-files") {
    super(
      `[reindex] REFUSED before touching the DB: ` +
        (reason === "no-files"
          ? `found 0 files under ${roots.join(", ")} while the DB holds ${preCount} chunks. `
          : `no source directory exists (looked for ${roots.join(", ")}) while the DB holds ${preCount} chunks. `) +
        `reindex rebuilds ONLY from $OPENCLAW_WORKSPACE/memory and $OPENCLAW_WORKSPACE/shared ` +
        `(OPENCLAW_WORKSPACE=${process.env.OPENCLAW_WORKSPACE ?? "<unset>"}); running it now would delete every chunk. ` +
        `Standalone installs that add notes with \`nox-mem ingest <file>\` do not need reindex. ` +
        `Set NOX_REINDEX_ALLOW_WIPE=1 ONLY if emptying the DB is intended.`,
    );
    this.name = "ReindexSourceMissingError";
    this.roots = roots;
    this.preCount = preCount;
    this.reason = reason;
  }
}

/**
 * Thrown BEFORE any mutation when the DB being rebuilt is not the DB of the
 * workspace being scanned. With NOX_DB_PATH set and OPENCLAW_WORKSPACE unset,
 * reindex scanned the default /root/.openclaw/workspace and treated every
 * chunk of the NOX_DB_PATH database that did not come from there as an orphan.
 * (With both set and disagreeing, op-audit already aborts — incident 2026-05-25.)
 */
export class ReindexWorkspaceMismatchError extends Error {
  readonly dbPath: string;
  readonly workspaceDbPath: string;
  constructor(dbPath: string, workspaceDbPath: string) {
    super(
      `[reindex] REFUSED before touching the DB: NOX_DB_PATH=${dbPath} is not the database of the workspace ` +
        `reindex would scan (OPENCLAW_WORKSPACE unset ⇒ default workspace, whose DB is ${workspaceDbPath}). ` +
        `Set OPENCLAW_WORKSPACE to the workspace that owns this DB, or unset NOX_DB_PATH.`,
    );
    this.name = "ReindexWorkspaceMismatchError";
    this.dbPath = dbPath;
    this.workspaceDbPath = workspaceDbPath;
  }
}
