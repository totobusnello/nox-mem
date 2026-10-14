// ingest-router.ts — Single dispatch entry point para ingestão de arquivos.
// A2 (2026-04-25): paga débito arquitetural exposto pelo incident 2026-04-25
// (reindex zerou metadata de entities porque ingestFile genérico não rotava).
//
// Pattern: TODOS os callers (CLI, MCP, watch, reindex) devem passar por routeIngest()
// pra garantir que arquivos especializados (entities, future graphify, future PDF)
// sejam handled pelos handlers corretos, sem cada caller precisar saber do roteamento.
//
// Defesa em camadas: ingestFile() ainda tem guard interno pra entity files (caso
// algum legacy caller pule o router). Mas o router é o caminho canônico daqui em diante.

import type Database from "better-sqlite3";
import { relative } from "node:path";
import { ingestFile, ingestMarkdownSync } from "../ingest.js";
import { ingestEntityFile, ingestEntitySync } from "../ingest-entity.js";
import { workspaceRoot } from "./workspace.js";

const WORKSPACE = workspaceRoot();

export type IngestKind = "entity" | "markdown" | "graphify";

export interface IngestRouteResult {
  chunks: number;
  kind: IngestKind;
  routedTo: string;
  /** write-path diff (chunk-sync.ts): rows created / kept / removed / adopted from a rename */
  inserted?: number[];
  kept?: number;
  deleted?: number;
  adopted?: number;
}

export interface IngestOpts {
  externalDb?: Database.Database;
  forceKind?: IngestKind; // override auto-detect
}

const diffOf = (r: { inserted: number[]; kept: number; deleted: number; adopted: number }) => ({
  inserted: r.inserted, kept: r.kept, deleted: r.deleted, adopted: r.adopted,
});

/**
 * Detect ingest kind from path conventions. Centralizada aqui — mexer só nesse
 * arquivo quando adicionar novo tipo (ex: "pdf-text-layer", "fathom-transcript").
 */
export function detectIngestKind(filePath: string): IngestKind {
  const relPath = relative(WORKSPACE, filePath);
  if (relPath.startsWith("memory/entities/") && filePath.endsWith(".md")) return "entity";
  if (relPath.startsWith("graphify-out/") || relPath.includes("/graphify-out/")) return "graphify";
  return "markdown";
}

/**
 * Single dispatch entry point. Todos callers devem usar isso em vez de chamar
 * ingestFile()/ingestEntityFile() direto. Backward compat: kinds não-implementados
 * caem no markdown handler (ingestFile).
 */
export async function routeIngest(filePath: string, opts: IngestOpts = {}): Promise<IngestRouteResult> {
  const kind = opts.forceKind || detectIngestKind(filePath);

  switch (kind) {
    case "entity": {
      const r = await ingestEntityFile(filePath, opts.externalDb);
      if (r.parsed) return { chunks: r.chunks, kind: "entity", routedTo: "ingestEntityFile", ...diffOf(r) };
      // Entity file failed parse — fall through to markdown ingest pra não perder dado
      const fallback = await ingestFile(filePath, opts.externalDb);
      return { chunks: fallback.chunks, kind: "markdown", routedTo: "ingestFile (fallback after entity parse fail)", ...diffOf(fallback) };
    }
    case "graphify":
      // Hoje não existe graphify-ingest separado pra arquivos individuais (graphify
      // produz JSON em batch via skill própria). Cair no markdown como tratamento neutro.
      // Reservado pra Wave 2+ se virar handler dedicado.
      return await ingestFile(filePath, opts.externalDb).then((r) => ({
        chunks: r.chunks,
        kind: "graphify" as const,
        routedTo: "ingestFile (graphify path neutralized)",
        ...diffOf(r),
      }));
    case "markdown":
    default:
      return await ingestFile(filePath, opts.externalDb).then((r) => ({
        chunks: r.chunks,
        kind: "markdown" as const,
        routedTo: "ingestFile",
        ...diffOf(r),
      }));
  }
}

/**
 * Synchronous dispatch for reindex, which runs every file inside ONE
 * transaction so its wipe guard can roll back before commit. Same routing as
 * routeIngest; no inline embedding (reindex vectorizes in batch afterwards).
 */
export function routeIngestSync(db: Database.Database, filePath: string): IngestRouteResult {
  const kind = detectIngestKind(filePath);
  if (kind === "entity") {
    const r = ingestEntitySync(db, filePath);
    if (r.parsed) return { chunks: r.chunks, kind: "entity", routedTo: "ingestEntitySync", ...diffOf(r) };
    const fallback = ingestMarkdownSync(db, filePath);
    return { chunks: fallback.chunks, kind: "markdown", routedTo: "ingestMarkdownSync (fallback after entity parse fail)", ...diffOf(fallback) };
  }
  const r = ingestMarkdownSync(db, filePath);
  return { chunks: r.chunks, kind, routedTo: "ingestMarkdownSync", ...diffOf(r) };
}
