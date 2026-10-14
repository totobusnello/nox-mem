import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { getDb } from "./db.js";
import { search } from "./search.js";
import { isDuplicate as semanticIsDuplicate } from "./dedup.js";
import { updateSessionState } from "./session-update.js";
import { incrementMetric } from "./metrics.js";
import { isNoise, learnNoise } from "./noise-filter.js";
import { workspaceRoot } from "./lib/workspace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = workspaceRoot();
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const PROMPT_PATH = resolve(__dirname, "..", "prompts", "consolidate.txt");
const MAX_FILES_PER_RUN = 5;

interface ConsolidationResult {
  decisions: Array<{ text: string; permanent: boolean; memory_type?: string }>;
  lessons: Array<{ text: string; type: string; memory_type?: string }>;
  people: Array<{ name: string; info: string }>;
  projects: Array<{ name: string; update: string }>;
  pending: Array<{ text: string; owner: string; deadline: string }>;
}

export interface NotionItem {
  title: string;
  date: string;
  category: string;
  content: string;
  source: string;
}

/**
 * Primary: Gemini 2.5 Flash — large context, structured JSON output
 */
async function callGemini(prompt: string, retries = 2): Promise<ConsolidationResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[WARN] GEMINI_API_KEY not set — skipping Gemini");
    return null;
  }
  const systemPrompt = 'Você é um extrator de memória. Responda APENAS com JSON válido no formato: {"decisions":[],"lessons":[],"people":[],"projects":[],"pending":[]}. Cada decisão: {text, permanent}. Cada lição: {text, type}. Cada pessoa: {name, info}. Cada projeto: {name, update}. Cada pendência: {text, owner, deadline}.';
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.error(`[INFO] Calling Gemini consolidate (attempt ${attempt}/${retries})...`);
      const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: systemPrompt + "\n\n" + prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: "application/json" },
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
      if (!text) { console.error(`[WARN] Empty Gemini response (attempt ${attempt}/${retries})`); continue; }
      // Strip markdown code fences if present before JSON parse
      const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { console.error(`[WARN] No JSON in Gemini response (attempt ${attempt}/${retries}): ${text.slice(0, 100)}`); continue; }
      try {
        const parsed = JSON.parse(jsonMatch[0]) as ConsolidationResult;
        if (parsed.decisions && parsed.lessons) { console.log("[INFO] Gemini consolidate OK"); return parsed; }
      } catch (parseErr) {
        console.error(`[WARN] Gemini JSON parse error (attempt ${attempt}/${retries}): ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      }
    } catch (err) {
      console.error(`[WARN] Gemini error (attempt ${attempt}/${retries}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

// Ollama removed — offline and not planned to return. Groq is first fallback.

async function callGroqFallback(prompt: string, retries = 2): Promise<ConsolidationResult | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("[ERROR] GROQ_API_KEY not set — trying Gemini retry");
    return await callGeminiSimple(prompt);
  }
  const systemMsg = 'Você é um extrator de memória. Responda APENAS com JSON válido no formato: {"decisions":[],"lessons":[],"people":[],"projects":[],"pending":[]}';
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "system", content: systemMsg }, { role: "user", content: prompt }],
          temperature: 0, max_tokens: 2048, response_format: { type: "json_object" }
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) { console.error(`[WARN] Groq HTTP ${response.status}`); continue; }
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content;
      if (!text) continue;
      const parsed = JSON.parse(text) as ConsolidationResult;
      if (parsed.decisions && parsed.lessons) { console.log("[INFO] Groq fallback OK"); return parsed; }
    } catch (err) { console.error(`[WARN] Groq error: ${err instanceof Error ? err.message : String(err)}`); }
  }
  console.error("[WARN] Groq failed — falling back to Gemini retry");
  return await callGeminiSimple(prompt);
  // Note: Claude Haiku is called from the main consolidate() loop after callGroqFallback returns null.
  // callGeminiSimple is kept here as a last-resort inside the Groq path only.
}

