/**
 * embed.ts - Semantic embedding via Gemini API (gemini-embedding-001, 768-dim)
 * Uses the same API key already configured in the OpenClaw gateway.
 * Zero local model weight, zero sqlite-vec binding issues.
 *
 * Provider routing (added 2026-06-15):
 * When NOX_EMBEDDING_PROVIDER / NOX_EMBED_PROVIDER is set to anything other
 * than "gemini" (the default), embedding calls are delegated to the abstract
 * EmbeddingProvider from src/providers/. The native Gemini path (taskType-aware
 * RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY) is preserved 100% when using gemini.
 */

import Database from "better-sqlite3";
import * as path from "path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { selectEmbeddingProvider, type EmbeddingProvider } from "./providers/index.js";
// @ts-ignore
import { load as loadVec, getLoadablePath as vecLoadablePath } from "sqlite-vec";

// Resolve the vec0 extension for the CURRENT platform. The previous hardcoded
// "sqlite-vec-linux-x64" path only worked on Linux x64; sqlite-vec's own
// resolver picks the right sqlite-vec-<os>-<arch> optional dependency.
const VEC0_PATH = (() => {
  try { return vecLoadablePath(); } catch { /* fall back to legacy path below */ }
  return path.join(
    import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)),
    "../node_modules/sqlite-vec-linux-x64/vec0"
  );
})();

// Wrapper para garantir que vec0 carrega corretamente
function loadVecSafe(db: Database.Database): void {
  try {
    // Tentar primeiro com full path
    db.loadExtension(VEC0_PATH);
  } catch (err1) {
    try {
      // Fallback: tentar com nome simples
      loadVec(db);
    } catch (err2) {
      console.error("[VEC0] Failed to load:", err2);
      throw new Error(`sqlite-vec failed to load: ${err2}`);
    }
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIM = 3072; // gemini-embedding-001 actual output dimension
const BATCH_SIZE = 20; // Gemini free tier: up to 100 req/min
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// ─── Gemini Embedding API ────────────────────────────────────────────────────

// Forensic-logged fetch with exponential backoff on 429/5xx.
// 4 attempts: 1s, 2s, 4s backoff. Logs status, retry-related headers,
// and first 500 chars of body to journal so 429 spikes are diagnosable.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  maxAttempts = 4
): Promise<Response> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const resp = await fetch(url, init);
    if (resp.ok) return resp;
    // Non-retryable 4xx → return as-is so caller can surface error
    if (resp.status !== 429 && resp.status < 500) return resp;

    // 429 / 5xx — capture forensics
    const fhdrs: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      const kl = k.toLowerCase();
      if (kl.includes("retry") || kl.includes("quota") || kl.includes("rate") || kl.includes("ratelimit")) {
        fhdrs[k] = v;
      }
    });
    const bodyText = await resp.text();
    const bodyPreview = bodyText.slice(0, 500).replace(/\s+/g, " ");

    if (attempt === maxAttempts - 1) {
      console.error(`[EMBED:${label}] ${resp.status} after ${maxAttempts} attempts. headers=${JSON.stringify(fhdrs)} body=${bodyPreview}`);
      return new Response(bodyText, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
    }

    const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
    console.error(`[EMBED:${label}] ${resp.status} attempt=${attempt + 1}/${maxAttempts} headers=${JSON.stringify(fhdrs)} body=${bodyPreview} — retry in ${backoff}ms`);
    await new Promise((r) => setTimeout(r, backoff));
  }
  throw new Error(`[EMBED:${label}] retry loop exhausted`);
}

async function geminiEmbed(text: string): Promise<number[]> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const url = `${API_BASE}/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`;
  const resp = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text: text.substring(0, 2048) }] },
      taskType: "RETRIEVAL_DOCUMENT",
    }),
  }, "embedDoc");
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini embed failed: ${resp.status} ${err}`);
  }
  const data = (await resp.json()) as { embedding: { values: number[] } };
  return data.embedding.values;
}

async function geminiEmbedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const url = `${API_BASE}/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`;
  const resp = await fetchWithRetry(url, {
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text: text.substring(0, 2048) }] },
      taskType: "RETRIEVAL_QUERY",
    }),
  }, "embedQuery");
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini embed query failed: ${resp.status} ${err}`);
  }
  const data = (await resp.json()) as { embedding: { values: number[] } };
  return data.embedding.values;
}

// Rate limit helper: 100 req/min free tier → ~600ms between requests
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Provider abstraction (lazy singleton) ───────────────────────────────────

// undefined = not yet resolved; null = use native gemini path
let _embProvider: EmbeddingProvider | null | undefined;

/**
 * Returns the active non-Gemini provider, or null when the native Gemini path
 * should be used (default). Resolved once and cached for the process lifetime.
 */
function activeEmbeddingProvider(): EmbeddingProvider | null {
  if (_embProvider !== undefined) return _embProvider;
  const name = (
    process.env.NOX_EMBEDDING_PROVIDER ??
    process.env.NOX_EMBED_PROVIDER ??
    "gemini"
  ).trim();
  _embProvider = name === "gemini" ? null : selectEmbeddingProvider(name);
  return _embProvider;
}

