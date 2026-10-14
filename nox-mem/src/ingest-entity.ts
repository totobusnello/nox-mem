// Fase 1.7b-c — Compiled Truth + Timeline Append-Only (paper "Claude Memory Setup")
//
// Parser for memory/entities/<type>/<entity>.md files following the 3-section format:
//
//   ---
//   name: Nox
//   description: Chief of Staff & COO
//   type: reference
//   ---
//
//   {Compiled truth — CURRENT best understanding. REWRITTEN as evidence changes.}
//
//   - Role: Chief of Staff & COO
//   - SessionKey: agent:nox:discord:channel:...
//
//   ---
//
//   ## Timeline
//
//   - **2026-04-21** — [user-feedback] operator confirmed delegation
//   - **2026-04-20** — [implementation] Heartbeat migrated
//
// Each file produces N+2 chunks: 1 frontmatter + 1 compiled + N timeline entries.

import { existsSync, readFileSync } from "fs";
import { relative, resolve } from "path";
import Database from "better-sqlite3";
import { getDb } from "./db.js";
import { syncFileChunks, type DesiredChunk } from "./lib/chunk-sync.js";
import { getInitialTier } from "./tier-manager.js";
import { resolveRetention } from "./retention.js";
import { inferPain, inferImportance } from "./salience.js";
import { redact as _redactPrivacy } from "./privacy/filter.js";
import { workspaceRoot } from "./lib/workspace.js";

const WORKSPACE = workspaceRoot();

export interface EntityFrontmatter {
  name?: string;
  description?: string;
  type?: string;
  [key: string]: unknown;
}

export interface ParsedEntity {
  frontmatter: EntityFrontmatter;
  frontmatterRaw: string;
  compiled: string;
  timeline: string[];
}

/**
 * Section boost values by section type. Multiplicative in search ranking but
 * applied additively when combined with tier/importance boosts to avoid
 * stacking (v3.4 lesson). Compiled is the current truth → highest weight.
 */
export const SECTION_BOOST: Record<string, number> = {
  compiled: 2.0,
  frontmatter: 1.5,
  timeline: 0.8,
};

/**
 * Parse an entity file into frontmatter + compiled truth + timeline entries.
 * Returns null if the file doesn't match the expected format (caller falls
 * back to regular ingest).
 *
 * Expected structure:
 *   1. YAML frontmatter block (--- ... ---) at top
 *   2. Compiled truth section (free-form markdown until "## Timeline" or EOF)
 *   3. Optional "## Timeline" section with `- **DATE** — [tag] description` bullets
 */
export function parseEntityFile(content: string): ParsedEntity | null {
  const normalized = content.replace(/\r\n/g, "\n");

  // Frontmatter — must be first thing in file
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return null;

  const frontmatterRaw = fmMatch[1];
  const frontmatter = parseSimpleYaml(frontmatterRaw);

  const afterFm = normalized.slice(fmMatch[0].length);

  // Split on "## Timeline" heading (anywhere in the doc, case-insensitive)
  const timelineHeaderRe = /\n##\s+Timeline\s*\n/i;
  const timelineMatch = afterFm.match(timelineHeaderRe);

  let compiled: string;
  let timelineBlock: string;
  if (timelineMatch && typeof timelineMatch.index === "number") {
    compiled = afterFm.slice(0, timelineMatch.index).trim();
    timelineBlock = afterFm.slice(timelineMatch.index + timelineMatch[0].length);
  } else {
    compiled = afterFm.trim();
    timelineBlock = "";
  }

  // Timeline entries: each is a bullet starting with "- **DATE**" or "- DATE"
  const timeline: string[] = [];
  if (timelineBlock) {
    // Split on "\n- " but keep the bullet marker reconstructed
    const lines = timelineBlock.split(/\n(?=- )/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ") && trimmed.length > 2) {
        timeline.push(trimmed);
      }
    }
  }

  return { frontmatter, frontmatterRaw, compiled, timeline };
}

/**
 * Minimal YAML frontmatter parser — handles `key: value` lines.
 * Does NOT handle nested structures, arrays, or multiline — keep entity
 * frontmatters flat per paper convention.
 */
function parseSimpleYaml(raw: string): EntityFrontmatter {
  const out: EntityFrontmatter = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, valRaw] = m;
    // Strip surrounding quotes if present
    let val: string | number | boolean = valRaw;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val === "true") val = true as any;
    else if (val === "false") val = false as any;
    else if (/^-?\d+(\.\d+)?$/.test(val as string)) val = Number(val);
    out[key] = val;
  }
  return out;
}

