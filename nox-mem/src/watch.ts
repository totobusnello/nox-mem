/**
 * watch.ts — Auto-ingest via fs.watch on agent memory directories
 *
 * Monitors memory files across all 6 agent workspaces.
 * On change: debounce 2s → ingest file → log.
 * On a path that no longer exists (delete, or the old side of a rename):
 * tombstone its chunks — they stay, marked for review (lib/tombstone.ts).
 * Skips: binary files, .db, .json session files, tmp files.
 */

import { watch, statSync, existsSync } from "fs";
import { resolve, extname, relative } from "path";
import { routeIngest } from "./lib/ingest-router.js";
import { getDb } from "./db.js";
import { tombstoneFile } from "./lib/tombstone.js";

const WORKSPACE = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";

// NOX_WATCH_DIRS: comma-separated list of ABSOLUTE paths to watch.
// If unset, falls back to the default OpenClaw workspace layout below.
// Example: NOX_WATCH_DIRS=/data/memory,/data/shared
const _NOX_WATCH_DIRS = process.env.NOX_WATCH_DIRS;

// Directories to watch (recursive).
// Default layout assumes OpenClaw multi-agent workspace; override via NOX_WATCH_DIRS.
const WATCH_DIRS: string[] = _NOX_WATCH_DIRS
  ? _NOX_WATCH_DIRS.split(",").map((d) => d.trim()).filter(Boolean)
  : [
      resolve(WORKSPACE, "memory"),
      resolve(WORKSPACE, "shared"),
      resolve(WORKSPACE, "agents/nox/memory"),
      resolve(WORKSPACE, "agents/forge/memory"),
      resolve(WORKSPACE, "agents/atlas/memory"),
      resolve(WORKSPACE, "agents/cipher/memory"),
      resolve(WORKSPACE, "agents/boris/memory"),
      resolve(WORKSPACE, "agents/lex/memory"),
      // Also root agent files
      resolve(WORKSPACE, "agents/nox"),
      resolve(WORKSPACE, "agents/forge"),
      resolve(WORKSPACE, "agents/atlas"),
      resolve(WORKSPACE, "agents/cipher"),
      resolve(WORKSPACE, "agents/boris"),
      resolve(WORKSPACE, "agents/lex"),
    ];

// File extensions to process
const ALLOWED_EXTS = new Set([".md", ".txt"]);

// Files/patterns to skip
const SKIP_PATTERNS = [
  /\.db$/,
  /\.db-wal$/,
  /\.db-shm$/,
  /\.json$/,
  /\.jsonl$/,
  /\.log$/,
  /^\./, // dotfiles
  /~$/, // temp files
  /\.swp$/,
  /node_modules/,
  /sessions\//,
  /dist\//,
];

function shouldProcess(filepath: string): boolean {
  const ext = extname(filepath);
  if (!ALLOWED_EXTS.has(ext)) return false;
  return !SKIP_PATTERNS.some(p => p.test(filepath));
}

// Debounce map: filepath → timer
const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 2000;

function tombstoneMissing(filepath: string): void {
  const rel = relative(WORKSPACE, filepath);
  if (rel.startsWith("..")) return; // NOX_WATCH_DIRS outside the workspace: no source_file to match
  try {
    const r = tombstoneFile(getDb(), rel, existsSync(filepath), "deleted");
    if (r.status === "tombstoned") {
      console.log(`[WATCH] ${new Date().toISOString()} tombstoned ${r.chunks} chunks ← ${rel} (kept; review with: nox-mem tombstones)`);
    }
  } catch (err) {
    console.error(`[WATCH] Error tombstoning ${filepath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function processFile(filepath: string): Promise<void> {
  if (!existsSync(filepath)) return tombstoneMissing(filepath); // deleted or renamed away
  try {
    const stat = statSync(filepath);
    if (!stat.isFile()) return;
    if (stat.size === 0) return;
    if (stat.size > 5 * 1024 * 1024) return; // skip > 5MB

    const result = await routeIngest(filepath);
    const changed = (result.inserted?.length ?? 0) + (result.deleted ?? 0) + (result.adopted ?? 0);
    if (result && changed > 0) {
      console.log(
        `[WATCH] ${new Date().toISOString()} +${result.inserted?.length ?? 0} new, -${result.deleted ?? 0} removed, ` +
          `${result.kept ?? 0} kept, ${result.adopted ?? 0} adopted ← ${filepath.replace(WORKSPACE, "")}`,
      );
    }
  } catch (err) {
    // Non-fatal: file may be locked or deleted mid-write
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[WATCH] Error processing ${filepath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function debounceIngest(filepath: string): void {
  const existing = debounceMap.get(filepath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceMap.delete(filepath);
    processFile(filepath);
  }, DEBOUNCE_MS);

  debounceMap.set(filepath, timer);
}

export function startWatch(verbose = false): void {
  let watcherCount = 0;
  const started: string[] = [];

  for (const dir of WATCH_DIRS) {
    if (!existsSync(dir)) {
      if (verbose) console.log(`[WATCH] Skip (not found): ${dir}`);
      continue;
    }

    try {
      watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const filepath = resolve(dir, filename);
        if (!shouldProcess(filepath)) return;
        debounceIngest(filepath);
      });
      watcherCount++;
      started.push(dir.replace(WORKSPACE, ""));
    } catch (err) {
      console.error(`[WATCH] Failed to watch ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`[WATCH] Watching ${watcherCount} directories:`);
  started.forEach(d => console.log(`  • ${d}`));
  console.log("[WATCH] Ready — waiting for changes (Ctrl+C to stop)");
}
