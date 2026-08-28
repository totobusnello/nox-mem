import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
// @ts-ignore - sqlite-vec ships no type declarations for this helper
import { getLoadablePath as vecLoadablePath } from "sqlite-vec";

const __dirname = dirname(fileURLToPath(import.meta.url));
const _ws = process.env.OPENCLAW_WORKSPACE;

// DB path resolution — priority order (postmortem 2026-05-19 fix):
//   1. NOX_DB_PATH env var (explicit override for eval/test isolation)
//   2. OPENCLAW_WORKSPACE-derived canonical path (production default)
//   3. Relative fallback for local dev
//
// WARNING: Before this fix, only OPENCLAW_WORKSPACE was consulted.  Any caller
// that set NOX_DB_PATH (e.g. G3 eval orchestrator, run_locomo_ablations.sh)
// was silently ignored — `nox-mem ingest` always wrote to the production DB.
// Root cause of the 2026-05-19 wipe incident (500 eval chunks → prod).
export const DB_PATH = (
  process.env.NOX_DB_PATH
    ? resolve(process.env.NOX_DB_PATH)
    : _ws
      ? resolve(_ws, "tools", "nox-mem", "nox-mem.db")
      : resolve(__dirname, "..", "nox-mem.db")
);
export const BACKUP_DIR = _ws ? resolve(_ws, "tools", "nox-mem", "backups") : resolve(__dirname, "..", "backups");
const SCHEMA_VERSION = 19;

// ────────────────────────────────────────────────────────────────────────────
// Large-DB ingest guard (postmortem 2026-05-19)
// ────────────────────────────────────────────────────────────────────────────
// If the resolved DB has more than PROD_CHUNK_THRESHOLD chunks and the caller
// has not set NOX_ALLOW_PROD_INGEST=1, abort before any write.  This prevents
// eval/test ingests from silently polluting a large production DB.
//
// Threshold: 10,000 chunks. Production is at 68k+; eval DBs start fresh.
// Override: NOX_ALLOW_PROD_INGEST=1  (explicit, auditable, required for prod ops)
const PROD_CHUNK_THRESHOLD = 10_000;

export function checkLargeDbIngestGuard(db: Database.Database, operation: string): void {
  if (process.env.NOX_ALLOW_PROD_INGEST === "1") return;

  const row = db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number } | undefined;
  const chunkCount = row?.n ?? 0;

  if (chunkCount > PROD_CHUNK_THRESHOLD) {
    const msg = [
      `[db] ABORT: Large-DB ingest guard triggered on operation '${operation}'.`,
      `  DB path:     ${DB_PATH}`,
      `  Chunk count: ${chunkCount} (threshold: ${PROD_CHUNK_THRESHOLD})`,
      `  This DB appears to be the production nox-mem.db.`,
      `  If you intend to ingest into production, set:`,
      `    NOX_ALLOW_PROD_INGEST=1 nox-mem ${operation} ...`,
      `  If you are running an eval/ablation, ensure NOX_DB_PATH points to an`,
      `  isolated eval DB (e.g. /tmp/entity-eval.db), NOT the production path.`,
      `  (Root cause of the 2026-05-19 wipe incident — see docs/INCIDENTS.md)`,
    ].join("\n");
    console.error(msg);
    process.exit(1);
  }
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db && _db.open) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  // Wait up to 5s on lock contention instead of failing immediately with SQLITE_BUSY.
  // Needed because watcher ingest + api writes + crystallize/reflect share the same DB
  // in WAL mode — writers still serialize, and default busy_timeout=0 causes silent failures.
  _db.pragma("busy_timeout = 5000");
  // Performance: Large cache for 51MB DB + 1,780 chunks
  _db.pragma("cache_size = -64000");     // 64MB cache (was 2MB default)
  _db.pragma("mmap_size = 268435456");   // 256MB memory-mapped I/O (was 0/disabled)
  _db.pragma("synchronous = NORMAL");    // Faster writes (WAL ensures safety)

  // Load sqlite-vec extension (required for vec_chunks triggers on chunks table).
  // Without this, trg_chunks_delete_cascade aborts with "no such module: vec0"
  // when CLI runs DELETE/INSERT on chunks. Source fix migrated 2026-05-30 from
  // tactical dist/db.js patch; persists across npm build.
  try {
    // Resolve the vec0 extension for the CURRENT platform via sqlite-vec's own
    // resolver (it reads the matching sqlite-vec-<os>-<arch> optional dependency).
    // The previous hardcoded "sqlite-vec-linux-x64" path broke every non-Linux-x64
    // install (macOS, ARM, Windows) — semantic search silently fell back to BM25.
    let vec0Path: string;
    try { vec0Path = vecLoadablePath(); }
    catch { vec0Path = resolve(__dirname, "..", "node_modules", "sqlite-vec-linux-x64", "vec0"); }
    _db.loadExtension(vec0Path);
  } catch (err) {
    console.error("[db] sqlite-vec load failed (vec_chunks triggers may fail):", (err as Error).message);
  }
  ensureSchema(_db);
  return _db;
}