/**
 * Returns the effective embedding dimension for the current provider.
 * Priority: provider.dimensions > NOX_EMBEDDING_DIM / NOX_EMBED_DIM env > EMBEDDING_DIM (3072).
 * Used by ensureVecTable so the vec0 column matches whatever provider is active.
 */
export function activeEmbeddingDim(): number {
  const provider = activeEmbeddingProvider();
  if (provider !== null) return provider.dimensions;
  const raw = process.env.NOX_EMBEDDING_DIM ?? process.env.NOX_EMBED_DIM;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return EMBEDDING_DIM;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function embedText(text: string, opts: { timeoutMs?: number } = {}): Promise<Float32Array> {
  const timeoutMs = opts.timeoutMs ?? 0;
  if (!(timeoutMs > 0)) return embedTextUnbounded(text);
  // A slow provider is not an error: without a budget the caller just waits
  // (retries + backoff included). The budget covers the whole call; on expiry the
  // in-flight native request is aborted and the caller gets EmbedTimeoutError.
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new EmbedTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([embedTextUnbounded(text, ctrl.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export class EmbedTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`query embedding exceeded ${timeoutMs} ms`);
    this.name = "EmbedTimeoutError";
  }
}

/**
 * Time budget for embedding a search query, in ms. NOX_QUERY_EMBED_TIMEOUT_MS
 * overrides; 0 disables the budget. Default 5000: hybrid p50 is ~1 s, so a
 * query still waiting after 5 s is better served by FTS5 than by waiting.
 */
export function queryEmbedTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NOX_QUERY_EMBED_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 5000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5000;
}

/** Test seam: replaces the provider call behind embedText (null restores it). */
let embedOverride: ((text: string, signal?: AbortSignal) => Promise<Float32Array>) | null = null;
export function __setEmbedForTests(fn: typeof embedOverride): void {
  embedOverride = fn;
}

async function embedTextUnbounded(text: string, signal?: AbortSignal): Promise<Float32Array> {
  if (embedOverride) return embedOverride(text, signal);
  // Route to abstract provider when configured; keep native Gemini path as default.
  const provider = activeEmbeddingProvider();
  if (provider !== null) {
    const vecs = await provider.embed([text]);
    return vecs[0];
  }
  const values = await geminiEmbedQuery(text, signal);
  return new Float32Array(values);
}

/**
 * True batch embedding via Gemini batchEmbedContents API.
 * Sends up to `batchSize` texts per HTTP call (default 50) — on gemini-embedding-001
 * at 3072d we've measured ~13x throughput vs the per-text loop.
 * Pauses `pauseMs` between batches to stay under 100 RPM on the free tier.
 */
export async function embedBatchAPI(
  texts: string[],
  options: { batchSize?: number; pauseMs?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<Float32Array[]> {
  // Delegate to abstract provider when configured; keep Gemini batch path as default.
  const provider = activeEmbeddingProvider();
  if (provider !== null) {
    const batchSize = Math.max(1, options.batchSize ?? 50);
    const results: Float32Array[] = new Array(texts.length);
    for (let start = 0; start < texts.length; start += batchSize) {
      const slice = texts.slice(start, start + batchSize);
      const vecs = await provider.embed(slice);
      for (let i = 0; i < slice.length; i++) {
        results[start + i] = vecs[i];
      }
      options.onProgress?.(Math.min(start + batchSize, texts.length), texts.length);
    }
    return results;
  }

  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 50, 100));
  const pauseMs = options.pauseMs ?? 1000;
  const url = `${API_BASE}/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${GEMINI_API_KEY}`;
  const results: Float32Array[] = new Array(texts.length);

  for (let start = 0; start < texts.length; start += batchSize) {
    const slice = texts.slice(start, start + batchSize);
    const payload = {
      requests: slice.map((t) => ({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text: t.substring(0, 2048) }] },
        taskType: "RETRIEVAL_DOCUMENT",
      })),
    };

    // Retry with exponential backoff on 429 (burst) and 5xx (transient).
    let resp: Response | undefined;
    let lastErr = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (resp.ok) break;
      const errBody = await resp.text();
      lastErr = `${resp.status} ${errBody.substring(0, 300)}`;
      // Don't retry on 4xx other than 429 — those are hard errors.
      if (resp.status !== 429 && resp.status < 500) {
        throw new Error(`Gemini batch embed failed: ${lastErr}`);
      }
      if (attempt < 3) {
        const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s
        console.error(`[EMBED] 429/5xx on batch (attempt ${attempt + 1}/4), retrying in ${backoff}ms`);
        await sleep(backoff);
      }
    }
    if (!resp || !resp.ok) {
      throw new Error(`Gemini batch embed failed after 4 retries: ${lastErr}`);
    }
    const data = (await resp.json()) as { embeddings: Array<{ values: number[] }> };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== slice.length) {
      throw new Error(`Gemini batch returned ${data.embeddings?.length ?? 0} embeddings for ${slice.length} inputs`);
    }
    for (let i = 0; i < slice.length; i++) {
      results[start + i] = new Float32Array(data.embeddings[i].values);
    }

    options.onProgress?.(Math.min(start + batchSize, texts.length), texts.length);

    // Rate limit: pause between batches (skip on final batch)
    if (start + batchSize < texts.length && pauseMs > 0) await sleep(pauseMs);
  }
  return results;
}

