import { existsSync, readFileSync } from "fs";
import { relative, resolve } from "path";
import Database from "better-sqlite3";
import { getDb } from "./db.js";
import { syncFileChunks, type DesiredChunk } from "./lib/chunk-sync.js";
import { getInitialTier, getInitialImportance } from "./tier-manager.js";
import { resolveRetention } from "./retention.js";
import { inferPain, inferImportance } from "./salience.js";
import { redact } from "./privacy/filter.js";

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || "/root/.openclaw/workspace";

const TYPE_MAP: Record<string, string> = {
  "memory/decisions.md": "decision",
  "memory/lessons.md": "lesson",
  "memory/people.md": "person",
  "memory/projects.md": "project",
  "memory/pending.md": "pending",
};

export function detectChunkType(relPath: string): string {
  if (TYPE_MAP[relPath]) return TYPE_MAP[relPath];
  if (relPath.startsWith("shared/")) return "team";
  if (relPath.match(/memory\/entities\/decisions\//)) return "decision";
  if (relPath.match(/memory\/entities\/lessons\//)) return "lesson";
  if (relPath.match(/memory\/entities\/projects\//)) return "project";
  if (relPath.match(/memory\/entities\/persons?\//)) return "person";
  if (relPath.match(/memory\/entities\/agents\//)) return "team";
  if (relPath.match(/memory\/feedback\//)) return "feedback";
  if (relPath.match(/memory\/digests\//)) return "digest";
  if (relPath.match(/memory\/\d{4}-\d{2}-\d{2}/)) return "daily";
  return "other";
}

export function extractDate(relPath: string): string | null {
  const match = relPath.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export function chunkMarkdown(content: string): string[] {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.match(/^#{2,3}\s/) && current.length > 0) {
      const text = current.join("\n").trim();
      if (text) chunks.push(text);
      current = [line];
    } else {
      current.push(line);
    }
  }
  const last = current.join("\n").trim();
  if (last) chunks.push(last);

  const result: string[] = [];
  for (const chunk of chunks) {
    const wordCount = chunk.split(/\s+/).length;
    if (wordCount > 500) {
      const subChunks = chunk.split(/\n\n+/).filter((s) => s.trim());
      let buffer = "";
      for (const sub of subChunks) {
        if (buffer && (buffer + "\n\n" + sub).split(/\s+/).length > 500) {
          result.push(buffer.trim());
          buffer = sub;
        } else {
          buffer = buffer ? buffer + "\n\n" + sub : sub;
        }
      }
      if (buffer.trim()) result.push(buffer.trim());
    } else if (wordCount < 20 && result.length > 0) {
      result[result.length - 1] += "\n\n" + chunk;
    } else {
      result.push(chunk);
    }
  }
  return result.filter((c) => c.trim().length > 0);
}

export function chunkJson(content: string): string[] {
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) return data.map((item) => JSON.stringify(item, null, 2));
    const chunks: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        for (const item of value as unknown[]) chunks.push(`${key}: ${JSON.stringify(item)}`);
      } else {
        chunks.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    return chunks.length > 0 ? chunks : [content];
  } catch {
    return [content];
  }
}

/**
 * Sanitize UTF-8 text — replace broken sequences with correct characters
 */
function sanitizeUtf8(text: string): string {
  // Fix common mojibake patterns (UTF-8 read as Latin-1)
  return text
    .replace(/\u00c3\u00a3/g, "ã")
    .replace(/\u00c3\u00a7/g, "ç")
    .replace(/\u00c3\u00a9/g, "é")
    .replace(/\u00c3\u00a1/g, "á")
    .replace(/\u00c3\u00b5/g, "õ")
    .replace(/\u00c3\u00ad/g, "í")
    .replace(/\u00c3\u00ba/g, "ú")
    .replace(/\u00c3\u00b3/g, "ó")
    .replace(/\u00c3\u00aa/g, "ê")
    .replace(/\u00c3\u00a2/g, "â");
}

export interface IngestFileResult {
  chunks: number;
  /** ids of rows created by this ingest (the ones that still need a vector) */
  inserted: number[];
  kept: number;
  deleted: number;
  adopted: number;
}

const EMPTY: IngestFileResult = { chunks: 0, inserted: [], kept: 0, deleted: 0, adopted: 0 };

/**
 * Synchronous core: read, redact, chunk, and diff into the DB (chunk-sync.ts).
 * No await inside, so a caller can run many files in one transaction (reindex).
 * An empty file changes nothing — it is not read as "delete every chunk".
 */
export function ingestMarkdownSync(db: Database.Database, filePath: string): IngestFileResult {
  const relPath = relative(WORKSPACE, filePath);
  // A2 (2026-04-25): entity routing lives in lib/ingest-router.ts — single dispatch.
  let content = readFileSync(filePath, "utf-8");
  if (!content.trim()) return EMPTY;

  // Sanitize UTF-8
  content = sanitizeUtf8(content);

  // Privacy filter: redact secrets/PII before storage (staged-privacy)
  const _r = redact(content);
  content = _r.text;
  if (_r.redactionCount > 0) {
    console.warn(`[privacy-filter] redacted ${_r.redactionCount} secret(s) in ${relPath} — kinds: ${_r.kinds.join(", ")}`);
  }

  const chunkType = detectChunkType(relPath);
  // For named files without a date in the path (decisions.md, lessons.md, etc.),
  // use today's date so stats queries don't exclude them as "undated"
  const rawDate = extractDate(relPath);
  const sourceDate = rawDate ?? (["decision", "lesson", "team", "project", "person", "pending"].includes(chunkType)
    ? new Date().toISOString().slice(0, 10)
    : null);
  const isJson = filePath.endsWith(".json");
  const textChunks = isJson ? chunkJson(content) : chunkMarkdown(content);

  const tier = getInitialTier(chunkType);
  // Fase 1.7b-b — use smarter importance heuristic (falls back to initial if type unknown).
  // source_type is not known at ingest time for markdown (set post-ingest via migration);
  // pass undefined so inferImportance uses chunk_type-only path.
  const baseImportance = inferImportance(chunkType) ?? getInitialImportance(chunkType);
  // Fase 1.7b-a — retention resolved once per file; per-chunk override via HTML
  // comment applies to the whole file (not per-chunk, to keep semantics simple).
  const retentionDays = resolveRetention(chunkType, content);

  const desired: DesiredChunk[] = textChunks.map((text) => ({
    chunk_text: text,
    section: null,
    chunk_type: chunkType,
    source_date: sourceDate,
    metadata: null,
    tier,
    importance: baseImportance,
    retention_days: retentionDays,
    // Fase 1.7b-b — pain is per-chunk (text-driven); importance is per-file (type-driven).
    pain: inferPain(chunkType, text),
    section_boost: null,
  }));
  const r = syncFileChunks(db, relPath, desired, { existsOnDisk: (p) => existsSync(resolve(WORKSPACE, p)) });
  return { chunks: textChunks.length, inserted: r.inserted, kept: r.kept, deleted: r.deleted, adopted: r.adopted };
}

/** Max chunks embedded inline per ingest; the 4-hourly `vectorize` catches up the rest. */
const INLINE_EMBED_CAP = 20;

/**
 * Embed the rows an ingest just created. Kept rows already have their vector —
 * re-embedding unchanged text is what the NOOP exists to avoid.
 */
export async function embedInserted(db: Database.Database, ids: number[]): Promise<number> {
  if (ids.length === 0 || !process.env.GEMINI_API_KEY) return 0;
  let embedded = 0;
  try {
    const { embedDocument, ensureVecTable, upsertEmbedding } = await import("./embed.js");
    ensureVecTable(db);
    const get = db.prepare("SELECT chunk_text FROM chunks WHERE id = ?");
    for (const id of ids.slice(0, INLINE_EMBED_CAP)) {
      const row = get.get(id) as { chunk_text: string } | undefined;
      if (!row) continue;
      try {
        const emb = await embedDocument(row.chunk_text);
        if (emb && emb.length > 0) {
          upsertEmbedding(db, id, emb);
          embedded++;
        }
      } catch { break; } // Stop on first API error (rate limit)
    }
  } catch {}
  return embedded;
}

/**
 * @param filePath — absolute path to .md or .json file
 * @param externalDb — optional db connection; reindex passes one and vectorizes in batch afterwards
 *
 * Never closes the connection. It used to `db.close()` the getDb() singleton,
 * which pulled the handle out from under any caller holding it (withOpAudit,
 * the API and MCP servers): an op wrapping ingest ended `failed` with its work
 * done (HANDOFF 2026-10-14). Closing is the CLI entry point's job (closeDb()).
 */
export async function ingestFile(filePath: string, externalDb?: Database.Database): Promise<IngestFileResult> {
  const db = externalDb || getDb();
  const result = ingestMarkdownSync(db, filePath);

  // Auto-vectorize direct ingests only. Reindex passes externalDb and is followed
  // by a batch vectorize phase; embedding per file there is too expensive.
  if (!externalDb) {
    const embedded = await embedInserted(db, result.inserted);
    if (embedded > 0) console.log("[INGEST] Auto-vectorized " + embedded + " chunks");
  }
  return result;
}
