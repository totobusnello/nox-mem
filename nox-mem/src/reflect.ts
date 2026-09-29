/**
 * reflect.ts — Deep KG synthesis: gather evidence + synthesize via LLM provider
 *
 * Provider selection: NOX_LLM_PROVIDER env (default 'gemini').
 * Model override:     NOX_LLM_MODEL env (default 'gemini-2.5-flash-lite' per CLAUDE.md regra #3).
 * Fallback chain:     NOX_LLM_FALLBACK env (handled transparently by selectLLMProviderWithFallback).
 */
import { getDb } from "./db.js";
import { search, searchHybrid, type SearchResult } from "./search.js";
import { queryEntity, listDecisions, type GraphNode, type GraphEdge } from "./knowledge-graph.js";
import { findPath } from "./cross-agent-v2.js";
import { embedText, queryEmbedTimeoutMs } from "./embed.js";
import { selectLLMProviderWithFallback, MissingKeyError } from "./providers/index.js";

const MAX_EVIDENCE_CHARS = 2000;
const CACHE_TTL_HOURS = 24;

// E11 (2026-05-03): semantic key cache
const SEMANTIC_CACHE_THRESHOLD = parseFloat(process.env.NOX_REFLECT_SEMANTIC_THRESHOLD || "0.88");
const SEMANTIC_CACHE_ENABLED = process.env.NOX_REFLECT_SEMANTIC_CACHE !== "0"; // opt-out
const SEMANTIC_CACHE_LOG = process.env.NOX_REFLECT_SEMANTIC_LOG === "1";

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// CODE-FIX CRITICAL #2: Buffer aliasing — Node Buffer pool memory could be overwritten
// between read and cosine compute. Copy bytes into fresh ArrayBuffer to detach from pool.
// Also handles unaligned offsets (byteOffset % 4 !== 0).
function blobToFloat32(blob: Buffer): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, blob.byteLength / 4);
}

function float32ToBlob(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
}

