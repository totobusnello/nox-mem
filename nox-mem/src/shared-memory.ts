/**
 * shared-memory.ts — Cross-agent memory propagation
 * Allows agents to mark insights as "shared" → propagated to all other agents' DBs
 * Read path: cross-search.ts (already exists, readonly)
 * Write path: this file — explicit "share" action with author tracking
 */
import { getDb } from "./db.js";
import Database from "better-sqlite3";
import { existsSync } from "fs";
import { resolve } from "path";
import { workspaceRoot } from "./lib/workspace.js";

const WORKSPACE = workspaceRoot();
const SHARED_DB = resolve(WORKSPACE, "tools/nox-mem/shared-memory.db");

// NOX_AGENTS_DIR: base directory where agent sub-dirs live.
// NOX_AGENTS: comma-separated list of agent names to include (no spaces).
// Standalone operators: set NOX_AGENTS_DIR to a non-existent path and
// these cross-agent features will degrade gracefully (return empty / skip).
const AGENTS_BASE_DIR = process.env.NOX_AGENTS_DIR ?? "/root/.openclaw/agents";
const _agentList = process.env.NOX_AGENTS
  ? process.env.NOX_AGENTS.split(",").map(s => s.trim()).filter(Boolean)
  : ["forge", "nox", "atlas", "boris", "cipher", "lex"];

const AGENT_DIRS: Record<string, string> = {
  workspace: WORKSPACE,
  ..._agentList.reduce<Record<string, string>>((acc, name) => {
    acc[name] = resolve(AGENTS_BASE_DIR, name);
    return acc;
  }, {}),
};

interface SharedChunk {
  id?: number;
  source_agent: string;
  chunk_text: string;
  chunk_type: string;
  tags: string;
  shared_at?: string;
  propagated_to?: string; // JSON array of agent names
}

function getSharedDb(): Database.Database {
  const db = new (Database as any)(SHARED_DB) as Database.Database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_agent TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      chunk_type TEXT DEFAULT 'shared',
      tags TEXT DEFAULT '[]',
      shared_at TEXT DEFAULT (datetime('now')),
      propagated_to TEXT DEFAULT '[]',
      share_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sc_agent ON shared_chunks(source_agent);
    CREATE INDEX IF NOT EXISTS idx_sc_type ON shared_chunks(chunk_type);
  `);
  return db;
}

/** Share an insight from the current agent to the shared pool */
export function shareInsight(
  text: string,
  chunkType = "insight",
  tags: string[] = [],
  reason?: string
): number {
  const db = getSharedDb();
  const sourceAgent = process.env.AGENT_NAME ?? "unknown";

  const result = db.prepare(`
    INSERT INTO shared_chunks (source_agent, chunk_text, chunk_type, tags, share_reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(sourceAgent, text, chunkType, JSON.stringify(tags), reason ?? null);

  console.log(`[SHARED] Insight shared by ${sourceAgent}: "${text.substring(0, 80)}..."`);
  return result.lastInsertRowid as number;
}

/** Pull unprocessed shared chunks into the current agent's nox-mem DB */
export async function pullSharedInsights(agentName?: string): Promise<number> {
  const agent = agentName ?? process.env.AGENT_NAME ?? "unknown";
  const sharedDb = getSharedDb();
  const localDb = getDb();

  // Get chunks not yet propagated to this agent
  const pending = sharedDb.prepare(`
    SELECT * FROM shared_chunks
    WHERE source_agent != ?
    AND NOT (propagated_to LIKE ?)
    ORDER BY shared_at ASC
  `).all(agent, `%"${agent}"%`) as SharedChunk[];

  if (pending.length === 0) {
    console.log(`[SHARED] No new shared insights for ${agent}`);
    return 0;
  }

  let imported = 0;
  for (const chunk of pending) {
    // Insert into local nox-mem chunks table
    try {
      localDb.prepare(`
        INSERT INTO chunks (source_file, chunk_text, chunk_type, source_date, metadata)
        VALUES (?, ?, ?, date('now'), ?)
      `).run(
        `shared:${chunk.source_agent}`,
        chunk.chunk_text,
        "shared",
        JSON.stringify({ source_agent: chunk.source_agent, tags: chunk.tags, shared_id: chunk.id })
      );

      // Mark as propagated
      const current = JSON.parse((chunk.propagated_to as string) || "[]") as string[];
      current.push(agent);
      sharedDb.prepare(
        "UPDATE shared_chunks SET propagated_to = ? WHERE id = ?"
      ).run(JSON.stringify(current), chunk.id);

      imported++;
    } catch (err) {
      console.error(`[SHARED] Failed to import chunk ${chunk.id}: ${err}`);
    }
  }

  console.log(`[SHARED] Imported ${imported} shared insights for ${agent}`);
  return imported;
}

/** List all shared insights (for inspection) */
export function listShared(limit = 20): SharedChunk[] {
  const db = getSharedDb();
  return db.prepare(
    "SELECT * FROM shared_chunks ORDER BY shared_at DESC LIMIT ?"
  ).all(limit) as SharedChunk[];
}

/** Get stats on the shared memory pool */
export function sharedStats(): { total: number; byAgent: Array<{ agent: string; count: number }> } {
  const db = getSharedDb();
  const total = (db.prepare("SELECT COUNT(*) as c FROM shared_chunks").get() as { c: number }).c;
  const byAgent = db.prepare(
    "SELECT source_agent as agent, COUNT(*) as count FROM shared_chunks GROUP BY source_agent ORDER BY count DESC"
  ).all() as Array<{ agent: string; count: number }>;
  return { total, byAgent };
}
