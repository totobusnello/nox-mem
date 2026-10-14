/**
 * crystallize.ts — Save multi-step procedures as reusable chunks (type=procedure)
 * Procedures are searchable via hybrid search and validated with outcome tracking.
 */
import { getDb } from "./db.js";

interface ProcedureInput {
  title: string;
  steps: string[];
  agent?: string;
  tags?: string[];
  preconditions?: string[];
}

export interface ValidationEntry {
  timestamp: string;
  outcome: "success" | "failure" | "partial";
  agent: string;
  notes?: string;
}

export interface ValidationOptions {
  outcome?: "success" | "failure" | "partial";
  agent?: string;
  notes?: string;
}

/**
 * Save a procedure as a type=procedure chunk and (best-effort) embed it
 * immediately so it is hybrid-searchable without waiting for the weekly
 * vectorize cron. Embedding failure never aborts the save — FTS still works.
 */
export async function crystallize(input: ProcedureInput): Promise<number> {
  const db = getDb();

  const metadata = JSON.stringify({
    preconditions: input.preconditions || [],
    steps: input.steps,
    tags: input.tags || [],
    origin_agent: input.agent || "system",
    validated: false,
    validation_count: 0,
    validations: [],
  });

  // Format chunk text for FTS indexing
  const chunkText = [
    `# Procedure: ${input.title}`,
    "",
    input.preconditions?.length ? `Preconditions: ${input.preconditions.join(", ")}` : "",
    "",
    "Steps:",
    ...input.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    input.tags?.length ? `Tags: ${input.tags.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  const result = db.prepare(`
    INSERT INTO chunks (source_file, chunk_type, chunk_text, source_date, metadata)
    VALUES (?, 'procedure', ?, datetime('now'), ?)
  `).run(`procedure/${input.title.toLowerCase().replace(/\s+/g, "-")}`, chunkText, metadata);

  const id = result.lastInsertRowid as number;

  // FTS indexing is handled by the chunks_ai AFTER INSERT trigger (external-content, content=chunks).
  // A manual INSERT here duplicated the FTS posting and broke the index 1:1 invariant,
  // causing SQLITE_CORRUPT_VTAB on the next delete/update. Removed 2026-06-17.

  // Best-effort embed so procedures are immediately hybrid-searchable.
  // Skip silently if GEMINI_API_KEY is missing or embed fails — FTS still works.
  try {
    if (process.env.GEMINI_API_KEY) {
      const { embedDocument, upsertEmbedding } = await import("./embed.js");
      const vec = await embedDocument(chunkText);
      upsertEmbedding(db, id, vec);
    }
  } catch (err) {
    console.error(`[crystallize] embedding failed for #${id}: ${String(err)}`);
  }

  return id;
}

/**
 * Record a validation attempt for a procedure. Each call appends a structured
 * entry to metadata.validations[] so we can track WHO validated, WHEN, and
 * whether the run succeeded/failed/partial. Outcome defaults to "success"
 * to preserve the old boolean-flip behavior for callers that pass no args.
 */
export function validateProcedure(chunkId: number, options: ValidationOptions = {}): void {
  const db = getDb();
  const row = db.prepare("SELECT metadata FROM chunks WHERE id = ? AND chunk_type = 'procedure'").get(chunkId) as { metadata: string } | undefined;
  if (!row) throw new Error(`Procedure #${chunkId} not found`);

  const meta = JSON.parse(row.metadata || "{}");
  const entry: ValidationEntry = {
    timestamp: new Date().toISOString(),
    outcome: options.outcome || "success",
    agent: options.agent || "system",
    ...(options.notes ? { notes: options.notes } : {}),
  };

  meta.validations = Array.isArray(meta.validations) ? meta.validations : [];
  meta.validations.push(entry);
  meta.validation_count = meta.validations.length;
  meta.last_validated = entry.timestamp;
  // "validated" stays true once the procedure has any successful run.
  meta.validated = meta.validated || entry.outcome === "success";

  db.prepare("UPDATE chunks SET metadata = ? WHERE id = ?").run(JSON.stringify(meta), chunkId);
}

export function listProcedures(): Array<{
  id: number;
  title: string;
  validated: boolean;
  steps: number;
  agent: string;
  validations: number;
  successRate: number | null;
  lastValidated: string | null;
}> {
  const db = getDb();
  const rows = db.prepare("SELECT id, chunk_text, metadata FROM chunks WHERE chunk_type = 'procedure' ORDER BY source_date DESC").all() as Array<{ id: number; chunk_text: string; metadata: string }>;

  return rows.map(r => {
    const meta = JSON.parse(r.metadata || "{}");
    const titleMatch = r.chunk_text.match(/^# Procedure: (.+)$/m);
    const validations: ValidationEntry[] = Array.isArray(meta.validations) ? meta.validations : [];
    const successes = validations.filter(v => v.outcome === "success").length;
    const successRate = validations.length > 0 ? Math.round((successes / validations.length) * 100) / 100 : null;

    return {
      id: r.id,
      title: titleMatch?.[1] || "untitled",
      validated: meta.validated || false,
      steps: meta.steps?.length || 0,
      agent: meta.origin_agent || "system",
      validations: validations.length,
      successRate,
      lastValidated: meta.last_validated || null,
    };
  });
}

export function formatProcedureList(procs: ReturnType<typeof listProcedures>): string {
  if (procs.length === 0) return "No crystallized procedures yet.";
  return procs.map(p => {
    const rate = p.successRate !== null ? ` ${Math.round(p.successRate * 100)}%` : "";
    return `#${p.id} ${p.validated ? "✅" : "⏳"} ${p.title} (${p.steps} steps, by ${p.agent}, ${p.validations} validations${rate})`;
  }).join("\n");
}