export function closeDb(): void {
  if (_db && _db.open) {
    _db.close();
    _db = null;
  }
}

/**
 * Backup SQLite using the online backup API (safe even during writes).
 * Retains up to `keepDays` daily backups.
 */
export function backupDb(keepDays = 7): string {
  if (!existsSync(DB_PATH)) return "";
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

  const today = new Date().toISOString().split("T")[0];
  const destPath = resolve(BACKUP_DIR, `nox-mem-${today}.db`);

  // Use SQLite backup API via better-sqlite3
  const src = new Database(DB_PATH, { readonly: true });
  src.backup(destPath).then(() => {
    src.close();
    console.log(`[BACKUP] Saved to ${destPath}`);
    // Prune old backups
    pruneBackups(keepDays);
  }).catch((err: Error) => {
    src.close();
    // Fallback to file copy if backup API fails
    try {
      copyFileSync(DB_PATH, destPath);
      console.log(`[BACKUP] Copied (fallback) to ${destPath}`);
      pruneBackups(keepDays);
    } catch {
      console.error(`[BACKUP] Failed: ${err.message}`);
    }
  });

  return destPath;
}

function pruneBackups(keepDays: number): void {
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.match(/^nox-mem-\d{4}-\d{2}-\d{2}\.db$/))
      .sort()
      .reverse();
    for (const f of files.slice(keepDays)) {
      unlinkSync(resolve(BACKUP_DIR, f));
      console.log(`[BACKUP] Pruned old backup: ${f}`);
    }
  } catch { /* non-critical */ }
}

function ensureSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );`);

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(`DB schema ${currentVersion} > expected ${SCHEMA_VERSION}`);
  }

  // Always re-align PRAGMA user_version with the canonical schema version, even
  // when migrations are already applied (meta.schema_version is the source of
  // truth). Covers the recovery scenario where user_version was manually reset
  // to 0 (legacy/partial-restore DBs) while the meta row is current — re-open
  // must re-bump the PRAGMA without reprocessing migrations. Idempotent.
  db.pragma(`user_version = ${SCHEMA_VERSION}`);

  if (currentVersion === SCHEMA_VERSION) return;

  if (currentVersion < 1) migrateToV1(db);
  if (currentVersion < 2) migrateToV2(db);
  if (currentVersion < 3) migrateToV3(db);
  if (currentVersion < 4) migrateToV4(db);
  if (currentVersion < 5) migrateToV5(db);
  if (currentVersion < 6) migrateToV6(db);
  if (currentVersion < 7) migrateToV7(db);
  if (currentVersion < 18) migrateToV8(db);
  if (currentVersion < 19) migrateToV9(db);

  db.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('schema_version', ?, datetime('now'))").run(String(SCHEMA_VERSION));
  // Keep PRAGMA user_version in sync so op-audit and tests can rely on it.
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function migrateToV9(db: Database.Database): void {
  // v19 — per-chunk search telemetry.
  //
  // The v6 telemetry row records the SHAPE of a search (how many results, how
  // fast, whether semantic fired) but not WHICH chunks came back. That is
  // enough to answer "is search healthy?" and not enough to answer "what has
  // this memory ever actually served?" — a question about the retrieval
  // surface, which is what an agent's context is really made of.
  //
  // ⚠️ PRIVACY BOUNDARY, deliberate and load-bearing: this adds the chunk IDs
  // and their scores. It does NOT add the raw query text. `query_hash` stays
  // the only representation of the query (see the v6 comment below), and the
  // test `telemetry-per-chunk.test.ts` reads the INSERT statement out of
  // search.ts and fails if `query_text` ever appears in it. IDs are internal
  // rowids of content the operator already owns; the query string is the one
  // field that can carry a third party's words.
  //
  // Per-column try/catch keeps this idempotent on DBs patched out of band.
  try { db.exec(`ALTER TABLE search_telemetry ADD COLUMN top_chunk_ids TEXT`); } catch {}
  try { db.exec(`ALTER TABLE search_telemetry ADD COLUMN top_scores TEXT`); } catch {}
}

function migrateToV8(db: Database.Database): void {
  // Standalone consolidation of the column additions that the canonical engine
  // introduced across schema v8–v18 (typed retention, pain-weighting, entity
  // sections). The ingest path (ingest.ts / ingest-entity.ts) writes these
  // columns, but the v1–v7 migrations shipped in this repo never create them —
  // so a clean install crashed on the first `ingest` with
  // "table chunks has no column named retention_days".
  // Per-column try/catch keeps this idempotent on DBs already patched at any version.
  try { db.exec(`ALTER TABLE chunks ADD COLUMN retention_days INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE chunks ADD COLUMN pain REAL DEFAULT 0.2`); } catch {}
  try { db.exec(`ALTER TABLE chunks ADD COLUMN section TEXT`); } catch {}
  try { db.exec(`ALTER TABLE chunks ADD COLUMN section_boost REAL`); } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_section ON chunks(section);`);

  // Knowledge-graph schema. ensureGraphTables() (knowledge-graph.ts) creates
  // these lazily on the first KG operation, but a clean install that calls
  // impact.ts / lib/spo-injection.ts / kg-* before any KG write would hit
  // "no such table: kg_relations". Materialize the canonical KG schema here so
  // getDb() always provides it. Definitions mirror ensureGraphTables();
  // relation_reason (E05 edge typing) defaults to 'unknown'.
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      attributes TEXT,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now')),
      mention_count INTEGER DEFAULT 1,
      UNIQUE(name, entity_type)
    );
    CREATE TABLE IF NOT EXISTS kg_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_entity_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      target_entity_id INTEGER NOT NULL,
      evidence_chunk_id INTEGER,
      confidence REAL DEFAULT 0.8,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT DEFAULT (datetime('now', '+90 days')),
      last_confirmed TEXT DEFAULT (datetime('now')),
      relation_reason TEXT DEFAULT 'unknown',
      FOREIGN KEY (source_entity_id) REFERENCES kg_entities(id),
      FOREIGN KEY (target_entity_id) REFERENCES kg_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(name);
    CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(entity_type);
    CREATE INDEX IF NOT EXISTS idx_kg_relations_source ON kg_relations(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_kg_relations_target ON kg_relations(target_entity_id);
    CREATE INDEX IF NOT EXISTS idx_kg_relations_expires ON kg_relations(expires_at);
    CREATE INDEX IF NOT EXISTS idx_kg_relations_reason ON kg_relations(relation_reason);
  `);
  // Idempotent column add for pre-existing KG tables (created before E05).
  try { db.exec(`ALTER TABLE kg_relations ADD COLUMN relation_reason TEXT DEFAULT 'unknown'`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_kg_relations_reason ON kg_relations(relation_reason)`); } catch {}
  try { db.exec(`UPDATE kg_relations SET relation_reason = 'unknown' WHERE relation_reason IS NULL`); } catch {}
}