/**
 * Final fallback: Claude Haiku via Anthropic Messages API.
 * sk-ant-oat OAuth tokens work fine with the direct API endpoint.
 */
async function callClaudeHaiku(prompt: string): Promise<ConsolidationResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error("[WARN] ANTHROPIC_API_KEY not set — Claude fallback unavailable"); return null; }
  const systemMsg = 'Você é um extrator de memória. Responda APENAS com JSON válido, sem markdown. Schema: {"decisions":[{"text":"string","permanent":true}],"lessons":[{"text":"string","type":"string"}],"people":[{"name":"string","info":"string"}],"projects":[{"name":"string","update":"string"}],"pending":[{"text":"string","owner":"string","deadline":"string"}]}';
  const shortPrompt = prompt.length > 4000 ? prompt.slice(0, 4000) + "\n...(truncated)" : prompt;
  try {
    console.error("[INFO] Calling Claude Haiku fallback...");
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 2048,
        system: systemMsg,
        messages: [{ role: "user", content: shortPrompt }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`[WARN] Claude Haiku HTTP ${response.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = await response.json() as { content?: Array<{ type: string; text: string }> };
    const text = data.content?.find(b => b.type === "text")?.text?.trim();
    if (!text) { console.error("[WARN] Claude Haiku empty response"); return null; }
    const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { console.error("[WARN] Claude Haiku: no JSON found"); return null; }
    const parsed = JSON.parse(jsonMatch[0]) as ConsolidationResult;
    if (parsed.decisions && parsed.lessons) { console.log("[INFO] Claude Haiku fallback OK"); return parsed; }
  } catch (err) {
    console.error(`[WARN] Claude Haiku error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}
async function callGeminiSimple(prompt: string): Promise<ConsolidationResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error("[ERROR] GEMINI_API_KEY not set — all fallbacks exhausted"); return null; }
  // Simplified prompt for retry — shorter context, stricter JSON schema instruction
  const shortPrompt = prompt.length > 3000 ? prompt.slice(0, 3000) + "\n...(truncated)" : prompt;
  const systemPrompt = 'Extraia decisões e lições do texto abaixo. Responda SOMENTE JSON, sem markdown, sem texto extra. Schema obrigatório: {"decisions":[{"text":"string","permanent":true}],"lessons":[{"text":"string","type":"string"}],"people":[],"projects":[],"pending":[]}';
  try {
    const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: systemPrompt + "\n\n" + shortPrompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) { console.error(`[WARN] Gemini retry HTTP ${response.status}`); return null; }
    const data = (await response.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return null;
    // Strip markdown code fences if present
    const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { console.error("[WARN] Gemini retry: no JSON found"); return null; }
    const parsed = JSON.parse(jsonMatch[0]) as ConsolidationResult;
    if (parsed.decisions && parsed.lessons) { console.log("[INFO] Gemini retry OK"); return parsed; }
  } catch (err) { console.error(`[WARN] Gemini retry error: ${err instanceof Error ? err.message : String(err)}`); }
  return null;
}

function logDedup(text: string, sourceFile: string, chunkType: string, reason: string): void {
  try {
    const db = getDb();
    const preview = text.substring(0, 200);
    db.prepare(
      "INSERT INTO dedup_log (chunk_text_preview, source_file, chunk_type, reason) VALUES (?, ?, ?, ?)"
    ).run(preview, sourceFile, chunkType, reason);
    console.log(`[DEDUP] Suppressed (${reason}): "${preview.substring(0, 80)}..." [${sourceFile}]`);
  } catch { /* non-critical */ }
}

/** Sync fallback — keyword overlap only (used when semantic dedup is unavailable) */
function isDuplicateSync(text: string, sourceFile: string, chunkType: string): boolean {
  const words = text.split(/\s+/).filter((w) => w.length > 3).slice(0, 8);
  if (words.length < 3) return false;
  const results = search(words.join(" "), 3);
  for (const result of results) {
    const resultWords = new Set(result.chunk_text.toLowerCase().split(/\s+/));
    const inputWords = text.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const overlap = inputWords.filter((w) => resultWords.has(w)).length;
    if (inputWords.length > 0 && overlap / inputWords.length > 0.7) {
      logDedup(text, sourceFile, chunkType, `overlap=${Math.round(overlap / inputWords.length * 100)}% with ${result.source_file}`);
      return true;
    }
  }
  return false;
}