/**
 * Legacy serial embedBatch kept for callers that still use it; now delegates
 * to the batch API with batchSize=1 preserved only to keep error-per-item
 * semantics where they exist. Prefer embedBatchAPI for new code.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  return embedBatchAPI(texts, { batchSize: 50, pauseMs: 1000 });
}

// ─── SQLite-vec helpers ───────────────────────────────────────────────────────

/**
 * sqlite-vec v0.1.x compatibility note:
 * - Does NOT support named INTEGER PRIMARY KEY columns
 * - DOES support rowid-based inserts
 * - We use a companion table (vec_chunk_map) to map rowid → chunk_id
 * - Schema: vec_chunks has only `embedding` column, rowid = auto
 *           vec_chunk_map(vec_rowid, chunk_id) tracks the mapping
 */
export function ensureVecTable(db: Database.Database): void {
  loadVecSafe(db);
  const wantDim = activeEmbeddingDim();

  // Detect dimension mismatch on existing vec_chunks tables before CREATE.
  // IF NOT EXISTS silently keeps the old table; if the provider changed the dim
  // every subsequent INSERT will crash with an unhelpful vec0 error.
  const existingRow = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_chunks'`
  ).get() as { sql: string } | undefined;
  if (existingRow) {
    const m = existingRow.sql.match(/FLOAT\[(\d+)\]/i);
    if (m) {
      const existingDim = parseInt(m[1], 10);
      if (existingDim !== wantDim) {
        const providerName = (
          process.env.NOX_EMBEDDING_PROVIDER ??
          process.env.NOX_EMBED_PROVIDER ??
          "gemini"
        ).trim();
        throw new Error(
          `Embedding dim mismatch: vec_chunks is ${existingDim}-dim but provider ` +
          `"${providerName}" produces ${wantDim}-dim. ` +
          `Re-vectorize: clear vec_chunks and run \`nox-mem vectorize --force\`.`
        );
      }
    }
  }

  // Use activeEmbeddingDim() so the vec0 column dimension matches the active provider.
  // For the default Gemini path this resolves to EMBEDDING_DIM (3072) — no behaviour change.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding FLOAT[${wantDim}]
    );
    CREATE TABLE IF NOT EXISTS vec_chunk_map (
      vec_rowid INTEGER PRIMARY KEY,
      chunk_id  INTEGER NOT NULL UNIQUE
    );
  `);
}

export function upsertEmbedding(
  db: Database.Database,
  chunkId: number,
  embedding: Float32Array
): void {
  loadVecSafe(db);

  // Check if already mapped
  const existing = db
    .prepare("SELECT vec_rowid FROM vec_chunk_map WHERE chunk_id = ?")
    .get(chunkId) as { vec_rowid: number } | undefined;

  if (existing) {
    // Delete old vec row + map entry
    db.prepare("DELETE FROM vec_chunks WHERE rowid = ?").run(existing.vec_rowid);
    db.prepare("DELETE FROM vec_chunk_map WHERE chunk_id = ?").run(chunkId);
  }

  // Insert new vec row
  const info = db
    .prepare("INSERT INTO vec_chunks (embedding) VALUES (?)")
    .run(JSON.stringify(Array.from(embedding)));

  const newRowid = Number(info.lastInsertRowid);

  // Map new rowid → chunk_id
  db.prepare("INSERT INTO vec_chunk_map (vec_rowid, chunk_id) VALUES (?, ?)").run(
    newRowid,
    chunkId
  );
}

export function semanticSearch(
  db: Database.Database,
  queryEmbedding: Float32Array,
  limit: number = 5
): Array<{
  chunk_id: number;
  distance: number;
  source_file: string;
  chunk_type: string;
  chunk_text: string;
  source_date: string | null;
}> {
  loadVecSafe(db);
  const rows = db
    .prepare(
      `
    SELECT
      m.chunk_id,
      vc.distance,
      c.source_file,
      c.chunk_type,
      c.chunk_text,
      c.source_date
    FROM vec_chunks vc
    JOIN vec_chunk_map m ON m.vec_rowid = vc.rowid
    JOIN chunks c ON c.id = m.chunk_id
    WHERE vc.embedding MATCH ?
    AND k = ?
    ORDER BY vc.distance
  `
    )
    .all(JSON.stringify(Array.from(queryEmbedding)), limit) as Array<{
    chunk_id: number;
    distance: number;
    source_file: string;
    chunk_type: string;
    chunk_text: string;
    source_date: string | null;
  }>;
  return rows;
}

export function countEmbedded(db: Database.Database): number {
  try {
    loadVecSafe(db);
    const r = db
      .prepare("SELECT COUNT(*) as c FROM vec_chunk_map")
      .get() as { c: number };
    return r.c;
  } catch {
    return 0;
  }
}

export { EMBEDDING_DIM };
