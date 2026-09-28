#!/usr/bin/env node
/**
 * nox-mem MCP Server — exposes memory tools via Model Context Protocol (stdio)
 * Tools: search, stats, primer, ingest
 */
import { getDb, closeDb } from "./db.js";
import { search, searchHybrid, formatResults } from "./search.js";
import { crossSearch, formatCrossResults, getCrossStats } from "./cross-search.js";
import { getMetrics } from "./metrics.js";
import { buildGraph, getGraphStats, formatEntityQuery, upsertDecision, getCurrentDecision, getDecisionHistory, listDecisions } from "./knowledge-graph.js";
import { profileAllAgents, formatProfiles, mergeCrossKnowledgeGraphs, formatCrossKG, findPath, formatPath } from "./cross-agent-v2.js";
import { selfImprove } from "./self-improve.js";
import { updateSessionState } from "./session-update.js";
import { getStats } from "./stats.js";
import { primer } from "./primer.js";
import { createInterface } from "readline";
import { VERSION } from "./version.js";
import { parseTemporalFilter } from "./lib/dates.js";

const SERVER_INFO = {
  name: "nox-mem",
  version: VERSION,
};

const TOOLS = [
  {
    name: "nox_mem_search",
    description: "Search nox-mem memory using FTS5 full-text search with BM25 ranking, type boosting, and recency scoring",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (natural language or keywords)" },
        limit: { type: "number", description: "Max results (default 5, max 20)", default: 5 },
        as_of: { type: "string", description: "Time-travel: only chunks that existed at this date (ISO 8601 like 2026-05-01, or relative like 7d, 2h, 1w)" },
        changed_since: { type: "string", description: "Recency window: only chunks created or updated after this date (ISO 8601 or relative)" },
      },
      required: ["query"],
    },
  },
  {
    name: "nox_mem_stats",
    description: "Get nox-mem database statistics: chunk counts by type, consolidation status, DB size",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nox_mem_primer",
    description: "Generate context recovery summary (~500 tokens): active task, recent decisions, today's notes, pending items",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nox_mem_ingest",
    description: "Index a markdown or JSON file into nox-mem memory",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to .md or .json file to ingest" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "nox_mem_cross_search",
    description: "Search across ALL agent memory databases (workspace + nox/atlas/boris/cipher/forge/lex)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 10)", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "nox_mem_cross_stats",
    description: "Show chunk counts across all agent databases",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nox_mem_metrics",
    description: "Show daily observability metrics (chunks added, searches, dedup, consolidation success/fail)",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Days of history (default 7)", default: 7 },
      },
    },
  },
  {
    name: "nox_mem_kg_build",
    description: "Build knowledge graph from memory chunks (extracts people, projects, agents and their relationships)",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max chunks to process (default 200)", default: 200 },
      },
    },
  },
  {
    name: "nox_mem_kg_query",
    description: "Query knowledge graph for an entity — shows relations, co-occurrences, and mention count",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Entity name to query (person, project, or agent)" },
      },
      required: ["entity"],
    },
  },
  {
    name: "nox_mem_kg_stats",
    description: "Show knowledge graph statistics: entity counts by type, top entities, relation counts",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nox_mem_self_improve",
    description: "Run agent self-improvement analysis: finds contradictions between decisions and lessons, recurring patterns needing rules, SOUL.md gaps, and agent strengths",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nox_mem_agent_profiles",
    description: "Show expertise profiles for all agents (chunk counts, strengths, top types)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nox_mem_cross_kg",
    description: "Merged knowledge graph across all agents — shows shared entities and cross-agent mentions",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nox_mem_kg_path",
    description: "Find relationship path between two entities in the knowledge graph",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start entity name" },
        to: { type: "string", description: "End entity name" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "nox_mem_reflect",
    description: "Deep synthesis over memory + knowledge graph. Slower than search (5-15s) but produces reasoned insights with cited sources. Use for questions that need connecting dots across multiple topics.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Question to reflect on" },
        no_cache: { type: "boolean", description: "Force fresh synthesis" },
      },
      required: ["question"],
    },
  },
  {
    name: "nox_mem_decision_set",
    description: "Set/update a versioned decision. Stores full history — every call creates a new version. Use for technical decisions, policies, or operational rules that may evolve.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Stable decision key (slug-like, e.g. 'gateway-restart-policy')" },
        content: { type: "string", description: "Decision content (the rule/policy/choice being recorded)" },
        author: { type: "string", description: "Author name (default: 'system')" },
      },
      required: ["key", "content"],
    },
  },
  {
    name: "nox_mem_decision_get",
    description: "Get the current (latest version) value of a decision by key. Returns null if not found.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Decision key to look up" },
      },
      required: ["key"],
    },
  },
  {
    name: "nox_mem_decision_list",
    description: "List all current decisions (latest version of each). Returns key, version, timestamp, and content preview.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nox_mem_decision_history",
    description: "Show full version history of a decision — all versions with timestamps and supersession info.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Decision key to fetch history for" },
      },
      required: ["key"],
    },
  },
  {
    name: "nox_mem_crystallize",
    description: "Save a multi-step procedure as a reusable skill. Use after completing complex tasks (5+ steps) that others might need to repeat.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Procedure title" },
        steps: { type: "array", items: { type: "string" }, description: "List of steps" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for searchability" },
      },
      required: ["title", "steps"],
    },
  }

];

