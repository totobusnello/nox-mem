/**
 * session-update.ts — Auto-update SESSION-STATE.md from latest memory
 * Called at end of consolidation or end-of-day
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { getDb } from "./db.js";
import { workspaceRoot } from "./lib/workspace.js";

const WORKSPACE = workspaceRoot();

export function updateSessionState(): void {
  const sessionPath = resolve(WORKSPACE, "memory", "SESSION-STATE.md");
  const db = getDb();
  const now = new Date();
  const today = now.toISOString().split("T")[0];

  // Get active task from active-tasks.md
  let activeTask = "Nenhuma tarefa ativa";
  const tasksPath = resolve(WORKSPACE, "memory", "active-tasks.md");
  try {
    if (existsSync(tasksPath)) {
      const content = readFileSync(tasksPath, "utf-8");
      const activeMatch = content.match(/## 🔴 Em andamento[^\n]*\n([\s\S]*?)(?=\n## |$)/);
      if (activeMatch) {
        const tasks = activeMatch[1].trim().split("\n").filter(l => l.startsWith("- "));
        if (tasks.length > 0) activeTask = tasks[0].replace(/^- /, "");
      }
    }
  } catch {}

  // Get latest decisions
  const decisions = db.prepare(
    "SELECT chunk_text FROM chunks WHERE chunk_type = 'decision' ORDER BY id DESC LIMIT 3"
  ).all() as Array<{ chunk_text: string }>;

  // Get pending items
  const pending = db.prepare(
    "SELECT chunk_text FROM chunks WHERE chunk_type = 'pending' ORDER BY id DESC LIMIT 5"
  ).all() as Array<{ chunk_text: string }>;

  // Get last consolidation
  const lastCon = db.prepare(
    "SELECT value FROM meta WHERE key = 'last_consolidation'"
  ).get() as { value: string } | undefined;

  // Build SESSION-STATE content
  const content = `# SESSION-STATE.md
> Auto-updated: ${now.toISOString()}

## Tarefa Ativa
${activeTask}

## Decisões Recentes
${decisions.map(d => "- " + d.chunk_text.substring(0, 150).replace(/\n/g, " ")).join("\n") || "- Nenhuma"}

## Pendências
${pending.map(p => "- " + p.chunk_text.substring(0, 150).replace(/\n/g, " ")).join("\n") || "- Nenhuma"}

## Sistema
- Last consolidation: ${lastCon?.value ?? "never"}
- Date: ${today}
`;

  writeFileSync(sessionPath, content, "utf-8");
  console.log(`[SESSION] Updated ${sessionPath}`);
}
