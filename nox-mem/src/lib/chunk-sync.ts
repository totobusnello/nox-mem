// chunk-sync.ts — write path without loss (ROADMAP v6 item 3, 2026-10-14).
//
// Before this module every ingest did `DELETE FROM chunks WHERE source_file = ?`
// and re-inserted the whole file. Re-saving a file with one word changed gave
// EVERY chunk of it a new id, which broke whatever pointed at the old ids
// (brief_log, search_telemetry.top_chunk_ids, kg_relations.evidence_chunk_id)
// and threw away embeddings that had already been paid for.
//
// syncFileChunks() diffs instead. The key is (section, chunk_text):
//   - a chunk whose key is already stored for the file KEEPS its row: same id,
//     same vector, same access history (tier, access_count, importance);
//   - a new key is INSERTed;
//   - a stored key the file no longer produces is DELETEd (the text was edited
//     away; that is the file's own content changing, not a loss);
//   - when the file has no rows yet, rows of a TOMBSTONED file with the same key
//     are ADOPTED (re-pointed to the new path) — that is how a rename keeps ids.
//
// Matching is a multiset: a file that legitimately repeats a paragraph keeps
// one row per occurrence. When the DB holds MORE copies than the file (the
// pre-2026-09-28 reindex doubled content), the copy holding an embedding is the
// one kept, then the lowest id.
//
// No ranking/scoring change lives here (CLAUDE.md rule 5).

import Database from "better-sqlite3";
import { ensureTombstoneTable, resolveTombstoneOnIngest } from "./tombstone.js";

/** One chunk as the file produces it now. */
export interface DesiredChunk {
  chunk_text: string;
  section: string | null;
  chunk_type: string;
  source_date: string | null;
  metadata: string | null;
  tier: string;
  importance: number;
  retention_days: number | null;
  pain: number;
  section_boost: number | null;
}

export interface SyncResult {
  /** row id for each desired chunk, in the order given */
  ids: number[];
  kept: number;
  inserted: number[];
  deleted: number;
  adopted: number;
}

interface StoredRow {
  id: number;
  chunk_text: string;
  section: string | null;
  retention_days: number | null;
  source_file: string;
}

const keyOf = (section: string | null, text: string): string => `${section ?? ""}\u0000${text}`;

function embeddedAmong(db: Database.Database, ids: number[]): Set<number> {
  if (ids.length === 0) return new Set();
  try {
    const out = new Set<number>();
    // chunk the IN list: SQLite's default variable limit is 32766, files are far smaller
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const rows = db
        .prepare(`SELECT chunk_id FROM vec_chunk_map WHERE chunk_id IN (${part.map(() => "?").join(",")})`)
        .all(...part) as Array<{ chunk_id: number }>;
      for (const r of rows) out.add(r.chunk_id);
    }
    return out;
  } catch {
    return new Set(); // no vector map yet (fresh / keyless install)
  }
}

/** key → rows, best candidate first (embedded, then lowest id). */
function bucket(rows: StoredRow[], embedded: Set<number>): Map<string, StoredRow[]> {
  const m = new Map<string, StoredRow[]>();
  for (const r of rows) {
    const k = keyOf(r.section, r.chunk_text);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  for (const list of m.values()) {
    list.sort((a, b) => {
      const ae = embedded.has(a.id), be = embedded.has(b.id);
      if (ae !== be) return ae ? -1 : 1;
      return a.id - b.id;
    });
  }
  return m;
}

/**
 * Make the stored chunks of `relPath` equal to `desired`, touching only what
 * changed. Runs in one transaction (a savepoint when the caller already holds one).
 */
export function syncFileChunks(db: Database.Database, relPath: string, desired: DesiredChunk[]): SyncResult {
  ensureTombstoneTable(db);

  const run = db.transaction((): SyncResult => {
    const stored = db
      .prepare("SELECT id, chunk_text, section, retention_days, source_file FROM chunks WHERE source_file = ?")
      .all(relPath) as StoredRow[];
    const own = bucket(stored, embeddedAmong(db, stored.map((r) => r.id)));

    // Rename: only a path with no rows can adopt, and only from tombstoned files
    // (never from a file that is merely absent from disk — D-2026-09-30 keeps
    // some of those on purpose, and an adopted row would later be edited away).
    let foreign = new Map<string, StoredRow[]>();
    if (stored.length === 0 && desired.length > 0) {
      const candidates = db
        .prepare(
          `SELECT c.id, c.chunk_text, c.section, c.retention_days, c.source_file
             FROM chunks c JOIN chunk_tombstones t ON t.source_file = c.source_file
            WHERE t.kept_at IS NULL AND c.source_file != ?`,
        )
        .all(relPath) as StoredRow[];
      if (candidates.length > 0) foreign = bucket(candidates, embeddedAmong(db, candidates.map((r) => r.id)));
    }

    const insert = db.prepare(
      `INSERT INTO chunks (source_file, chunk_text, chunk_type, source_date, metadata, tier, importance, retention_days, pain, section, section_boost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const setRetention = db.prepare("UPDATE chunks SET retention_days = ? WHERE id = ?");
    const adopt = db.prepare("UPDATE chunks SET source_file = ?, retention_days = ? WHERE id = ?");
    const del = db.prepare("DELETE FROM chunks WHERE id = ?");

    const ids: number[] = [];
    const inserted: number[] = [];
    let kept = 0;
    let adopted = 0;
    const adoptedFrom = new Set<string>();

    for (const d of desired) {
      const k = keyOf(d.section, d.chunk_text);
      const mine = own.get(k);
      if (mine && mine.length > 0) {
        const row = mine.shift()!;
        // retention is resolved per file from its content (an HTML-comment
        // override can change without the chunk changing); everything else on a
        // kept row is history worth keeping.
        if (row.retention_days !== d.retention_days) setRetention.run(d.retention_days, row.id);
        ids.push(row.id);
        kept++;
        continue;
      }
      const theirs = foreign.get(k);
      if (theirs && theirs.length > 0) {
        const row = theirs.shift()!;
        adopt.run(relPath, d.retention_days, row.id);
        adoptedFrom.add(row.source_file);
        ids.push(row.id);
        adopted++;
        continue;
      }
      const info = insert.run(
        relPath, d.chunk_text, d.chunk_type, d.source_date, d.metadata, d.tier,
        d.importance, d.retention_days, d.pain, d.section, d.section_boost,
      );
      const id = Number(info.lastInsertRowid);
      ids.push(id);
      inserted.push(id);
    }

    let deleted = 0;
    for (const rest of own.values()) for (const r of rest) deleted += del.run(r.id).changes;

    resolveTombstoneOnIngest(db, relPath, [...adoptedFrom]);
    return { ids, kept, inserted, deleted, adopted };
  });

  return run();
}