export interface EntityIngestResult {
  parsed: boolean;
  chunks: number;
  /** rowid of the `compiled` chunk; null when the file has none */
  compiledChunkId: number | null;
  /** ids of rows created by this ingest */
  inserted: number[];
  kept: number;
  deleted: number;
  adopted: number;
}

/**
 * Synchronous core (no await, so reindex can run it inside one transaction).
 * Diffs the file's N+2 chunks against what is stored (chunk-sync.ts): an entity
 * whose compiled truth changed gets ONE new row; frontmatter and the untouched
 * timeline entries keep their ids. The key includes the section, so the
 * `compiled == frontmatter` invariant (CLAUDE.md rule 6) holds per file.
 */
export function ingestEntitySync(db: Database.Database, filePath: string): EntityIngestResult {
  const relPath = relative(WORKSPACE, filePath);
  const content = readFileSync(filePath, "utf-8");

  const entity = parseEntityFile(content);
  if (!entity) {
    return { parsed: false, chunks: 0, compiledChunkId: null, inserted: [], kept: 0, deleted: 0, adopted: 0 };
  }

  const chunkType = inferChunkTypeFromPath(relPath);
  const tier = getInitialTier(chunkType);
  const importance = inferImportance(chunkType);
  // Compiled truth represents user-declared current state → bump importance
  const compiledImportance = Math.max(importance, 0.9);
  const retentionDays = resolveRetention(chunkType, content);
  const today = new Date().toISOString().slice(0, 10);
  const name = entity.frontmatter.name ?? null;

  // Privacy filter: redact before storage (staged-privacy follow-up Wave Q)
  const redacted = (text: string, where: string): string => {
    const r = _redactPrivacy(text);
    if (r.redactionCount > 0) {
      console.warn(`[privacy-filter] redacted ${r.redactionCount} secret(s) in entity ${where} — kinds: ${r.kinds.join(", ")}`);
    }
    return r.text;
  };
  const chunk = (text: string, section: string, metadata: Record<string, unknown>, imp: number): DesiredChunk => ({
    chunk_text: text,
    section,
    chunk_type: chunkType,
    source_date: null,
    metadata: JSON.stringify(metadata),
    tier,
    importance: imp,
    retention_days: retentionDays,
    pain: inferPain(chunkType, text),
    section_boost: SECTION_BOOST[section] ?? null,
  });

  const desired: DesiredChunk[] = [];
  // 1. Frontmatter chunk
  desired.push(chunk(redacted(`---\n${entity.frontmatterRaw}\n---`, "frontmatter"), "frontmatter",
    { section: "frontmatter", entity: name }, importance));
  // 2. Compiled truth chunk — single chunk, the "current state"
  const compiledAt = entity.compiled ? desired.length : -1;
  if (entity.compiled) {
    desired.push(chunk(redacted(entity.compiled, "compiled"), "compiled",
      { section: "compiled", entity: name, recompiled_at: today }, compiledImportance));
  }
  // 3. Timeline entries — one chunk each, reverse-chronological preserved as-is
  for (const entry of entity.timeline) {
    desired.push(chunk(redacted(entry, "timeline"), "timeline", { section: "timeline", entity: name }, importance));
  }

  const r = syncFileChunks(db, relPath, desired, { existsOnDisk: (p) => existsSync(resolve(WORKSPACE, p)) });
  return {
    parsed: true,
    chunks: desired.length,
    compiledChunkId: compiledAt >= 0 ? r.ids[compiledAt]! : null,
    inserted: r.inserted,
    kept: r.kept,
    deleted: r.deleted,
    adopted: r.adopted,
  };
}

/**
 * Ingest a single entity file as 1 frontmatter chunk + 1 compiled chunk
 * + N timeline chunks. All chunks share the same source_file relative path.
 *
 * chunk_type is inferred from directory:
 *   memory/entities/agents/   → 'person' (never-decay)
 *   memory/entities/projects/ → 'project' (365d retention)
 *   memory/entities/systems/  → 'other' (90d — system state evolves)
 *   memory/entities/people/   → 'person'
 *
 * Never closes the connection (see ingestFile).
 */
export async function ingestEntityFile(
  filePath: string,
  externalDb?: Database.Database,
): Promise<EntityIngestResult> {
  return ingestEntitySync(externalDb ?? getDb(), filePath);
}

function inferChunkTypeFromPath(relPath: string): string {
  if (/entities\/agents\//.test(relPath)) return "person";
  if (/entities\/projects\//.test(relPath)) return "project";
  if (/entities\/people\//.test(relPath)) return "person";
  if (/entities\/systems\//.test(relPath)) return "other";
  return "other";
}