function migrateToV7(db: Database.Database): void {
  // Fase 1.7a — Core Memory Quality
  //   - kg_entities.attributes: JSON com campos ricos por tipo (ontology grounding)
  //   - chunks.source_type: user_statement | compiled | timeline | external
  //   - chunks.is_compiled: 1 se é síntese (consolidado), 0 se evidência bruta
  // Nullable/default para compatibilidade com registros antigos.
  try { db.exec(`ALTER TABLE kg_entities ADD COLUMN attributes TEXT`); } catch {}
  try { db.exec(`ALTER TABLE chunks ADD COLUMN source_type TEXT`); } catch {}
  try { db.exec(`ALTER TABLE chunks ADD COLUMN is_compiled INTEGER DEFAULT 0`); } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source_type ON chunks(source_type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_is_compiled ON chunks(is_compiled);`);

  // Backfill heurístico. Ordem de precedência: compiled > external > user_statement > timeline.
  // NOX_SPEAKER_FILTER: if set, also classifies chunks containing the speaker phrase
  // (e.g. "Alice disse") as user_statement. If unset, no personal text filter is applied.
  const speakerFilter = process.env.NOX_SPEAKER_FILTER
    ? `OR chunk_text LIKE '%${process.env.NOX_SPEAKER_FILTER.replace(/'/g, "''")}%'`
    : "";
  db.exec(`
    UPDATE chunks SET is_compiled=1, source_type='compiled'
      WHERE is_consolidated=1 AND source_type IS NULL;
    UPDATE chunks SET source_type='external'
      WHERE source_type IS NULL AND (
        source_file LIKE '%boris%' OR
        source_file LIKE '%atlas/research%' OR
        source_file LIKE '%news%' OR
        source_file LIKE '%noticias%'
      );
    UPDATE chunks SET source_type='user_statement'
      WHERE source_type IS NULL AND (
        source_file LIKE '%whatsapp%' OR
        source_file LIKE '%telegram%'
        ${speakerFilter}
      );
    UPDATE chunks SET source_type='timeline'
      WHERE source_type IS NULL;
  `);
}

function migrateToV6(db: Database.Database): void {
  // Fase 1.6 — search telemetry + expansion toggle.
  // query_hash is sha1 hex prefix, não armazenamos texto cru da query por privacidade.
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      query_hash TEXT NOT NULL,
      query_words INTEGER NOT NULL,
      variants_count INTEGER NOT NULL DEFAULT 1,
      results_count INTEGER NOT NULL DEFAULT 0,
      has_semantic INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      expansion_skipped_reason TEXT,
      -- v19 (ver migrateToV9): quais chunks a busca devolveu, e com que score.
      -- JSON array, ou NULL quando nenhum resultado trouxe id.
      top_chunk_ids TEXT,
      top_scores TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_search_telemetry_ts ON search_telemetry(ts DESC);
  `);
  // Seed default config (toggle off sem deploy: UPDATE meta SET value='false' WHERE key='expansion_enabled')
  db.prepare("INSERT OR IGNORE INTO meta (key, value, updated_at) VALUES ('expansion_enabled', 'true', datetime('now'))").run();
}

function migrateToV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      chunk_type TEXT NOT NULL,
      source_date TEXT,
      is_consolidated INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      metadata TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_text, source_file, chunk_type,
      content=chunks, content_rowid=id,
      tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, chunk_text, source_file, chunk_type)
      VALUES (new.id, new.chunk_text, new.source_file, new.chunk_type);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text, source_file, chunk_type)
      VALUES ('delete', old.id, old.chunk_text, old.source_file, old.chunk_type);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text, source_file, chunk_type)
      VALUES ('delete', old.id, old.chunk_text, old.source_file, old.chunk_type);
      INSERT INTO chunks_fts(rowid, chunk_text, source_file, chunk_type)
      VALUES (new.id, new.chunk_text, new.source_file, new.chunk_type);
    END;
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_file);
    CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(chunk_type);
    CREATE INDEX IF NOT EXISTS idx_chunks_date ON chunks(source_date);
  `);
}