export function ensureReflectCache(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS reflect_cache (
      query_hash TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      response TEXT NOT NULL,
      evidence_sources TEXT,
      model TEXT DEFAULT 'gemini-2.5-flash-lite',
      created_at TEXT DEFAULT (datetime('now')),
      ttl_hours INTEGER DEFAULT 24
    )
  `);
  // Additive migration: hit tracking (idempotent — ALTER fails if already added)
  for (const stmt of [
    "ALTER TABLE reflect_cache ADD COLUMN hit_count INTEGER DEFAULT 0",
    "ALTER TABLE reflect_cache ADD COLUMN last_hit_at TEXT",
    // E11: semantic cache
    "ALTER TABLE reflect_cache ADD COLUMN query_embedding BLOB",
    "ALTER TABLE reflect_cache ADD COLUMN semantic_hit_count INTEGER DEFAULT 0",
  ]) {
    try { db.exec(stmt); } catch { /* column exists */ }
  }
}

export function getReflectCacheStats(): {
  entries: number;
  total_hits: number;
  top_queries: Array<{ query: string; hits: number; last_hit_at: string | null }>;
} {
  ensureReflectCache();
  const db = getDb();
  const entries = (db.prepare("SELECT COUNT(*) as c FROM reflect_cache").get() as { c: number }).c;
  const total_hits = (db.prepare("SELECT COALESCE(SUM(hit_count),0) as s FROM reflect_cache").get() as { s: number }).s;
  const top_queries = db.prepare(
    "SELECT query, hit_count as hits, last_hit_at FROM reflect_cache WHERE hit_count > 0 ORDER BY hit_count DESC LIMIT 5"
  ).all() as Array<{ query: string; hits: number; last_hit_at: string | null }>;
  return { entries, total_hits, top_queries };
}

function hashQuery(q: string): string {
  let hash = 0;
  for (let i = 0; i < q.length; i++) {
    hash = ((hash << 5) - hash) + q.charCodeAt(i);
    hash |= 0;
  }
  return "r" + Math.abs(hash).toString(36);
}

interface Evidence {
  chunks: Array<{ text: string; source: string; score: number }>;
  entities: Array<{ name: string; type: string; relations: string[] }>;
  decisions: Array<{ key: string; content: string }>;
  paths: string[];
}

async function gatherEvidence(question: string): Promise<Evidence> {
  // 1. Hybrid search top 10 (async because semantic is async)
  let searchResults: SearchResult[];
  try {
    searchResults = await searchHybrid(question, 10);
  } catch {
    searchResults = search(question, 10); // fallback to FTS only
  }

  const chunks = searchResults.map(r => ({
    text: r.chunk_text.substring(0, 300),
    source: r.source_file,
    score: r.score,
  }));

  // 2. Extract entity names
  const entityNames: string[] = [];
  const words = question.split(/\s+/);
  for (const w of words) {
    if (w.length > 2 && w[0] === w[0].toUpperCase()) {
      const clean = w.replace(/[^a-zA-Z\u00C0-\u024F-]/g, "");
      if (clean && !entityNames.includes(clean)) entityNames.push(clean);
    }
  }

  // 3. Query KG for entities
  const entities: Evidence["entities"] = [];
  for (const name of entityNames.slice(0, 5)) {
    const result = queryEntity(name);
    if (result.entity) {
      entities.push({
        name: result.entity.name,
        type: result.entity.entityType,
        relations: result.relations.slice(0, 5).map((r: GraphEdge) =>
          `${r.relation} -> ${r.target}`
        ),
      });
    }
  }

  // 4. Find paths between top 2 entities
  const paths: string[] = [];
  const entNames = entities.map(e => e.name);
  if (entNames.length >= 2) {
    try {
      const pathResult = findPath(entNames[0], entNames[1]);
      if (pathResult && pathResult.length > 0) {
        paths.push(pathResult.map(n => n.entity).join(" -> "));
      }
    } catch {}
  }

  // 5. Related decisions
  const allDecisions = listDecisions();
  const questionLower = question.toLowerCase();
  const decisions = allDecisions
    .filter(d => {
      const kl = d.decision_key.toLowerCase();
      const cl = d.content.toLowerCase();
      return words.some(w => w.length > 3 && (kl.includes(w.toLowerCase()) || cl.includes(w.toLowerCase())));
    })
    .slice(0, 3)
    .map(d => ({ key: d.decision_key, content: d.content.substring(0, 200) }));

  return { chunks, entities, decisions, paths };
}

function formatEvidence(evidence: Evidence): string {
  const parts: string[] = [];

  if (evidence.chunks.length > 0) {
    parts.push("MEMORY CHUNKS:");
    for (const c of evidence.chunks.slice(0, 5)) {
      parts.push(`- [score:${c.score.toFixed(2)}] ${c.text}`);
    }
  }
  if (evidence.entities.length > 0) {
    parts.push("\nKG ENTITIES:");
    for (const e of evidence.entities.slice(0, 5)) {
      parts.push(`- ${e.name} (${e.type}) rels: ${e.relations.join(", ") || "none"}`);
    }
  }
  if (evidence.decisions.length > 0) {
    parts.push("\nDECISIONS:");
    for (const d of evidence.decisions) {
      parts.push(`- [${d.key}] ${d.content}`);
    }
  }
  if (evidence.paths.length > 0) {
    parts.push("\nGRAPH PATHS:");
    for (const p of evidence.paths) parts.push(`- ${p}`);
  }

  let result = parts.join("\n");
  if (result.length > MAX_EVIDENCE_CHARS) result = result.substring(0, MAX_EVIDENCE_CHARS) + "\n[truncated]";
  return result;
}

async function synthesize(question: string, evidence: string): Promise<string> {
  const prompt = `You are a memory synthesis agent. Given the evidence below, answer the question concisely.
Cite sources when possible. If the evidence is insufficient, say so.
Answer in the same language as the question. Max 500 characters.

QUESTION: ${question}

EVIDENCE:
${evidence}

SYNTHESIZED ANSWER:`;

  try {
    const llm = selectLLMProviderWithFallback();
    const result = await llm.complete({
      user: prompt,
      maxTokens: 256,
      temperature: 0.3,
    });
    return result.text.trim() || "[reflect: empty response]";
  } catch (err) {
    if (err instanceof MissingKeyError) {
      return `[reflect error: ${err.message}]`;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `[reflect error: ${msg.substring(0, 150)}]`;
  }
}

export async function reflect(
  question: string,
  options: { noCache?: boolean } = {}
): Promise<{ answer: string; evidence_count: number; cached: boolean; sources: string[]; cache_kind?: 'exact' | 'semantic' }> {
  ensureReflectCache();
  const db = getDb();

  if (!options.noCache) {
    // Path 1: exact hash hit (zero embedding cost)
    const qHash = hashQuery(question);
    const cached = db.prepare(
      "SELECT response, evidence_sources FROM reflect_cache WHERE query_hash = ? AND datetime(created_at, '+' || ttl_hours || ' hours') > datetime('now')"
    ).get(qHash) as { response: string; evidence_sources: string } | undefined;
    if (cached) {
      db.prepare("UPDATE reflect_cache SET hit_count = hit_count + 1, last_hit_at = datetime('now') WHERE query_hash = ?").run(qHash);
      return { answer: cached.response, evidence_count: 0, cached: true, sources: JSON.parse(cached.evidence_sources || "[]"), cache_kind: 'exact' };
    }

    // Path 2 (E11): semantic cache lookup
    // CODE-FIX CRITICAL #1 (perf): COUNT short-circuit + LIMIT recent (avoid embed call + N×3072d alloc on empty cache)
    if (SEMANTIC_CACHE_ENABLED) {
      const haveEmbeds = (db.prepare(
        "SELECT COUNT(*) AS c FROM reflect_cache WHERE query_embedding IS NOT NULL AND datetime(created_at, '+' || ttl_hours || ' hours') > datetime('now')"
      ).get() as { c: number }).c;
      if (haveEmbeds > 0) try {
        const queryEmbed = await embedText(question, { timeoutMs: queryEmbedTimeoutMs() });
        // LIMIT 500 ORDER BY most recent — bounds scan; semantic_hit_count desc keeps hot entries
        const candidates = db.prepare(
          `SELECT query_hash, query, response, evidence_sources, query_embedding
           FROM reflect_cache
           WHERE query_embedding IS NOT NULL AND datetime(created_at, '+' || ttl_hours || ' hours') > datetime('now')
           ORDER BY (hit_count + semantic_hit_count) DESC, created_at DESC LIMIT 500`
        ).all() as Array<{ query_hash: string; query: string; response: string; evidence_sources: string; query_embedding: Buffer }>;

        let bestSim = 0;
        let bestRow: typeof candidates[0] | undefined;
        for (const c of candidates) {
          const sim = cosineSim(queryEmbed, blobToFloat32(c.query_embedding));
          if (sim > bestSim) { bestSim = sim; bestRow = c; }
        }

        if (SEMANTIC_CACHE_LOG && bestRow) {
          console.log(`[reflect-semantic] query="${question.substring(0, 60)}" best_match="${bestRow.query.substring(0, 60)}" sim=${bestSim.toFixed(3)} threshold=${SEMANTIC_CACHE_THRESHOLD}`);
        }

        if (bestRow && bestSim >= SEMANTIC_CACHE_THRESHOLD) {
          db.prepare("UPDATE reflect_cache SET semantic_hit_count = semantic_hit_count + 1, last_hit_at = datetime('now') WHERE query_hash = ?").run(bestRow.query_hash);
          return {
            answer: bestRow.response,
            evidence_count: 0,
            cached: true,
            sources: JSON.parse(bestRow.evidence_sources || "[]"),
            cache_kind: 'semantic',
          };
        }
      } catch (e: any) {
        if (SEMANTIC_CACHE_LOG) console.error(`[reflect-semantic] embed failed, falling back to fresh: ${e.message?.substring(0, 80)}`);
        // Fail-open: continue to fresh synthesis
      }
    }
  }

  const evidence = await gatherEvidence(question);
  const evidenceText = formatEvidence(evidence);
  const sources = evidence.chunks.slice(0, 5).map(c => c.source);
  const answer = await synthesize(question, evidenceText);

  const qHash = hashQuery(question);
  // CODE-FIX MEDIUM: write fresh entry sync (without embedding); fire-and-forget embedding update
  // CODE-FIX MEDIUM: ON CONFLICT DO UPDATE preserva hit_count/semantic_hit_count vs INSERT OR REPLACE que zera
  db.prepare(`
    INSERT INTO reflect_cache (query_hash, query, response, evidence_sources, model, ttl_hours)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(query_hash) DO UPDATE SET
      response=excluded.response, evidence_sources=excluded.evidence_sources,
      model=excluded.model, ttl_hours=excluded.ttl_hours, created_at=datetime('now')
  `).run(qHash, question, answer, JSON.stringify(sources), process.env.NOX_LLM_MODEL ?? "gemini-2.5-flash-lite", CACHE_TTL_HOURS);

  // CODE-FIX MEDIUM: embedding capture deferred (don't block user response)
  if (SEMANTIC_CACHE_ENABLED) {
    embedText(question).then((emb) => {
      try {
        getDb().prepare("UPDATE reflect_cache SET query_embedding = ? WHERE query_hash = ?")
          .run(float32ToBlob(emb), qHash);
      } catch { /* db closed mid-flight, OK */ }
    }).catch(() => { /* fail-open */ });
  }

  return { answer, evidence_count: evidence.chunks.length + evidence.entities.length + evidence.decisions.length, cached: false, sources };
}

export function formatReflect(result: { answer: string; evidence_count: number; cached: boolean; sources: string[]; cache_kind?: 'exact' | 'semantic' }): string {
  const lines = [result.answer];
  if (result.sources.length > 0) lines.push("", `Sources: ${result.sources.join(", ")}`);
  const cacheLabel = result.cached ? `cached:${result.cache_kind || 'exact'}` : "fresh";
  lines.push(`[${cacheLabel}, ${result.evidence_count} evidence items]`);
  return lines.join("\n");
}
