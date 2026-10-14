/**
 * ingest-many.ts — `nox-mem ingest <files...>`: ingest every path given.
 *
 * The command used to take a single `<file>`, so `nox-mem ingest notes/*.md`
 * indexed the first match and silently dropped the rest. Now each path is
 * ingested in order; a path that cannot be ingested (a directory, a missing
 * file, a parse error) is reported by name and does NOT stop the others. The
 * caller exits non-zero if any path failed.
 */

import { statSync } from "node:fs";

export interface IngestOneResult {
  chunks: number;
  kind: string;
  routedTo: string;
  /** write-path diff, when the ingest reports it (chunk-sync.ts) */
  inserted?: number[];
  kept?: number;
  deleted?: number;
  adopted?: number;
}

export interface IngestManyDeps {
  ingestOne: (path: string) => Promise<IngestOneResult>;
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface IngestManyResult {
  ok: number;
  failed: number;
}

/** Why a path is not ingestable before we even try, or null when it looks fine. */
function preflight(path: string): string | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return "no such file";
  }
  if (st.isDirectory()) {
    return "is a directory, not a file (pass files, e.g. nox-mem ingest dir/*.md)";
  }
  return null;
}

export async function ingestMany(paths: string[], deps: IngestManyDeps): Promise<IngestManyResult> {
  let ok = 0;
  let failed = 0;
  for (const path of paths) {
    const problem = preflight(path);
    if (problem) {
      deps.error(`[ERROR] ${path}: ${problem}`);
      failed++;
      continue;
    }
    try {
      const r = await deps.ingestOne(path);
      const diff = r.kept === undefined ? "" :
        ` — ${r.inserted?.length ?? 0} new, ${r.kept} unchanged, ${r.deleted ?? 0} removed${r.adopted ? `, ${r.adopted} adopted` : ""}`;
      deps.log(`[INFO] Ingested ${path}: ${r.chunks} chunks${diff} (kind=${r.kind}, via=${r.routedTo})`);
      ok++;
    } catch (err) {
      deps.error(`[ERROR] ${path}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  if (paths.length > 1 || failed > 0) {
    deps.log(`[INFO] ingest: ${ok} ingested, ${failed} failed (of ${paths.length})`);
  }
  return { ok, failed };
}
