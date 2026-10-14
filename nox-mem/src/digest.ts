import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { getDb } from "./db.js";
import { workspaceRoot } from "./lib/workspace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = workspaceRoot();

// Primary: Gemini 2.5 Flash (large context, free tier, handles 50k+ tokens)
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent";

// Secondary: Groq (fast, but 12k TPM limit — fails on large digests)
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// Fallback: Ollama local (llama3.2:3b — limited ctx 4096 tokens, may fail with large prompts)
const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";
const OLLAMA_MODEL = "llama3.2:3b";

const PROMPT_PATH = resolve(__dirname, "..", "prompts", "digest.txt");

function getISOWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Primary: Call Gemini 2.5 Flash via REST API. Large context, handles 50k+ tokens.
 */
async function callGemini(prompt: string, retries = 2): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[WARN] GEMINI_API_KEY not set — skipping Gemini");
    return null;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.error(`[INFO] Calling Gemini (attempt ${attempt}/${retries})...`);
      const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`[WARN] Gemini HTTP ${response.status} (attempt ${attempt}/${retries}): ${body.slice(0, 200)}`);
        if (response.status === 401 || response.status === 403) return null;
        continue;
      }

      const data = (await response.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text && text.length > 10) {
        console.error(`[INFO] Gemini response: ${text.length} chars`);
        return text;
      }
      console.error(`[WARN] Empty Gemini response (attempt ${attempt}/${retries})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[WARN] Gemini error (attempt ${attempt}/${retries}): ${msg}`);
    }
  }
  return null;
}

/**
 * Call Groq API (OpenAI-compatible). Returns null if unavailable.
 */
async function callGroq(prompt: string, retries = 2): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("[WARN] GROQ_API_KEY not set — skipping Groq");
    return null;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.error(`[INFO] Calling Groq (attempt ${attempt}/${retries})...`);
      const response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`[WARN] Groq HTTP ${response.status} (attempt ${attempt}/${retries}): ${body.slice(0, 200)}`);
        if (response.status === 401 || response.status === 403) return null; // auth error, no retry
        continue;
      }

      const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text && text.length > 10) {
        console.error(`[INFO] Groq response: ${text.length} chars`);
        return text;
      }
      console.error(`[WARN] Empty Groq response (attempt ${attempt}/${retries})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[WARN] Groq error (attempt ${attempt}/${retries}): ${msg}`);
    }
  }
  return null;
}

/**
 * Fallback: Call Ollama local. Note: llama3.2:3b has n_ctx=4096 tokens.
 * With large prompts (>3k tokens) Ollama returns HTTP 500 — skip gracefully.
 */
async function callOllama(prompt: string, retries = 2): Promise<string | null> {
  // Rough token estimate: ~4 chars/token. Skip if prompt likely exceeds context.
  const estimatedTokens = Math.ceil(prompt.length / 4);
  if (estimatedTokens > 3000) {
    console.error(`[WARN] Ollama skipped — prompt ~${estimatedTokens} tokens exceeds llama3.2:3b ctx limit (4096)`);
    return null;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.error(`[INFO] Calling Ollama fallback (attempt ${attempt}/${retries})...`);
      const response = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0.3 } }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) {
        console.error(`[WARN] Ollama HTTP ${response.status} (attempt ${attempt}/${retries})`);
        continue;
      }
      const data = (await response.json()) as { response: string };
      if (data.response && data.response.trim().length > 10) return data.response;
      console.error(`[WARN] Empty Ollama response (attempt ${attempt}/${retries})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED")) { console.error("[WARN] Ollama offline"); return null; }
      console.error(`[WARN] Ollama error (attempt ${attempt}/${retries}): ${msg}`);
    }
  }
  return null;
}

export async function digest(): Promise<void> {
  console.log("[INFO] nox-mem digest starting...");
  const db = getDb();

  let promptTemplate: string;
  try {
    promptTemplate = readFileSync(PROMPT_PATH, "utf-8");
  } catch (err) {
    console.error(`[ERROR] Could not read prompt template: ${PROMPT_PATH}`);
    return;
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  console.log(`[INFO] Querying chunks since ${sevenDaysAgo}...`);

  const chunks = db.prepare(
    "SELECT chunk_text, source_file, chunk_type FROM chunks WHERE source_date >= ? AND chunk_type IN ('decision','lesson','person','project','pending','daily') ORDER BY source_date ASC"
  ).all(sevenDaysAgo) as Array<{ chunk_text: string; source_file: string; chunk_type: string }>;

  if (chunks.length === 0) {
    console.log("[INFO] No data from last 7 days for digest");
    return;
  }

  console.log(`[INFO] Found ${chunks.length} chunks`);
  const fullText = chunks.map((c) => `[${c.chunk_type}] ${c.chunk_text}`).join("\n\n");
  const prompt = promptTemplate + fullText;
  console.log(`[INFO] Total prompt: ${prompt.length} chars (~${Math.ceil(prompt.length / 4)} tokens)`);

  // Try Gemini first (primary — large context), then Groq, then Ollama
  let result = await callGemini(prompt);
  if (!result) {
    console.error("[WARN] Gemini failed, trying Groq fallback...");
    result = await callGroq(prompt);
  }
  if (!result) {
    console.error("[WARN] Groq failed, trying Ollama fallback...");
    result = await callOllama(prompt);
  }
  if (!result) {
    console.error("[ERROR] Digest failed — Gemini, Groq and Ollama all unavailable");
    return;
  }

  const weekId = getISOWeek(new Date());
  const digestDir = resolve(WORKSPACE, "memory", "digests");
  mkdirSync(digestDir, { recursive: true });

  const digestPath = resolve(digestDir, `${weekId}.md`);
  const content = `# Weekly Digest — ${weekId}\n\n*Gerado automaticamente em ${new Date().toISOString()}*\n\n${result}`;
  writeFileSync(digestPath, content, "utf-8");
  console.log(`[INFO] Digest saved to ${digestPath}`);

  try {
    execFileSync("git", ["-C", WORKSPACE, "add", `memory/digests/${weekId}.md`], { stdio: "pipe" });
    execFileSync("git", ["-C", WORKSPACE, "commit", "-m", `chore(memory): weekly digest ${weekId}`], { stdio: "pipe" });
    console.log(`[INFO] Git commit: weekly digest ${weekId}`);
  } catch {}
}