function migrateToV2(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consolidated_files (
      source_file TEXT PRIMARY KEY,
      status INTEGER NOT NULL DEFAULT 1,
      processed_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.exec(`
    INSERT OR IGNORE INTO consolidated_files (source_file, status, processed_at)
    SELECT DISTINCT source_file, 1, datetime('now')
    FROM chunks WHERE is_consolidated = 1;
  `);
  db.exec(`DROP INDEX IF EXISTS idx_chunks_consolidated;`);
  // Drop UPDATE trigger (caused FTS5 write amplification in v2)
  db.exec(`DROP TRIGGER IF EXISTS chunks_au;`);
}

function migrateToV4(db: Database.Database): void {
  // Sprint A: Tier system (core/working/peripheral)
  const cols = db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has("tier")) {
    db.exec(`ALTER TABLE chunks ADD COLUMN tier TEXT DEFAULT 'peripheral';`);
  }
  if (!colNames.has("access_count")) {
    db.exec(`ALTER TABLE chunks ADD COLUMN access_count INTEGER DEFAULT 0;`);
  }
  if (!colNames.has("last_accessed_at")) {
    db.exec(`ALTER TABLE chunks ADD COLUMN last_accessed_at TEXT;`);
  }
  if (!colNames.has("importance")) {
    db.exec(`ALTER TABLE chunks ADD COLUMN importance REAL DEFAULT 0.5;`);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_tier ON chunks(tier);`);

  // Add noise_filtered column to daily_metrics (if table exists)
  try {
    const metricCols = db.prepare("PRAGMA table_info(daily_metrics)").all() as Array<{ name: string }>;
    const metricColNames = new Set(metricCols.map((c) => c.name));
    if (metricCols.length > 0 && !metricColNames.has("noise_filtered")) {
      db.exec(`ALTER TABLE daily_metrics ADD COLUMN noise_filtered INTEGER DEFAULT 0;`);
    }
  } catch { /* daily_metrics may not exist yet */ }

  // Seed tiers based on existing chunk types
  db.prepare(`
    UPDATE chunks SET tier = 'working', importance = 0.8, updated_at = datetime('now')
    WHERE chunk_type IN ('decision', 'lesson', 'person', 'project')
      AND (tier IS NULL OR tier = 'peripheral')
  `).run();
}

function migrateToV5(db: Database.Database): void {
  // Sprint D: Fix FTS tokenizer — replace Porter (EN stemmer) with unicode61 remove_diacritics=2
  // Porter was incorrectly stemming PT-BR words (e.g. configuracoes ≠ configuracao).
  // unicode61 with remove_diacritics=2 normalizes accents without language-specific stemming,
  // so "decisao" == "decisão", "configuracao" == "configuração", etc.
  //
  // Procedure for content= FTS5 table rebuild:
  //   1. Drop old virtual table + triggers
  //   2. Create new virtual table with updated tokenizer
  //   3. Recreate triggers
  //   4. Rebuild index from chunks table
  db.exec(`
    DROP TRIGGER IF EXISTS chunks_ai;
    DROP TRIGGER IF EXISTS chunks_ad;
    DROP TRIGGER IF EXISTS chunks_au;
    DROP TABLE IF EXISTS chunks_fts;
  `);

  db.exec(`
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      chunk_text, source_file, chunk_type,
      content=chunks, content_rowid=id,
      tokenize='unicode61 remove_diacritics 2'
    );
  `);

  // Rebuild from chunks table
  db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');`);

  // Recreate triggers
  db.exec(`
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, chunk_text, source_file, chunk_type)
      VALUES (new.id, new.chunk_text, new.source_file, new.chunk_type);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text, source_file, chunk_type)
      VALUES ('delete', old.id, old.chunk_text, old.source_file, old.chunk_type);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text, source_file, chunk_type)
      VALUES ('delete', old.id, old.chunk_text, old.source_file, old.chunk_type);
      INSERT INTO chunks_fts(rowid, chunk_text, source_file, chunk_type)
      VALUES (new.id, new.chunk_text, new.source_file, new.chunk_type);
    END;
  `);

  console.log("[MIGRATE V5] FTS tokenizer updated: porter unicode61 → unicode61 remove_diacritics=2");
}

function migrateToV3(db: Database.Database): void {
  // P2 Fix: Restore UPDATE trigger (correctly, without write amplification)
  // The v2 trigger was buggy because it reinserted without deleting first on content= tables.
  // Correct pattern for content= FTS5: delete old, insert new.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text, source_file, chunk_type)
      VALUES ('delete', old.id, old.chunk_text, old.source_file, old.chunk_type);
      INSERT INTO chunks_fts(rowid, chunk_text, source_file, chunk_type)
      VALUES (new.id, new.chunk_text, new.source_file, new.chunk_type);
    END;
  `);

  // P5: Add dedup_log table for tracking suppressed duplicates
  db.exec(`
    CREATE TABLE IF NOT EXISTS dedup_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_text_preview TEXT NOT NULL,
      source_file TEXT NOT NULL,
      chunk_type TEXT NOT NULL,
      suppressed_at TEXT DEFAULT (datetime('now')),
      reason TEXT
    );
  `);

  // Add memory_type column to chunks for typed retrieval (Sprint 2)
  db.exec(`
    ALTER TABLE chunks ADD COLUMN memory_type TEXT;
  `);
}
