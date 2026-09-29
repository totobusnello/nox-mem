#!/usr/bin/env node
import { Command } from "commander";
import { search, searchHybrid, formatResults } from "./search.js";
import { reindex } from "./reindex.js";
import { primer } from "./primer.js";
import { getStats } from "./stats.js";
import { getDb, closeDb, checkLargeDbIngestGuard } from "./db.js";
import { syncProjectContexts, listProjects } from "./project-context-gen.js";
import { crossSearch, formatCrossResults, getCrossStats } from "./cross-search.js";
import { compact } from "./compact.js";
import { getMetrics } from "./metrics.js";
import { updateSessionState } from "./session-update.js";
import { buildGraph, getGraphStats, formatEntityQuery, mergeEntities, pruneKnowledgeGraph, formatPruneResult, upsertDecision, getDecisionHistory, listDecisions, getCurrentDecision } from "./knowledge-graph.js";
import { shareInsight, pullSharedInsights, listShared, sharedStats } from "./shared-memory.js";
import { selfImprove } from "./self-improve.js";
import { getTierStats, evaluateTiers } from "./tier-manager.js";
import { getNoiseStats, isNoise } from "./noise-filter.js";
import { distillSessions } from "./session-distill.js";
import { startWatch } from "./watch.js";
import { VERSION } from "./version.js";
import { parseTemporalFilter, TemporalParseError, type TemporalFilter } from "./lib/dates.js";



const program = new Command();

program.name("nox-mem").description("Nox Supermem — search, consolidate, recover").version(VERSION);

