import { readFileSync } from "fs";
import { resolve } from "path";
import { getDb } from "./db.js";
import { workspaceRoot } from "./lib/workspace.js";

const WORKSPACE = workspaceRoot();

/**
 * Extract a clean summary line from a decision chunk.
 * Handles both formats:
 *   Manual:  "## 2026-03-10 — Late API para Boris\n**Decisão:** Usar Late..."
 *   Auto:    "- **2026-03-06:** Skills que precisam..."
 */
function extractDecisionLine(chunkText: string): string | null {
  const lines = chunkText.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Format 1: Auto-consolidated bullets "- **date:** text"
    if (trimmed.startsWith("- **") && trimmed.length > 20 && !trimmed.startsWith("- ❌") && !trimmed.startsWith("- ✅")) {
      return trimmed.substring(0, 120);
    }

    // Format 2: Manual "**Decisão:** text"
    if (trimmed.startsWith("**Decisão:**") || trimmed.startsWith("**Decisao:**")) {
      return `- ${trimmed.substring(0, 120)}`;
    }

    // Format 3: Manual header "## 2026-03-10 — Description"
    if (trimmed.match(/^## \d{4}-\d{2}-\d{2} — .+/) && trimmed.length > 20) {
      return `- ${trimmed.replace("## ", "").substring(0, 120)}`;
    }
  }

  return null;
}

export function primer(): string {
  const sections: string[] = [];
  const today = new Date().toISOString().split("T")[0];

  // 1. SESSION-STATE.md — active task
  try {
    const ss = readFileSync(resolve(WORKSPACE, "SESSION-STATE.md"), "utf-8");
    const activeTask = ss.match(/## 🔴 Tarefa Ativa\n([\s\S]*?)(?=\n## )/)?.[1]?.trim();
    sections.push(
      activeTask && activeTask !== "_Nada em andamento no momento._"
        ? `**Tarefa ativa:** ${activeTask.substring(0, 200)}`
        : "**Tarefa ativa:** Nenhuma"
    );
  } catch {
    sections.push("**Tarefa ativa:** SESSION-STATE.md not found");
  }

  const db = getDb();

  // 2. Recent decisions — search MOST RECENT chunks first (by id DESC)
  //    Handles both manual format (## header + **Decisão:**) and auto (- **date:** text)
  const decisionChunks = db
    .prepare("SELECT chunk_text FROM chunks WHERE chunk_type = 'decision' ORDER BY id DESC LIMIT 15")
    .all() as Array<{ chunk_text: string }>;

  const decisionBullets: string[] = [];
  for (const d of decisionChunks) {
    const line = extractDecisionLine(d.chunk_text);
    if (line && !decisionBullets.includes(line)) {
      decisionBullets.push(line);
      if (decisionBullets.length >= 5) break;
    }
  }

  if (decisionBullets.length > 0) {
    sections.push(`**Decisões recentes:**\n${decisionBullets.join("\n")}`);
  }

  // 3. Today's daily note
  const todayChunks = db
    .prepare("SELECT chunk_text FROM chunks WHERE chunk_type = 'daily' AND source_date = ? LIMIT 3")
    .all(today) as Array<{ chunk_text: string }>;

  if (todayChunks.length > 0) {
    const items = todayChunks.map((c) => {
      const line = c.chunk_text.split("\n").find((l) => l.trim() && !l.startsWith("#") && l.trim().length > 10);
      return `- ${(line || c.chunk_text.substring(0, 100)).trim().substring(0, 120)}`;
    });
    sections.push(`**Hoje:**\n${items.join("\n")}`);
  }

  // 4. Pending
  const pendingChunks = db
    .prepare("SELECT chunk_text FROM chunks WHERE chunk_type = 'pending' LIMIT 5")
    .all() as Array<{ chunk_text: string }>;

  const pendingBullets: string[] = [];
  for (const p of pendingChunks) {
    const lines = p.chunk_text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ") && trimmed.length > 15) {
        pendingBullets.push(trimmed.substring(0, 120));
        if (pendingBullets.length >= 3) break;
      } else if (trimmed.startsWith("### ") && trimmed.length > 10) {
        pendingBullets.push(`- ${trimmed.replace("### ", "").substring(0, 120)}`);
        if (pendingBullets.length >= 3) break;
      }
    }
    if (pendingBullets.length >= 3) break;
  }

  if (pendingBullets.length > 0) {
    sections.push(`**Pendências:**\n${pendingBullets.join("\n")}`);
  }

  return `## Context Recovery — ${today}\n\n${sections.join("\n\n")}`;
}
