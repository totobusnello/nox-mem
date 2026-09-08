/**
 * session-distill.ts — Pipeline de destilação de sessões históricas
 *
 * Extrai decisões, preferências e contexto de conversas armazenadas
 * nos arquivos JSONL de sessão dos agentes OpenClaw.
 *
 * Fluxo:
 *   1. scan: lista sessões JSONL por agente, filtra já processadas
 *   2. chunk: extrai blocos user+assistant, aplica noise filter
 *   3. distill: envia para Gemini Flash (ou Groq fallback) → memories
 *   4. import: dedup semântico + ingest como chunk_type="distilled"
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { getDb } from "./db.js";
import { isNoise } from "./noise-filter.js";
import { isDuplicate } from "./dedup.js";
import { incrementMetric } from "./metrics.js";
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

function listUnprocessedSessions(
  db: ReturnType<typeof getDb>,
  agentIds: string[],
  lookbackDays: number
): Array<{ agentId: string; sessionFile: string; sessionKey: string }> {
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const sessions: Array<{ agentId: string; sessionFile: string; sessionKey: string }> = [];

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
      try {
        const { mtimeMs } = statSync(filePath);
        if (new Date(mtimeMs).toISOString() < cutoff) continue;
      } catch {
        continue;
      }

      sessions.push({ agentId, sessionFile: filePath, sessionKey });
    }
    }
  }

  return sessions;
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

async function distillWithGemini(conversationBlock: string): Promise<DistilledMemory[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];

  try {
    const response = await fetch(
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

    if (!response.ok) return [];
    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return [];

    const parsed = JSON.parse(text) as DistillResult;
    return (parsed.memories ?? []).filter((m) => m.importance >= 0.5);
  } catch {
    return [];
  }
}

async function distillWithGroq(conversationBlock: string): Promise<DistilledMemory[]> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return [];

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: DISTILL_SYSTEM },
          { role: "user", content: "Conversa:\n" + conversationBlock }
        ],
        temperature: 0.1,
        max_tokens: 1024,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!response.ok) return [];
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return [];

    const parsed = JSON.parse(text) as DistillResult;
    return (parsed.memories ?? []).filter((m) => m.importance >= 0.5);
  } catch {
    return [];
  }
}

async function distillBlock(conversationBlock: string): Promise<DistilledMemory[]> {
  // Try Gemini first (cheaper, faster)
  const geminiResult = await distillWithGemini(conversationBlock);
  if (geminiResult.length > 0) return geminiResult;

  // Fallback to Groq
  return await distillWithGroq(conversationBlock);
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
  };

  const sessions = listUnprocessedSessions(db, agentIds, lookbackDays).slice(0, maxSessionsPerRun);

  if (sessions.length === 0) {
    console.log("[DISTILL] No unprocessed sessions found");
    return stats;
  }

  console.log(`[DISTILL] Processing ${sessions.length} sessions (lookback: ${lookbackDays}d)`);

  // Group messages into blocks of ~2000 chars for the LLM
  const BLOCK_SIZE = 2000;

  for (const { agentId, sessionFile, sessionKey } of sessions) {
    const messages = extractMessages(sessionFile);
    if (messages.length < 3) {
      // Skip tiny sessions (just session init events)
      stats.skippedSessions++;
      if (!dryRun) {
        db.prepare(
          "INSERT OR IGNORE INTO session_distill_log (session_key, agent, chunks_extracted, message_count) VALUES (?, ?, 0, ?)"
        ).run(sessionKey, agentId, messages.length);
      }
      continue;
    }

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

      const memories = await distillBlock(block);
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

        db.prepare(`
          INSERT INTO chunks (source_file, chunk_text, chunk_type, source_date, metadata, tier, importance)
          VALUES (?, ?, ?, ?, ?, ?, ?)
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

  console.log(`[DISTILL] Done: ${stats.processedSessions} sessions, ${stats.memoriesIngested} ingested, ${stats.memoriesDeduplicated} deduped`);
  return stats;
}
