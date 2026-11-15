/**
 * session-distill.ts — Pipeline de destilação de sessões históricas
 *
 * Extrai decisões, preferências e contexto de conversas armazenadas
 * nos arquivos JSONL de sessão dos agentes OpenClaw.
 *
 * Fluxo:
 *   1. scan: lista sessões JSONL por agente, filtra já processadas
 *   2. chunk: extrai blocos user+assistant, aplica noise filter
 *   3. distill: envia para Gemini Flash-Lite → memories
 *   4. import: dedup semântico + ingest como chunk_type="distilled"
 */

import { readdirSync, readFileSync, existsSync, statSync, appendFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { getDb } from "./db.js";
import { isNoise } from "./noise-filter.js";
import { isDuplicate } from "./dedup.js";
import { incrementMetric } from "./metrics.js";

// One line of counts per real run, appended to the file named by NOX_DISTILL_OUTCOMES_PATH.
// Off when the variable is unset: the same counts already go to stdout, and a package should
// not write files nobody asked for. Set it when the distiller runs under a scheduler that keeps
// no stdout (the case that motivated it: a cron agent whose output nothing kept). Counts and
// agent ids only, no block text, no memory text. No mkdir: a recursive mkdirSync under /proc
// spun forever in a smoke test; a missing directory fails the append at once and only warns.
export function outcomesPath(): string | null {
  return process.env.NOX_DISTILL_OUTCOMES_PATH || null;
}
// tier-manager not imported here: distilled chunks use LLM-provided importance to determine tier
// (importance >= 0.8 → working, else peripheral) — more nuanced than static getInitialTier("distilled")

const WORKSPACE = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
// NOX_AGENTS_DIR: base dir where agent session sub-dirs live.
// Falls back to the OpenClaw layout (workspace/agents/).
// When the dir doesn't exist, listUnprocessedSessions() skips gracefully via existsSync.
const AGENTS_DIR = process.env.NOX_AGENTS_DIR ?? resolve(WORKSPACE, "agents");

// NOX_AGENTS: comma-separated list of agent names to distill sessions from.
// Standalone operators: set to "" or omit (no agent sessions to distill).
const DEFAULT_AGENTS: string[] = process.env.NOX_AGENTS
  ? process.env.NOX_AGENTS.split(",").map(s => s.trim()).filter(Boolean)
  : ["main", "nox", "forge", "atlas", "cipher", "boris", "lex"];

// NOX_CLAUDE_PROJECTS_DIR: where the Claude CLI keeps session transcripts.
// Agents that run under the Claude CLI no longer write to <agents>/<id>/sessions/;
// the CLI stores each session under <projectsDir>/<slug>, where <slug> is the
// session cwd with "/" and "." replaced by "-" (/root/.openclaw/workspace ->
// -root--openclaw-workspace). Both locations are read: the legacy dir still
// holds sessions predating the switch.
//
// When unset, the CLI home is DISCOVERED rather than assumed: ~/.claude is the
// default, but a team account uses ~/.claude-<team>, and a host can have several
// at once (one deployment had three, and reading only one silently skipped the
// busiest). Discovery also avoids requiring an env var that a long-lived daemon
// would only pick up after a restart.
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export function claudeProjectsDirs(): string[] {
  const explicit = process.env.NOX_CLAUDE_PROJECTS_DIR;
  if (explicit) return [explicit];
  const home = homedir();
  try {
    return readdirSync(home)
      .filter((d) => d === ".claude" || d.startsWith(".claude-"))
      .map((d) => resolve(home, d, "projects"))
      .filter((d) => existsSync(d));
  } catch {
    return [];
  }
}

export function sessionDirsFor(agentId: string): string[] {
  // "main" runs in the workspace root; every other agent in agents/<id>.
  const cwd = agentId === "main" ? WORKSPACE : resolve(AGENTS_DIR, agentId);
  const slug = claudeProjectSlug(cwd);
  return [
    resolve(AGENTS_DIR, agentId, "sessions"),
    ...claudeProjectsDirs().map((d) => resolve(d, slug)),
  ];
}

interface SessionEvent {
  type: string;
  timestamp?: string;
  message?: {
    role: "user" | "assistant";
    content: string | Array<{ type: string; text?: string }>;
  };
}

interface DistilledMemory {
  text: string;
  category: "decision" | "preference" | "lesson" | "context" | "project";
  importance: number;
}

interface DistillResult {
  memories: DistilledMemory[];
}

// ─── Schema ──────────────────────────────────────────────────────────────────

export function ensureDistillTable(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_distill_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL UNIQUE,
      agent TEXT NOT NULL,
      processed_at TEXT DEFAULT (datetime('now')),
      chunks_extracted INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0
    );
  `);
}

// ─── Session scanning ────────────────────────────────────────────────────────

export interface PendingSession {
  agentId: string;
  sessionFile: string;
  sessionKey: string;
  mtimeMs: number;
}

export function listUnprocessedSessions(
  db: ReturnType<typeof getDb>,
  agentIds: string[],
  lookbackDays: number
): PendingSession[] {
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const sessions: PendingSession[] = [];

  for (const agentId of agentIds) {
    for (const sessionsDir of sessionDirsFor(agentId)) {
    if (!existsSync(sessionsDir)) continue;

    let files: string[];
    try {
      files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionKey = `${agentId}:${file.replace(".jsonl", "")}`;

      // Skip already processed
      const already = db.prepare(
        "SELECT id FROM session_distill_log WHERE session_key = ?"
      ).get(sessionKey);
      if (already) continue;

      // Check file modification time against lookback
      const filePath = resolve(sessionsDir, file);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
        if (new Date(mtimeMs).toISOString() < cutoff) continue;
      } catch {
        continue;
      }

      sessions.push({ agentId, sessionFile: filePath, sessionKey, mtimeMs });
    }
    }
  }

  // Oldest first. The caller cuts this list at maxSessionsPerRun; in readdir order, agent by
  // agent, which sessions ran under a backlog was arbitrary, and the ones closest to leaving the
  // lookback could wait behind new ones until they aged out (measured on one deployment: a
  // backlog of 118 sessions after a transcript address change). Oldest first, a backlog drains
  // before any of it expires.
  sessions.sort((a, b) => a.mtimeMs - b.mtimeMs || a.sessionKey.localeCompare(b.sessionKey));
  return sessions;
}

/** A session with fewer messages than this holds only init events: nothing to distill. */
export const MIN_SESSION_MESSAGES = 3;

/**
 * Walks `pending` in order and splits it into the sessions to distill now (at most `max`, each
 * with its messages already read) and the short ones, which are logged as done without counting
 * against `max`. Reading stops once `max` sessions are taken; `left` is how many were not read.
 *
 * The budget used to be cut before the short sessions were set aside, so they spent it. Measured
 * on one deployment (nightly run, 1-day lookback, max 50): 43 to 48 of the 50 sessions taken each
 * night since 2026-11-10 were short, 2 to 7 were distilled, and the ~35 left over aged out of the
 * lookback before the next run.
 */
export function partitionPending<M>(
  pending: readonly PendingSession[],
  max: number,
  read: (s: PendingSession) => M[]
): { take: Array<{ session: PendingSession; messages: M[] }>; short: Array<{ session: PendingSession; count: number }>; left: number } {
  const take: Array<{ session: PendingSession; messages: M[] }> = [];
  const short: Array<{ session: PendingSession; count: number }> = [];
  let i = 0;
  for (; i < pending.length && take.length < max; i++) {
    const messages = read(pending[i]);
    if (messages.length < MIN_SESSION_MESSAGES) short.push({ session: pending[i], count: messages.length });
    else take.push({ session: pending[i], messages });
  }
  return { take, short, left: pending.length - i };
}

// ─── Message extraction ───────────────────────────────────────────────────────

export function extractMessages(sessionFile: string): Array<{ role: string; text: string; timestamp: string }> {
  const messages: Array<{ role: string; text: string; timestamp: string }> = [];

  let content: string;
  try {
    content = readFileSync(sessionFile, "utf-8");
  } catch {
    return messages;
  }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let event: SessionEvent;
    try {
      event = JSON.parse(line) as SessionEvent;
    } catch {
      continue;
    }

    // Two transcript schemas in the wild: the OpenClaw one tags events as
    // type "message", while Claude CLI transcripts tag them "user"/"assistant".
    // Accepting only the former dropped every line of the latter with no error
    // and no log — measured 0 lines of type "message" in a current transcript.
    if (!event.message) continue;
    if (
      event.type !== "message" &&
      event.type !== "user" &&
      event.type !== "assistant"
    )
      continue;
    const { role, content: contentParts } = event.message;
    if (role !== "user" && role !== "assistant") continue;

    // Extract text from content parts (may be string or array)
    const text = typeof contentParts === "string"
      ? contentParts.trim()
      : Array.isArray(contentParts)
        ? contentParts
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text!)
            .join("\n")
            .trim()
        : "";

    if (!text) continue;

    // Skip system messages (cron triggers, heartbeats, metadata)
    // Filter both user prompts AND assistant responses to avoid distilling
    // HEARTBEAT loop sessions into thousands of near-dup memories (incident 2026-04-27).
    const isHeartbeatNoise =
      text.startsWith("[cron:") ||
      text.startsWith("HEARTBEAT") ||
      text.startsWith("The conversation history before this point") ||
      text.length < 5 ||
      /^heartbeat[_ ]ok\b/i.test(text);

    if (isHeartbeatNoise) continue;

    messages.push({ role, text, timestamp: event.timestamp ?? "" });
  }

  // Heuristic: if 70%+ of original turns were heartbeat-noise (now filtered),
  // the survivors are noisy paraphrases and not worth N^2 cosine dedup.
  // Caller checks messages.length < 3 already; here we add a stronger signal.
  return messages;
}

// ─── Distillation (LLM) ───────────────────────────────────────────────────────

const DISTILL_SYSTEM = `Você é um extrator de memória de conversas de IA.
Analise a conversa e extraia APENAS informações que merecem ser lembradas a longo prazo:
- Decisões tomadas pelo usuário ou pelo agente
- Preferências do usuário (como ele quer as coisas feitas)
- Lições aprendidas (erros, fixes, insights técnicos)
- Contexto de projetos relevantes (nomes, status, detalhes)

Ignore: cumprimentos, confirmações (ok, feito, obrigado), listas de tarefas genéricas, conteúdo repetido.

Responda APENAS com JSON válido:
{"memories": [{"text": "...", "category": "decision|preference|lesson|context|project", "importance": 0.0-1.0}]}

Importância: 0.9+ = crítico, 0.7-0.9 = importante, 0.5-0.7 = útil, <0.5 = ignorar.
Retorne [] se não houver nada relevante. Máximo 10 itens.`;

// Why a block yielded what it yielded. Before this, every failure returned [] exactly like "the
// model found nothing", and a fallback provider was tried whenever the result was empty. One
// deployment measured that fallback at 21 failures in 21 calls over two months, with its key
// present, while the summary line still read like a quiet night. What reaches the database is
// unchanged: any outcome other than "ok" contributes no memories.
export type DistillOutcome = "ok" | "empty" | "no_key" | "http_error" | "network_error" | "no_text" | "bad_json";

export async function distillWithGemini(conversationBlock: string): Promise<{ outcome: DistillOutcome; memories: DistilledMemory[] }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { outcome: "no_key", memories: [] };

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: DISTILL_SYSTEM + "\n\nConversa:\n" + conversationBlock }] }
          ],
          generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(30_000),
      }
    );
  } catch {
    return { outcome: "network_error", memories: [] };
  }
  if (!response.ok) return { outcome: "http_error", memories: [] };

  let text: string | undefined;
  try {
    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  } catch {
    return { outcome: "bad_json", memories: [] };
  }
  if (!text) return { outcome: "no_text", memories: [] };

  try {
    const parsed = JSON.parse(text) as DistillResult;
    const memories = (parsed.memories ?? []).filter((m) => m.importance >= 0.5);
    return { outcome: memories.length > 0 ? "ok" : "empty", memories };
  } catch {
    return { outcome: "bad_json", memories: [] };
  }
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

export interface DistillOptions {
  agentIds?: string[];
  maxSessionsPerRun?: number;
  lookbackDays?: number;
  dryRun?: boolean;
}

export interface DistillStats {
  processedSessions: number;
  skippedSessions: number;
  messagesRead: number;
  memoriesExtracted: number;
  memoriesDeduplicated: number;
  memoriesIngested: number;
  /** blocks per DistillOutcome (dry runs call no model and count nothing) */
  blockOutcomes: Partial<Record<DistillOutcome, number>>;
}

export function recordOutcomes(dryRun: boolean, agentIds: readonly string[], lookbackDays: number, pending: number, stats: DistillStats): void {
  const path = outcomesPath();
  if (dryRun || !path) return;
  try {
    appendFileSync(path, JSON.stringify({
      ts: new Date().toISOString(),
      agents: agentIds,
      lookback_days: lookbackDays,
      pending,
      processed: stats.processedSessions,
      skipped: stats.skippedSessions,
      extracted: stats.memoriesExtracted,
      deduped: stats.memoriesDeduplicated,
      ingested: stats.memoriesIngested,
      block_outcomes: stats.blockOutcomes,
    }) + "\n");
  } catch (e) {
    console.warn(`[DISTILL] could not record outcomes in ${path}: ${(e as Error).message}`);
  }
}

export async function distillSessions(options: DistillOptions = {}): Promise<DistillStats> {
  const {
    agentIds = DEFAULT_AGENTS,
    maxSessionsPerRun = 50,
    lookbackDays = 30,
    dryRun = false,
  } = options;

  const db = getDb();
  ensureDistillTable(db);

  const stats: DistillStats = {
    processedSessions: 0,
    skippedSessions: 0,
    messagesRead: 0,
    memoriesExtracted: 0,
    memoriesDeduplicated: 0,
    memoriesIngested: 0,
    blockOutcomes: {},
  };

  const pending = listUnprocessedSessions(db, agentIds, lookbackDays);
  const { take: sessions, short, left } = partitionPending(pending, maxSessionsPerRun, (s) => extractMessages(s.sessionFile));

  // Short sessions (just init events) are logged as done and do not count against the budget.
  for (const { session, count } of short) {
    stats.skippedSessions++;
    if (!dryRun) {
      db.prepare(
        "INSERT OR IGNORE INTO session_distill_log (session_key, agent, chunks_extracted, message_count) VALUES (?, ?, 0, ?)"
      ).run(session.sessionKey, session.agentId, count);
    }
  }
  if (left > 0) {
    // A full list on every run is the backlog signal: say how much is left, in the log a
    // scheduled job keeps, instead of leaving it to be found by a census.
    console.log(`[DISTILL] Backlog: ${pending.length} unprocessed in the lookback; ${short.length} short logged, taking the ${sessions.length} oldest; ${left} left for the next run`);
  }

  if (sessions.length === 0) {
    console.log(short.length ? `[DISTILL] ${short.length} short sessions logged, none to distill` : "[DISTILL] No unprocessed sessions found");
    recordOutcomes(dryRun, agentIds, lookbackDays, pending.length, stats);
    return stats;
  }

  console.log(`[DISTILL] Processing ${sessions.length} sessions (lookback: ${lookbackDays}d; ${short.length} short logged)`);

  // Group messages into blocks of ~2000 chars for the LLM
  const BLOCK_SIZE = 2000;

  for (const { session: { agentId, sessionKey }, messages } of sessions) {
    stats.messagesRead += messages.length;

    // Build conversation text, apply noise filter
    const conversationLines = messages
      .filter((m) => !isNoise(m.text, db))
      .map((m) => `[${m.role.toUpperCase()}]: ${m.text}`);

    if (conversationLines.length === 0) {
      stats.skippedSessions++;
      continue;
    }

    // Split into blocks
    const blocks: string[] = [];
    let currentBlock = "";
    for (const line of conversationLines) {
      if (currentBlock.length + line.length > BLOCK_SIZE && currentBlock) {
        blocks.push(currentBlock.trim());
        currentBlock = line + "\n";
      } else {
        currentBlock += line + "\n";
      }
    }
    if (currentBlock.trim()) blocks.push(currentBlock.trim());

    let sessionExtracted = 0;

    for (const block of blocks) {
      if (dryRun) {
        console.log(`[DRY RUN] Would distill block (${block.length} chars) from ${agentId}`);
        continue;
      }

      const { outcome, memories } = await distillWithGemini(block);
      stats.blockOutcomes[outcome] = (stats.blockOutcomes[outcome] ?? 0) + 1;
      stats.memoriesExtracted += memories.length;

      for (const memory of memories) {
        // Skip low importance
        if (memory.importance < 0.5) continue;

        // Dedup check
        let isDup = false;
        try {
          isDup = await isDuplicate(memory.text, sessionKey, "distilled");
        } catch {
          // Fallback: keyword check
          const existing = db.prepare(
            "SELECT id FROM chunks WHERE chunk_type = 'distilled' AND chunk_text LIKE ? LIMIT 1"
          ).get(`%${memory.text.substring(0, 50)}%`);
          isDup = !!existing;
        }

        if (isDup) {
          stats.memoriesDeduplicated++;
          continue;
        }

        // Ingest
        const chunkType = "distilled";
        const tier = memory.importance >= 0.8 ? "working" : "peripheral";
        const today = new Date().toISOString().split("T")[0];

        // retention_days = NULL is a choice, not an omission: distilled memory never decays
        // (salience reads NULL as never-decay, so recency stays 1.0). Measured 2026-10-27 before
        // choosing: a 90-day window would move a distilled chunk's median salience by -0.082 and
        // archive nothing, which does not justify moving the served ranking. Listed explicitly so
        // that no backfill or default can turn it into 90 days by accident (DECISIONS 27/10 #3).
        db.prepare(`
          INSERT INTO chunks (source_file, chunk_text, chunk_type, source_date, metadata, tier, importance, retention_days)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
          `sessions/${agentId}/${sessionKey}`,
          `[${memory.category}|${agentId}] ${memory.text}`,
          chunkType,
          today,
          JSON.stringify({ category: memory.category, source_agent: agentId, session: sessionKey }),
          tier,
          memory.importance
        );

        stats.memoriesIngested++;
        sessionExtracted++;
        incrementMetric("chunks_added");
      }

      // Rate limit: ~1 call/sec to Gemini
      await new Promise((r) => setTimeout(r, 1000));
    }

    stats.processedSessions++;

    if (!dryRun) {
      db.prepare(`
        INSERT OR REPLACE INTO session_distill_log
          (session_key, agent, chunks_extracted, message_count, processed_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(sessionKey, agentId, sessionExtracted, messages.length);
    }

    console.log(`[DISTILL] ${agentId} ${sessionKey.split(":")[1]?.substring(0, 8)} → ${sessionExtracted} memories`);
  }

  console.log(`[DISTILL] Blocks by outcome: ${JSON.stringify(stats.blockOutcomes)}`);
  console.log(`[DISTILL] Done: ${stats.processedSessions} sessions, ${stats.memoriesIngested} ingested, ${stats.memoriesDeduplicated} deduped`);
  recordOutcomes(dryRun, agentIds, lookbackDays, pending.length, stats);
  return stats;
}
