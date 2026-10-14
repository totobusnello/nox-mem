/**
 * src/lib/workspace.ts — the ONE place the workspace root is resolved.
 *
 * Every `source_file` key is `relative(workspaceRoot(), file)`, and the
 * workspace layout (`memory/`, `memory/entities/`, `shared/`) is read relative
 * to it: entity routing, chunk types, reindex roots, watch defaults.
 *
 * Priority:
 *   1. $OPENCLAW_WORKSPACE           explicit (origin deployments, agents)
 *   2. /root/.openclaw/workspace     origin layout, when that directory exists
 *   3. ~/.nox-mem                    standalone: where the default DB lives and
 *                                    where install.sh puts notes (`memory/`)
 *
 * Until 3.6.0, step 3 did not exist: a standalone install keyed every file
 * relative to /root/.openclaw/workspace (`../../../home/u/...`), so
 * `memory/entities/` files were never routed to the entity ingest, `watch`
 * watched nothing and `reindex` refused. Schema v20 rewrites those keys
 * (`migrateStandaloneKeys` in db.ts).
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const ORIGIN_WORKSPACE = "/root/.openclaw/workspace";

export type WorkspaceSource = "OPENCLAW_WORKSPACE" | "origin-default" | "standalone";

export function standaloneWorkspace(): string {
  return join(homedir(), ".nox-mem");
}

export function workspaceRootWithSource(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): { root: string; source: WorkspaceSource } {
  if (env.OPENCLAW_WORKSPACE) return { root: env.OPENCLAW_WORKSPACE, source: "OPENCLAW_WORKSPACE" };
  if (exists(ORIGIN_WORKSPACE)) return { root: ORIGIN_WORKSPACE, source: "origin-default" };
  return { root: standaloneWorkspace(), source: "standalone" };
}

export function workspaceRoot(): string {
  return workspaceRootWithSource().root;
}
