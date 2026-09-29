/**
 * src/lib/db-path.ts — the ONE place the database path is resolved.
 *
 * db.ts (which opens the DB) and op-audit.ts (which snapshots it before a
 * destructive op) used to resolve the path separately. With no env set they
 * disagreed: db.ts fell back to `<package>/nox-mem.db` while op-audit assumed
 * `/root/.openclaw/workspace/tools/nox-mem/nox-mem.db` — the snapshot protected
 * a different file than the op mutated (same class as incident 2026-05-25).
 *
 * Priority:
 *   1. NOX_DB_PATH                                   explicit override
 *   2. $OPENCLAW_WORKSPACE/tools/nox-mem/nox-mem.db  origin deployments
 *   3. <package root>/nox-mem.db, ONLY IF IT EXISTS  legacy: keeps every existing
 *      install (the VPS tree, 3.3.0 users) on the file it already uses
 *   4. ~/.nox-mem/nox.db                             new standalone default
 *
 * Step 4 replaces the old unconditional step 3: for `npm install -g`, the package
 * root is inside node_modules, and `npm update -g` replaces that directory —
 * taking the database with it.
 */

import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve, sep } from "path";
import { fileURLToPath } from "url";

/** `<package root>` = parent of dist/ (compiled) or src/ (ts). */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const LEGACY_DB_PATH = resolve(PACKAGE_ROOT, "nox-mem.db");
export const DEFAULT_STANDALONE_DB_PATH = join(homedir(), ".nox-mem", "nox.db");

export type DbPathSource = "NOX_DB_PATH" | "OPENCLAW_WORKSPACE" | "legacy-package" | "standalone-default";

export function resolveDbPathWithSource(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): { path: string; source: DbPathSource } {
  if (env.NOX_DB_PATH) return { path: resolve(env.NOX_DB_PATH), source: "NOX_DB_PATH" };
  if (env.OPENCLAW_WORKSPACE) {
    return { path: resolve(env.OPENCLAW_WORKSPACE, "tools", "nox-mem", "nox-mem.db"), source: "OPENCLAW_WORKSPACE" };
  }
  if (exists(LEGACY_DB_PATH)) return { path: LEGACY_DB_PATH, source: "legacy-package" };
  return { path: DEFAULT_STANDALONE_DB_PATH, source: "standalone-default" };
}

export function resolveDbPath(): string {
  return resolveDbPathWithSource().path;
}

/** True when the path sits inside a node_modules tree (wiped by npm update/uninstall). */
export function isInsideNodeModules(p: string): boolean {
  return resolve(p).split(sep).includes("node_modules");
}

/**
 * mkdir -p the directory that will hold the database, mode 0700 (the DB holds
 * the user's notes). No-op when it already exists, so an existing directory's
 * permissions are never changed. Returns true when it created anything.
 */
export function ensureDbParentDir(dbPath: string): boolean {
  const dir = dirname(resolve(dbPath));
  if (existsSync(dir)) return false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return true;
}