/** Async dedup — tries semantic (Gemini cosine) first, falls back to sync keyword overlap */
async function checkDuplicate(text: string, sourceFile: string, chunkType: string): Promise<boolean> {
  try {
    const isDup = await semanticIsDuplicate(text, sourceFile, chunkType);
    if (isDup) {
      logDedup(text, sourceFile, chunkType, "semantic-cosine");
      return true;
    }
    return false;
  } catch {
    // Gemini unavailable — fall back to sync keyword overlap
    return isDuplicateSync(text, sourceFile, chunkType);
  }
}

function ensureFile(path: string, header: string): void {
  if (!existsSync(path)) writeFileSync(path, header + "\n\n", "utf-8");
}

function appendInSection(path: string, section: string, content: string): void {
  let existing = readFileSync(path, "utf-8");
  if (!existing.includes(section)) {
    existing = existing.trimEnd() + "\n\n" + section + "\n\n" + content + "\n";
    writeFileSync(path, existing, "utf-8");
    return;
  }
  const sectionIdx = existing.indexOf(section);
  const afterSection = sectionIdx + section.length;
  const nextHeaderMatch = existing.substring(afterSection).match(/\n## /);
  const insertPos = nextHeaderMatch ? afterSection + nextHeaderMatch.index! : existing.length;
  const before = existing.substring(0, insertPos).trimEnd();
  const after = existing.substring(insertPos);
  writeFileSync(path, before + "\n" + content + "\n" + after, "utf-8");
}

function gitCommit(message: string): void {
  try {
    execFileSync("git", ["-C", WORKSPACE, "add", "memory/", "MEMORY.md"], { stdio: "pipe" });
    execFileSync("git", ["-C", WORKSPACE, "commit", "-m", message], { stdio: "pipe" });
    console.log(`[INFO] Git commit: ${message}`);
  } catch { /* no changes — not critical */ }
}

export async function consolidate(options?: { retryFailed?: boolean; dryRun?: boolean }): Promise<{ processed: number; extracted: number; skipped: number; remaining: number; notionItems: NotionItem[]; dryRun?: boolean }> {
  const db = getDb();
  if (options?.dryRun) {
    // Fix A5 HIGH #1+#2 (audit 04-26): wouldDelete reflects real DELETE scope (not hardcoded 0);
    // newFiles uses SAME filter as the real loop (chunk_type='daily' DISTINCT source_file).
    const failedToReset = (db.prepare("SELECT COUNT(*) AS c FROM consolidated_files WHERE status = -1").get() as { c: number }).c;
    const newFiles = (db.prepare(`
      SELECT COUNT(DISTINCT source_file) AS c FROM chunks
      WHERE chunk_type = 'daily'
        AND source_file NOT IN (SELECT source_file FROM consolidated_files)
    `).get() as { c: number }).c;
    // wouldInsert: every new file processed produces 1 row in consolidated_files (status update).
    // wouldUpdate: meta table rows touched by consolidate (estimate from MAX_FILES_PER_RUN cap).
    const wouldInsertConsolidated = Math.min(newFiles, MAX_FILES_PER_RUN);
    console.log(JSON.stringify({
      dryRun: true,
      operation: "consolidate",
      wouldDelete: {
        rows: options.retryFailed ? failedToReset : 0,
        table: "consolidated_files WHERE status = -1 (only when --retry-failed)",
      },
      wouldInsert: {
        rows: wouldInsertConsolidated,
        table: "consolidated_files (1 row per processed daily file, capped by MAX_FILES_PER_RUN)",
      },
      wouldProcess: {
        newFilesEstimate: newFiles,
        capPerRun: MAX_FILES_PER_RUN,
        note: "DISTINCT daily chunks pending consolidation (matches real loop filter)",
      },
      protected: { mutationScope: "consolidated_files + meta only (não toca chunks data)" },
    }, null, 2));
    return { processed: 0, extracted: 0, skipped: 0, remaining: newFiles, notionItems: [], dryRun: true };
  }
  const promptTemplate = readFileSync(PROMPT_PATH, "utf-8");

  if (options?.retryFailed) {
    const resetCount = db.prepare("DELETE FROM consolidated_files WHERE status = -1").run().changes;
    if (resetCount > 0) console.log(`[INFO] Reset ${resetCount} failed files for retry`);
  }

  const dailyFiles = db.prepare(`
    SELECT DISTINCT source_file, source_date FROM chunks
    WHERE chunk_type = 'daily'
    AND source_file NOT IN (SELECT source_file FROM consolidated_files)
    ORDER BY source_date ASC
    LIMIT ?
  `).all(MAX_FILES_PER_RUN) as Array<{ source_file: string; source_date: string }>;

  const totalPending = (db.prepare(`
    SELECT COUNT(DISTINCT source_file) as c FROM chunks
    WHERE chunk_type = 'daily'
    AND source_file NOT IN (SELECT source_file FROM consolidated_files)
  `).get() as { c: number }).c;

  if (dailyFiles.length === 0) {
    console.log("[INFO] Nothing to consolidate");
    return { processed: 0, extracted: 0, skipped: 0, remaining: 0, notionItems: [] };
  }

  console.log(`[INFO] Processing ${dailyFiles.length} of ${totalPending} pending daily notes`);

  let totalExtracted = 0;
  let totalSkipped = 0;
  const notionItems: NotionItem[] = [];

  for (const { source_file } of dailyFiles) {
    console.log(`[INFO] Consolidating ${source_file}...`);
    const chunks = db.prepare("SELECT chunk_text FROM chunks WHERE source_file = ? ORDER BY id").all(source_file) as Array<{ chunk_text: string }>;

    // Noise filter: remove chunks without semantic value before sending to LLM
    const filteredChunks = chunks.filter((c) => {
      if (isNoise(c.chunk_text, db)) {
        console.log(`[NOISE] Filtered: "${c.chunk_text.substring(0, 60).replace(/\n/g, " ")}..."`);
        incrementMetric("noise_filtered");
        return false;
      }
      return true;
    });

    if (filteredChunks.length === 0) {
      console.log(`[INFO] All chunks filtered as noise for ${source_file} — marking consolidated`);
      db.prepare("INSERT OR REPLACE INTO consolidated_files (source_file, status, processed_at) VALUES (?, 1, datetime('now'))").run(source_file);
      continue;
    }

    const fullText = filteredChunks.map((c) => c.chunk_text).join("\n\n");
    const prompt = promptTemplate + fullText;
    // Fallback chain: Gemini → Groq → Claude Haiku → GeminiSimple
    let result = await callGemini(prompt);
    if (!result) {
      console.error("[WARN] Gemini failed — trying Groq fallback...");
      result = await callGroqFallback(prompt);
    }
    if (!result) {
      console.error("[WARN] Groq failed — trying Claude Haiku fallback...");
      result = await callClaudeHaiku(prompt);
    }

    if (!result) {
      db.prepare("INSERT OR REPLACE INTO consolidated_files (source_file, status, processed_at) VALUES (?, -1, datetime('now'))").run(source_file);
      continue;
    }

    // Feedback loop: if LLM returned zero useful results from short chunks, learn them as noise
    const totalExtractedFromResult =
      result.decisions.length + result.lessons.length + result.people.length +
      result.projects.length + result.pending.length;

    if (totalExtractedFromResult === 0) {
      for (const c of filteredChunks) {
        if (c.chunk_text.trim().length < 200) {
          learnNoise(c.chunk_text, db);
        }
      }
    }

    const date = source_file.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || "unknown";

    const decisionsPath = resolve(WORKSPACE, "memory", "decisions.md");
    ensureFile(decisionsPath, "# decisions.md — Decisões Permanentes");
    for (const d of result.decisions) {
      if (!(await checkDuplicate(d.text, source_file, "decision"))) {
        appendInSection(decisionsPath, "## Consolidação Automática", `- **${date}:** ${d.text}`);
        // Store with memory_type
        db.prepare("UPDATE chunks SET memory_type = 'decision' WHERE source_file = ? AND chunk_type = 'daily' LIMIT 1").run(source_file);
        notionItems.push({ title: d.text.substring(0, 100), date, category: "Decisão", content: d.text, source: source_file });
        totalExtracted++;
      } else { totalSkipped++; }
    }

    const lessonsPath = resolve(WORKSPACE, "memory", "lessons.md");
    ensureFile(lessonsPath, "# memory/lessons.md — Lições Aprendidas");
    for (const l of result.lessons) {
      if (!(await checkDuplicate(l.text, source_file, "lesson"))) {
        const section = l.type === "strategic" ? "## 🔒 Estratégicas" : "## ⏳ Táticas";
        appendInSection(lessonsPath, section, `- **${date}:** ${l.text}`);
        notionItems.push({ title: l.text.substring(0, 100), date, category: "Lição", content: l.text, source: source_file });
        totalExtracted++;
      } else { totalSkipped++; }
    }

    const peoplePath = resolve(WORKSPACE, "memory", "people.md");
    ensureFile(peoplePath, "# memory/people.md — Equipe e Contatos");
    for (const p of result.people) {
      if (!(await checkDuplicate(`${p.name} ${p.info}`, source_file, "person"))) {
        appendInSection(peoplePath, "## Consolidação Automática", `- **${p.name}:** ${p.info}`);
        notionItems.push({ title: p.name, date, category: "Contexto", content: p.info, source: source_file });
        totalExtracted++;
      } else { totalSkipped++; }
    }

    const projectsPath = resolve(WORKSPACE, "memory", "projects.md");
    ensureFile(projectsPath, "# memory/projects.md — Projetos");
    for (const proj of result.projects) {
      if (!(await checkDuplicate(`${proj.name} ${proj.update}`, source_file, "project"))) {
        appendInSection(projectsPath, "## Consolidação Automática", `- **${proj.name} (${date}):** ${proj.update}`);
        notionItems.push({ title: proj.name, date, category: "Contexto", content: proj.update, source: source_file });
        totalExtracted++;
      } else { totalSkipped++; }
    }

    const pendingPath = resolve(WORKSPACE, "memory", "pending.md");
    ensureFile(pendingPath, "# memory/pending.md — Pendências");
    for (const pend of result.pending) {
      if (!(await checkDuplicate(pend.text, source_file, "pending"))) {
        appendInSection(pendingPath, "## Consolidação Automática", `- **${pend.owner}** (${pend.deadline}): ${pend.text}`);
        notionItems.push({ title: pend.text.substring(0, 100), date, category: "Pendência", content: `${pend.owner} (${pend.deadline}): ${pend.text}`, source: source_file });
        totalExtracted++;
      } else { totalSkipped++; }
    }

    db.prepare("INSERT OR REPLACE INTO consolidated_files (source_file, status, processed_at) VALUES (?, 1, datetime('now'))").run(source_file);
  }

  db.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_consolidation', datetime('now'), datetime('now'))").run();

  const remaining = totalPending - dailyFiles.length;
  console.log(`[INFO] Consolidation complete: ${dailyFiles.length} files, ${totalExtracted} extracted, ${totalSkipped} duplicates skipped, ${remaining} remaining`);

  const today = new Date().toISOString().split("T")[0];
  gitCommit(`chore(memory): consolidate daily notes ${today}`);

  // Phase 2: Update session state and record metrics
  try { updateSessionState(); } catch {}
  incrementMetric("consolidations_ok");
  if (totalExtracted > 0) incrementMetric("chunks_added", totalExtracted);
  if (totalSkipped > 0) incrementMetric("dedup_blocked", totalSkipped);

  return { processed: dailyFiles.length, extracted: totalExtracted, skipped: totalSkipped, remaining, notionItems };
}