function sendResponse(id: number | string, result: unknown): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function sendError(id: number | string | null, code: number, message: string): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

async function handleRequest(req: { id: number | string; method: string; params?: Record<string, unknown> }): Promise<void> {
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      sendResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;

    case "notifications/initialized":
      break;

    case "tools/list":
      sendResponse(id, { tools: TOOLS });
      break;

    case "tools/call": {
      const toolName = (params as Record<string, unknown>)?.name as string;
      const args = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<string, unknown>;

      try {
        let text: string;

        switch (toolName) {
          case "nox_mem_search": {
            const query = args.query as string;
            const limit = Math.min(Number(args.limit) || 5, 20);
            // Parse errors throw and reach the client as isError — never an unfiltered search.
            const filter = parseTemporalFilter({
              asOf: args.as_of as string | undefined,
              changedSince: args.changed_since as string | undefined,
            });
            const results = await searchHybrid(query, limit, true, filter);
            text = formatResults(results);
            break;
          }
          case "nox_mem_stats":
            text = getStats();
            break;
          
          case "nox_mem_cross_search": {
            const query = args.query as string;
            const limit = Math.min(Number(args.limit) || 10, 30);
            const results = crossSearch(query, limit);
            text = formatCrossResults(results);
            break;
          }
          case "nox_mem_cross_stats":
            text = getCrossStats();
            break;
          case "nox_mem_metrics": {
            const days = Number(args.days) || 7;
            text = getMetrics(days);
            break;
          }
          case "nox_mem_primer":
            text = primer();
            break;
          case "nox_mem_ingest": {
            const filePath = args.file_path as string;
            const { routeIngest } = await import("./lib/ingest-router.js");
            routeIngest(filePath);
            text = "Ingested: " + filePath;
            break;
          }
                    case "nox_mem_kg_build": {
            const limit = Number(args.limit) || 200;
            const result = buildGraph(limit);
            text = "Knowledge graph updated: " + result.entities + " entities processed, " + result.relations + " relations found.";
            break;
          }
          case "nox_mem_kg_query": {
            const entity = args.entity as string;
            text = formatEntityQuery(entity);
            break;
          }
          case "nox_mem_kg_stats":
            text = getGraphStats();
            break;
          case "nox_mem_reflect": {
            const { reflect, formatReflect } = await import("./reflect.js");
            const result = await reflect(args.question as string, { noCache: args.no_cache as boolean });
            text = formatReflect(result);
            break;
          }
          case "nox_mem_crystallize": {
            const { crystallize } = await import("./crystallize.js");
            const id = await crystallize({
              title: args.title as string,
              steps: args.steps as string[],
              tags: (args.tags as string[]) || [],
            });
            text = `Crystallized as chunk #${id}: "${args.title}" (${(args.steps as string[]).length} steps)`;
            break;
          }
          case "nox_mem_self_improve":
            text = await selfImprove();
            break;
          case "nox_mem_agent_profiles": {
            const profiles = profileAllAgents();
            text = profiles.length === 0 ? "No agent profiles available" : formatProfiles(profiles);
            break;
          }
          case "nox_mem_cross_kg": {
            const result = mergeCrossKnowledgeGraphs();
            text = formatCrossKG(result);
            break;
          }
          case "nox_mem_kg_path": {
            const from = args.from as string;
            const to = args.to as string;
            const path = findPath(from, to);
            text = formatPath(path);
            break;
          }
          case "nox_mem_decision_set": {
            const key = args.key as string;
            const content = args.content as string;
            const author = (args.author as string) || "system";
            const version = upsertDecision(key, content, undefined, author);
            text = `Decision "${key}" → v${version}`;
            break;
          }
          case "nox_mem_decision_get": {
            const key = args.key as string;
            const current = getCurrentDecision(key);
            text = current ?? `Decision "${key}" not found`;
            break;
          }
          case "nox_mem_decision_list": {
            const decisions = listDecisions();
            if (decisions.length === 0) {
              text = "No decisions recorded";
            } else {
              text = decisions
                .map((d) => `[${d.decision_key}] v${d.version} (${d.created_at})\n  ${d.content.substring(0, 200)}`)
                .join("\n\n");
            }
            break;
          }
          case "nox_mem_decision_history": {
            const key = args.key as string;
            const history = getDecisionHistory(key);
            if (history.length === 0) {
              text = `No history for "${key}"`;
            } else {
              text = history
                .map((h) => {
                  const flag = h.is_current ? " [CURRENT]" : ` [superseded ${h.superseded_at}]`;
                  return `v${h.version}${flag} — ${h.created_at}\n  ${h.content}`;
                })
                .join("\n\n");
            }
            break;
          }
          default:
            sendError(id, -32601, "Unknown tool: " + toolName);
            return;
        }

        sendResponse(id, {
          content: [{ type: "text", text }],
        });
      } catch (err) {
        sendResponse(id, {
          content: [{ type: "text", text: "Error: " + (err as Error).message }],
          isError: true,
        });
      }
      break;
    }

    default:
      if (!method.startsWith("notifications/")) {
        sendError(id, -32601, "Method not found: " + method);
      }
  }
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  try {
    const req = JSON.parse(line);
    handleRequest(req);
  } catch {
    sendError(null, -32700, "Parse error");
  }
});

rl.on("close", () => {
  closeDb();
  process.exit(0);
});

process.on("SIGINT", () => {
  closeDb();
  process.exit(0);
});