program
  .command("search <query>")
  .description("Search memory (FTS5 + boost + recency)")
  .option("-n, --limit <n>", "Number of results", "5")
  .option("--no-hybrid", "Disable semantic search (FTS5 only)")
  .option("--as-of <date>", "Only chunks that existed at <date> (ISO 8601 or relative: 15m, 2h, 7d, 1w)")
  .option("--changed-since <date>", "Only chunks created/updated after <date> (ISO 8601 or relative)")
  .action(async (query: string, opts: { limit: string; hybrid: boolean; asOf?: string; changedSince?: string }) => {
    let filter: TemporalFilter | undefined;
    try {
      filter = parseTemporalFilter({ asOf: opts.asOf, changedSince: opts.changedSince });
    } catch (err) {
      if (!(err instanceof TemporalParseError)) throw err;
      console.error(`error: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    if (opts.hybrid) {
      const results = await searchHybrid(query, parseInt(opts.limit, 10), true, filter);
      console.log(formatResults(results));
    } else {
      console.log(formatResults(search(query, parseInt(opts.limit, 10), true, filter)));
    }
    closeDb();
  });

// `answer` keeps its own argv parser (src/cli/answer.ts, P1 T8), so commander
// only routes to it and hands over the raw argv after the subcommand name.
program
  .command("answer")
  .description("Grounded answer with citations over memory (needs GEMINI_API_KEY; see `nox-mem answer --help`)")
  .argument("[question...]")
  .allowUnknownOption(true)
  .helpOption(false)
  .action(async () => {
    const { runCli } = await import("./cli/answer.js");
    const argv = process.argv.slice(process.argv.indexOf("answer") + 1);
    const code = await runCli({
      argv,
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    });
    closeDb();
    process.exitCode = code;
  });

program
  .command("vectorize")
  .description("Build/update vector index for all chunks (semantic search)")
  .option("--force", "Re-embed all chunks, even already indexed", false)
  .action(async (opts: { force: boolean }) => {
    const { vectorize } = await import("./vectorize.js");
    const result = await vectorize({ force: opts.force });
    console.log(`[INFO] Vectorize complete: ${result.embedded} embedded, ${result.skipped} skipped, ${result.total} total`);
    closeDb();
  });

program
  .command("ingest <files...>")
  .description("Index one or more .md or .json files (a directory is an error: pass files, e.g. dir/*.md)")
  .option("--allow-prod", "Skip the large-DB ingest guard (needed once the DB has more than 10,000 chunks; same as NOX_ALLOW_PROD_INGEST=1)")
  .action(async (files: string[], opts: { allowProd?: boolean }) => {
    // Large-DB guard (postmortem 2026-05-19): abort if DB looks like prod
    // and operator hasn't explicitly opted in. Override via --allow-prod flag
    // or NOX_ALLOW_PROD_INGEST=1 env var.
    if (opts.allowProd) {
      process.env.NOX_ALLOW_PROD_INGEST = "1";
    }
    checkLargeDbIngestGuard(getDb(), "ingest");
    const { routeIngest } = await import("./lib/ingest-router.js");
    const { ingestMany } = await import("./lib/ingest-many.js");
    const { failed } = await ingestMany(files, {
      ingestOne: (f) => routeIngest(f),
      log: (l) => console.log(l),
      error: (l) => console.error(l),
    });
    closeDb();
    if (failed > 0) process.exitCode = 1;
  });

program
  .command("ingest-entity <file>")
  .description("Ingest entity file (3-secoes) via routeIngest — preserva section/retention (incident 2026-04-25)")
  .option("--allow-prod", "Skip large-DB ingest guard (required for prod ops, see CLAUDE.md §6)")
  .action(async (file: string, opts: { allowProd?: boolean }) => {
    if (opts.allowProd) {
      process.env.NOX_ALLOW_PROD_INGEST = "1";
    }
    checkLargeDbIngestGuard(getDb(), "ingest");
    const { routeIngest } = await import("./lib/ingest-router.js");
    const result = await routeIngest(file);
    console.log(`[INFO] Ingested ${file}: ${result.chunks} chunks (kind=${result.kind}, via=${result.routedTo})`);
    closeDb();
  });

program
  .command("reindex")
  .description("Rebuild the index from $OPENCLAW_WORKSPACE/memory and /shared (refuses if that source is missing)")
  .option("--dry-run", "Print what would be reindexed as JSON; does not touch the DB")
  .action(async (opts: { dryRun?: boolean }) => {
    try {
      const result = await reindex({ dryRun: opts.dryRun });
      if (!opts.dryRun) console.log(`[INFO] Reindexed ${result.files} files, ${result.chunks} chunks`);
    } catch (err) {
      const name = (err as Error).name;
      if (name === "ReindexSourceMissingError" || name === "ReindexWipeDetectedError" || name === "ReindexWorkspaceMismatchError") {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }
      throw err;
    } finally {
      closeDb();
    }
  });

program
  .command("primer")
  .description("Generate context recovery summary (~500 tokens)")
  .action(async () => {
    console.log(primer());
    closeDb();
  });

program
  .command("stats")
  .description("Show memory statistics")
  .action(async () => {
    console.log(getStats());
    closeDb();
  });

program
  .command("consolidate")
  .description("Consolidate daily notes into topic files (LLM: Gemini, then Groq, then Claude — needs GEMINI_API_KEY, GROQ_API_KEY or ANTHROPIC_API_KEY)")
  .action(async () => {
    const { consolidate } = await import("./consolidate.js");
    const result = await consolidate();
    if (result.remaining > 0) {
      console.log(`[INFO] ${result.remaining} daily notes still pending — run again or wait for next cron`);
    }
    closeDb();
  });

program
  .command("retry-failed")
  .description("Retry consolidation of previously failed daily notes")
  .action(async () => {
    const { consolidate } = await import("./consolidate.js");
    await consolidate({ retryFailed: true });
    closeDb();
  });

program
  .command("digest")
  .description("Generate weekly digest")
  .action(async () => {
    const { digest } = await import("./digest.js");
    await digest();
    closeDb();
  });

program
  .command("doctor")
  .description("Diagnostic check — core (SQLite, FTS5, embeddings) + optional integrations (Ollama for digest, Notion, watcher)")
  .option("--quiet", "Print only core problems; exit 1 if a core check fails")
  .action(async (opts: { quiet?: boolean }) => {
    const { doctor } = await import("./doctor.js");
    await doctor({ quiet: opts.quiet });
    closeDb();
  });

program
  .command("projects")
  .description("List all projects with last update date")
  .action(async () => {
    listProjects();
    closeDb();
  });

program
  .command("project-sync")
  .description("Sync PROJECT_CONTEXT.md files from memory database")
  .action(async () => {
    const result = syncProjectContexts();
    console.log(`[PROJECT-SYNC] Updated: ${result.updated}, Created: ${result.created}, Errors: ${result.errors}`);
    closeDb();
  });


program
  .command("cross-search <query>")
  .description("Search across ALL agent memory databases")
  .option("-n, --limit <n>", "Number of results", "10")
  .action((query: string, opts: { limit: string }) => {
    const results = crossSearch(query, parseInt(opts.limit, 10));
    console.log(formatCrossResults(results));
  });

program
  .command("cross-stats")
  .description("Show chunk counts across all agent databases")
  .action(async () => {
    console.log(getCrossStats());
  });

program
  .command("compact")
  .description("Compress old chunks (>30 days) into summaries")
  .option("--age <days>", "Minimum age in days", "30")
  .option("--dry-run", "Preview without making changes", false)
  .action(async (opts: { age: string; dryRun: boolean }) => {
    const result = await compact(parseInt(opts.age, 10), opts.dryRun);
    console.log("[COMPACT] Done: " + result.compacted + " compacted, " + result.summaries + " summaries, " + result.deleted + " removed");
    closeDb();
  });

program
  .command("metrics")
  .description("Show daily observability metrics")
  .option("-d, --days <n>", "Number of days to show", "7")
  .action((opts: { days: string }) => {
    console.log(getMetrics(parseInt(opts.days, 10)));
    closeDb();
  });

program
  .command("update-session")
  .description("Auto-update SESSION-STATE.md from latest memory")
  .action(async () => {
    updateSessionState();
    closeDb();
  });


program
  .command("kg-build")
  .description("Build knowledge graph from memory chunks (incremental)")
  .option("-n, --limit <n>", "Max chunks to process", "200")
  .action(async (opts: { limit: string }) => {
    const result = buildGraph(parseInt(opts.limit, 10));
    console.log("[KG] Built: " + result.entities + " entities, " + result.relations + " relations");
    closeDb();
  });

program
  .command("kg-query <entity>")
  .description("Query knowledge graph for an entity and its relations")
  .action(async (entity: string) => {
    console.log(formatEntityQuery(entity));
    closeDb();
  });

program
  .command("kg-stats")
  .description("Show knowledge graph statistics")
  .action(async () => {
    console.log(getGraphStats());
    closeDb();
  });

program
  .command("self-improve")
  .description("Run agent self-improvement analysis (contradictions, patterns, gaps)")
  .action(async () => {
    const report = await selfImprove();
    console.log(report);
    closeDb();
  });


program
  .command("kg-merge")
  .description("Merge duplicate entities in knowledge graph (normalizes names)")
  .option("--dry-run", "Show what would be merged without mutating (preview JSON)", false)
  .action(async (opts: { dryRun?: boolean }) => {
    // audit #20 fix — kg-merge does DELETE+UPDATE on kg_entities/kg_relations.
    // Wrap in withOpAudit for atomic snapshot pre-op (CLAUDE.md rule #6) and
    // expose --dry-run for safe preview without mutation.
    if (opts.dryRun) {
      const { previewMergeEntities } = await import("./knowledge-graph.js");
      const preview = previewMergeEntities();
      console.log(JSON.stringify({
        op: "kg-merge",
        dry_run: true,
        would_merge: preview.wouldMerge,
        groups: preview.groups,
      }, null, 2));
      closeDb();
      return;
    }
    const { withOpAudit } = await import("./lib/op-audit.js");
    const result = await withOpAudit("kg-merge", async () => {
      const r = mergeEntities();
      return { affected_rows: r.merged };
    });
    const merged = typeof result === "object" && result && "affected_rows" in result
      ? (result as { affected_rows: number }).affected_rows
      : 0;
    console.log("[KG] Merged " + merged + " duplicate entities");
    closeDb();
  });

program
  .command("kg-prune")
  .description("Prune expired/low-confidence relations from knowledge graph (TTL decay)")
  .option("--dry-run", "Show what would be pruned without deleting")
  .action(async (opts: { dryRun?: boolean }) => {
    const result = pruneKnowledgeGraph(opts.dryRun ?? false);
    console.log(formatPruneResult(result));
    if (opts.dryRun) console.log("[KG-PRUNE] Dry run — no changes made");
    closeDb();
  });

// ─── Decision versioning ────────────────────────────────────────────────────
program
  .command("decision-set <key> <content>")
  .description("Set/update a versioned decision (tracks full history)")
  .option("--author <name>", "Author name", "system")
  .action((key: string, content: string, opts: { author: string }) => {
    const v = upsertDecision(key, content, undefined, opts.author);
    console.log(`✅ Decision "${key}" → v${v}`);
    closeDb();
  });

program
  .command("decision-get <key>")
  .description("Get current value of a decision")
  .action((key: string) => {
    const current = getCurrentDecision(key);
    if (!current) { console.log(`Decision "${key}" not found`); }
    else { console.log(current); }
    closeDb();
  });

program
  .command("decision-history <key>")
  .description("Show full version history of a decision")
  .action((key: string) => {
    const history = getDecisionHistory(key);
    if (history.length === 0) { console.log(`No history for "${key}"`); closeDb(); return; }
    for (const h of history) {
      const flag = h.is_current ? " [CURRENT]" : ` [superseded ${h.superseded_at}]`;
      console.log(`v${h.version}${flag} — ${h.created_at}`);
      console.log(`  ${h.content}\n`);
    }
    closeDb();
  });

program
  .command("decision-list")
  .description("List all current decisions")
  .action(() => {
    const decisions = listDecisions();
    if (decisions.length === 0) { console.log("No decisions recorded"); closeDb(); return; }
    for (const d of decisions) {
      console.log(`[${d.decision_key}] v${d.version} (${d.created_at})`);
      console.log(`  ${d.content.substring(0, 120)}\n`);
    }
    closeDb();
  });

// ─── Shared memory (cross-agent) ────────────────────────────────────────────
program
  .command("share <text>")
  .description("Share an insight to the cross-agent shared memory pool")
  .option("--type <type>", "Chunk type", "insight")
  .option("--tags <tags>", "Comma-separated tags", "")
  .option("--reason <reason>", "Why sharing this")
  .action(async (text: string, opts: { type: string; tags: string; reason?: string }) => {
    const tags = opts.tags ? opts.tags.split(",").map(t => t.trim()) : [];
    const id = shareInsight(text, opts.type, tags, opts.reason);
    console.log(`✅ Shared (id=${id})`);
    closeDb();
  });

program
  .command("pull-shared")
  .description("Pull unprocessed shared insights from other agents into this DB")
  .option("--agent <name>", "Agent name to pull for")
  .action(async (opts: { agent?: string }) => {
    const imported = await pullSharedInsights(opts.agent);
    console.log(`✅ Imported ${imported} shared insights`);
    closeDb();
  });

program
  .command("shared-stats")
  .description("Show stats on the cross-agent shared memory pool")
  .action(() => {
    const stats = sharedStats();
    console.log(`Total shared: ${stats.total}`);
    for (const a of stats.byAgent) console.log(`  ${a.agent}: ${a.count}`);
    closeDb();
  });


// ─── Knowledge Graph v2: LLM extraction ──────────────────────────────────────

program
  .command("kg-extract")
  .description("Extract entities/relations from chunks using Gemini (needs GEMINI_API_KEY)")
  .option("-n, --limit <n>", "Chunks to process", "50")
  .action(async (opts: { limit: string }) => {
    const { extractWithLLM } = await import("./kg-llm.js");
    const { ensureGraphTables, buildGraph } = await import("./knowledge-graph.js");
    const { getDb, closeDb } = await import("./db.js");
    ensureGraphTables();
    const db = getDb();
    
    const lastProcessed = (db.prepare(
      "SELECT value FROM meta WHERE key = 'kg_llm_last_chunk_id'"
    ).get() as { value: string } | undefined)?.value || "0";
    
    const chunks = db.prepare(
      "SELECT id, chunk_text, chunk_type FROM chunks WHERE id > ? ORDER BY id ASC LIMIT ?"
    ).all(parseInt(lastProcessed), parseInt(opts.limit)) as Array<{
      id: number; chunk_text: string; chunk_type: string;
    }>;
    
    if (chunks.length === 0) { console.log("[KG-LLM] No new chunks"); closeDb(); return; }
    
    let totalE = 0, totalR = 0, maxId = parseInt(lastProcessed);
    let fastPathChunks = 0, llmChunks = 0;
    for (const chunk of chunks) {
      const result = await extractWithLLM(chunk.chunk_text);
      if (result.fast_path_used) fastPathChunks++; else llmChunks++;
      for (const e of result.entities) {
        // Fase 1.7a: ontology attributes — merge JSON ao upsert.
        const newAttrs = e.attributes || null;
        const existing = db.prepare(
          "SELECT id, attributes FROM kg_entities WHERE name = ? AND entity_type = ?"
        ).get(e.name, e.type) as { id: number; attributes: string | null } | undefined;

        if (existing) {
          // Merge: preserva attributes existentes; chaves novas sobrescrevem.
          let merged: Record<string, unknown> = {};
          try {
            merged = existing.attributes ? JSON.parse(existing.attributes) as Record<string, unknown> : {};
          } catch { merged = {}; }
          if (newAttrs) merged = { ...merged, ...newAttrs };
          const mergedJson = Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
          db.prepare(
            "UPDATE kg_entities SET mention_count = mention_count + 1, last_seen = datetime('now'), attributes = ? WHERE id = ?"
          ).run(mergedJson, existing.id);
        } else {
          db.prepare(
            "INSERT INTO kg_entities (name, entity_type, attributes) VALUES (?, ?, ?)"
          ).run(e.name, e.type, newAttrs ? JSON.stringify(newAttrs) : null);
        }
        totalE++;
      }
      for (const r of result.relations) {
        const src = db.prepare("SELECT id FROM kg_entities WHERE name = ?").get(r.source) as { id: number } | undefined;
        const tgt = db.prepare("SELECT id FROM kg_entities WHERE name = ?").get(r.target) as { id: number } | undefined;
        if (src && tgt) {
          db.prepare(
            "INSERT OR IGNORE INTO kg_relations (source_entity_id, relation_type, target_entity_id, evidence_chunk_id) VALUES (?, ?, ?, ?)"
          ).run(src.id, r.relation, tgt.id, chunk.id);
          totalR++;
        }
      }
      maxId = Math.max(maxId, chunk.id);
      process.stdout.write(`\r[KG-LLM] ${chunks.indexOf(chunk) + 1}/${chunks.length} — ${totalE}E ${totalR}R (fast:${fastPathChunks} llm:${llmChunks})`);
    }

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('kg_llm_last_chunk_id', ?)").run(String(maxId));
    const savedPct = chunks.length > 0 ? Math.round((fastPathChunks / chunks.length) * 100) : 0;
    console.log(`\n[KG-LLM] Done: ${totalE} entities, ${totalR} relations from ${chunks.length} chunks · fast-path ${savedPct}% (${fastPathChunks}/${chunks.length}) — Gemini calls saved`);
    closeDb();
  });

// ─── Cross-Agent Intelligence v2 ─────────────────────────────────────────────

program
  .command("agent-profiles")
  .description("Show expertise profiles for all agents")
  .action(async () => {
    const { profileAllAgents, formatProfiles } = await import("./cross-agent-v2.js");
    console.log(formatProfiles(profileAllAgents()));
  });

program
  .command("agent-insights")
  .description("Pull lessons and decisions from all agents")
  .option("--from <agent>", "Pull from specific agent")
  .option("-n, --limit <n>", "Results per agent", "5")
  .action(async (opts: { from?: string; limit: string }) => {
    const { pullInsightsFrom, pullAllInsights } = await import("./cross-agent-v2.js");
    const limit = parseInt(opts.limit);
    const insights = opts.from
      ? pullInsightsFrom(opts.from, ["decision", "lesson"], limit)
      : pullAllInsights(undefined, ["decision", "lesson"], limit);
    
    if (insights.length === 0) { console.log("No insights found."); return; }
    for (const i of insights) {
      const preview = i.text.substring(0, 200).replace(/\n/g, " ");
      console.log(`[@${i.agent}] [${i.type}] ${i.date || "?"}`);
      console.log(`  ${preview}...\n`);
    }
  });

program
  .command("cross-kg")
  .description("Merge and display knowledge graphs across all agents")
  .action(async () => {
    const { mergeCrossKnowledgeGraphs, formatCrossKG } = await import("./cross-agent-v2.js");
    console.log(formatCrossKG(mergeCrossKnowledgeGraphs()));
  });

program
  .command("kg-path <from> <to>")
  .description("Find relationship path between two entities")
  .action(async (from: string, to: string) => {
    const { findPath, formatPath } = await import("./cross-agent-v2.js");
    console.log(formatPath(findPath(from, to)));
  });


// ─── Churn detection (item 2 plano Cipher simbiose 2026-06-05) ───────────────

program
  .command("churn")
  .description("Detecta re-decisões (knowledge gaps) por similaridade de embedding — read-only, $0")
  .requiredOption("--changed-since <date>", "ISO date: só chunks criados desde essa data")
  .option("--threshold <n>", "similaridade cosseno mínima", "0.80")
  .option("--types <csv>", "filtro de chunk_type dos chunks novos (default: sem filtro)")
  .option("--max-new <n>", "cap de chunks novos processados", "2000")
  .option("--report <path>", "grava report markdown nesse path")
  .option("--json", "output JSON em vez de markdown", false)
  .action(async (opts: { changedSince: string; threshold: string; types?: string; maxNew: string; report?: string; json: boolean }) => {
    const { detectChurn, churnReportMd } = await import("./churn.js");
    const db = getDb();
    const pairs = detectChurn(db, {
      since: opts.changedSince,
      threshold: parseFloat(opts.threshold),
      types: opts.types ? opts.types.split(",").map((s) => s.trim()) : undefined,
      maxNew: parseInt(opts.maxNew, 10),
    });
    if (opts.json) console.log(JSON.stringify(pairs, null, 2));
    else console.log(churnReportMd(pairs, opts.changedSince));
    if (opts.report) {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(opts.report), { recursive: true });
      writeFileSync(opts.report, churnReportMd(pairs, opts.changedSince));
      console.log(`[CHURN] report: ${opts.report}`);
    }
    closeDb();
  });

// ─── Session distill ──────────────────────────────────────────────────────────

program
  .command("session-distill")
  .description("Distill memories from historical agent session JSONL files")
  .option("--agents <ids>", "Comma-separated agent ids (default: nox,forge,atlas,cipher,boris,lex)")
  .option("--lookback-days <n>", "Days to look back (default: 30)", "30")
  .option("--max-sessions <n>", "Max sessions per run (default: 50)", "50")
  .option("--dry-run", "Show what would be processed without ingesting", false)
  .action(async (opts: { agents?: string; lookbackDays: string; maxSessions: string; dryRun: boolean }) => {
    const agentIds = opts.agents ? opts.agents.split(",").map((s) => s.trim()) : undefined;
    const result = await distillSessions({
      agentIds,
      lookbackDays: parseInt(opts.lookbackDays, 10),
      maxSessionsPerRun: parseInt(opts.maxSessions, 10),
      dryRun: opts.dryRun,
    });
    console.log("\nSummary:");
    console.log(`  Sessions processed:   ${result.processedSessions}`);
    console.log(`  Sessions skipped:     ${result.skippedSessions}`);
    console.log(`  Messages read:        ${result.messagesRead}`);
    console.log(`  Memories extracted:   ${result.memoriesExtracted}`);
    console.log(`  Memories deduped:     ${result.memoriesDeduplicated}`);
    console.log(`  Memories ingested:    ${result.memoriesIngested}`);
    closeDb();
  });

// ─── Noise filter ─────────────────────────────────────────────────────────────

const noiseCmd = program.command("noise").description("Noise filter management");

noiseCmd
  .command("stats")
  .description("Show noise filter stats")
  .action(() => {
    const db = getDb();
    const stats = getNoiseStats(db);
    console.log("Noise filter:");
    console.log(`  Built-in prototypes: ${stats.builtin}`);
    console.log(`  Learned prototypes:  ${stats.learned}`);
    console.log(`  Total hits:          ${stats.totalHits}`);
    closeDb();
  });

noiseCmd
  .command("check <text>")
  .description("Check if a text would be filtered as noise")
  .action((text: string) => {
    const db = getDb();
    const result = isNoise(text, db);
    console.log(result ? `[NOISE] Would be filtered: "${text}"` : `[OK] Would pass: "${text}"`);
    closeDb();
  });

// ─── Tier management ──────────────────────────────────────────────────────────

const tiersCmd = program.command("tiers").description("Manage memory tiers (core/working/peripheral)");

tiersCmd
  .command("stats")
  .description("Show chunk distribution by tier")
  .action(() => {
    const db = getDb();
    const stats = getTierStats(db);
    const total = Object.values(stats).reduce((a, b) => a + b, 0) || 1;
    console.log("Tier distribution:");
    console.log(`  🔵 core:       ${stats.core ?? 0} (${((stats.core ?? 0) / total * 100).toFixed(1)}%)`);
    console.log(`  🟡 working:    ${stats.working ?? 0} (${((stats.working ?? 0) / total * 100).toFixed(1)}%)`);
    console.log(`  ⬜ peripheral: ${stats.peripheral ?? 0} (${((stats.peripheral ?? 0) / total * 100).toFixed(1)}%)`);
    closeDb();
  });

tiersCmd
  .command("evaluate")
  .description("Evaluate and adjust tiers based on access patterns")
  .action(() => {
    const db = getDb();
    const result = evaluateTiers(db);
    console.log(`Tier evaluation complete:`);
    console.log(`  Promoted: ${result.promoted} chunks`);
    console.log(`  Demoted:  ${result.demoted} chunks`);
    const stats = getTierStats(db);
    console.log(`\nCurrent distribution:`);
    console.log(`  🔵 core:       ${stats.core ?? 0}`);
    console.log(`  🟡 working:    ${stats.working ?? 0}`);
    console.log(`  ⬜ peripheral: ${stats.peripheral ?? 0}`);
    closeDb();
  });

// ─── Watch mode ───────────────────────────────────────────────────────────────

program
  .command("watch")
  .description("Watch memory directories and auto-ingest on change (real-time)")
  .option("-v, --verbose", "Show skipped directories", false)
  .option("--allow-prod", "Skip large-DB ingest guard (required for prod ops, see CLAUDE.md §6)")
  .action((opts: { verbose: boolean; allowProd?: boolean }) => {
    // audit #20 fix — Large-DB ingest guard at watcher boot. Watcher ingests via
    // ingestFile() in a long-running loop; if it accidentally points at prod DB
    // without explicit opt-in, abort before mutating. Override: --allow-prod or
    // NOX_ALLOW_PROD_INGEST=1. (Watcher is INSERT-only via ingestFile so no
    // withOpAudit wrap is needed — defense is at-boot gate, not per-write.)
    if (opts.allowProd) {
      process.env.NOX_ALLOW_PROD_INGEST = "1";
    }
    checkLargeDbIngestGuard(getDb(), "watch");
    startWatch(opts.verbose);
    // Keep process alive
    process.on("SIGINT", () => {
      console.log("\n[WATCH] Stopped.");
      closeDb();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      closeDb();
      process.exit(0);
    });
  });


// ─── Reflect (deep KG synthesis) ──────────────────────────────────────────────

program
  .command("reflect <question>")
  .description("Deep synthesis over memory + KG — reasons over evidence, not just retrieves")
  .option("--no-cache", "Force fresh synthesis")
  .action(async (question: string, opts: { cache?: boolean }) => {
    const { reflect, formatReflect } = await import("./reflect.js");
    const result = await reflect(question, { noCache: !opts.cache });
    console.log(formatReflect(result));
  });

// ─── Crystallize (save procedure) ─────────────────────────────────────────────

program
  .command("crystallize")
  .description("Save a multi-step procedure as a reusable skill")
  .requiredOption("--title <title>", "Procedure title")
  .option("--agent <agent>", "Origin agent", "system")
  .option("--tags <tags>", "Comma-separated tags")
  .action(async (opts: { title: string; agent: string; tags?: string }) => {
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("Enter steps (one per line, empty line to finish):");
    const steps: string[] = [];
    const askStep = (): Promise<void> => new Promise((resolve) => {
      rl.question(`  Step ${steps.length + 1}: `, (line: string) => {
        if (line.trim() === "") { rl.close(); resolve(); return; }
        steps.push(line.trim());
        askStep().then(resolve);
      });
    });
    await askStep();
    if (steps.length === 0) { console.log("No steps — aborted."); return; }
    const { crystallize } = await import("./crystallize.js");
    const id = await crystallize({ title: opts.title, steps, agent: opts.agent, tags: opts.tags?.split(",").map(t => t.trim()) || [] });
    console.log(`✅ Crystallized as chunk #${id}: "${opts.title}" (${steps.length} steps)`);
  });

program
  .command("crystallize-validate <id>")
  .description("Record a validation run for a procedure (tracks outcome + agent + notes)")
  .option("--outcome <outcome>", "success | failure | partial", "success")
  .option("--agent <agent>", "Agent running the validation", "system")
  .option("--notes <notes>", "Free-form notes about the run")
  .action(async (id: string, opts: { outcome: string; agent: string; notes?: string }) => {
    const { validateProcedure } = await import("./crystallize.js");
    const outcome = (["success","failure","partial"].includes(opts.outcome) ? opts.outcome : "success") as "success" | "failure" | "partial";
    validateProcedure(parseInt(id, 10), { outcome, agent: opts.agent, notes: opts.notes });
    console.log(`✅ Procedure #${id} validation recorded: outcome=${outcome} agent=${opts.agent}`);
  });

program
  .command("backfill-source-type")
  .description("Backfill source_type column from source_file path patterns (98% NULL → mapped)")
  .option("--dry-run", "Preview distribution, no mutation", false)
  .option("--limit <n>", "Process at most N chunks")
  .option("--batch-size <n>", "Transaction size (default 2000)")
  .option("--force", "Overwrite existing values (preserves 'external')", false)
  .action(async (opts: { dryRun: boolean; limit?: string; batchSize?: string; force: boolean }) => {
    const { backfillSourceType, formatResult } = await import("./backfill-source-type.js");
    const result = await backfillSourceType({
      dryRun: opts.dryRun,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      batchSize: opts.batchSize ? parseInt(opts.batchSize, 10) : undefined,
      force: opts.force,
    });
    console.log(formatResult(result));
    closeDb();
  });

program.parse();
