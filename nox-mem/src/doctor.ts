import { getDb, DB_PATH } from "./db.js";
import { statSync, existsSync } from "fs";

type Status = "✅" | "⚠️" | "❌" | "ℹ️" | "⚪";

interface Check {
  name: string;
  status: Status;
  detail: string;
}

// Unit names the watcher has shipped under: the repo's unit file and the
// older name still used on the origin VPS.
const WATCHER_UNITS = ["nox-mem-watcher.service", "nox-mem-watch.service"];

/**
 * Two groups, deliberately:
 *   core     — the store, FTS5 and embeddings. A ❌ here means ingest/search is broken.
 *   optional — integrations only some commands use (Ollama for consolidate /
 *              kg-extract, Notion, the systemd watcher). Absent ⇒ ⚪, never ❌:
 *              a fresh install without them is healthy.
 *
 * `--quiet` prints only core problems and exits 1 iff a core check failed —
 * the contract scripts/test.sh relies on.
 */
export async function doctor(opts: { quiet?: boolean } = {}): Promise<void> {
  const core: Check[] = [];
  const optional: Check[] = [];

  // 1. SQLite database
  try {
    const db = getDb();
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    core.push({ name: "SQLite DB", status: "✅", detail: `schema v${version?.value || "?"}, ${formatSize(DB_PATH)} at ${DB_PATH}` });

    // 2. FTS5 index
    // chunks_fts is an external-content table: COUNT(*) on it reads the CONTENT
    // table (chunks), so "indexed == chunks" held by construction and this check
    // could never fire. The docsize shadow table has one row per document the
    // index actually holds — measured: after an FTS 'delete' it drops to 0 while
    // COUNT(*) on chunks_fts still reports every chunk (2026-09-28).
    const hasDocsize = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunks_fts_docsize'").get() !== undefined;
    const ftsCount = (db.prepare(`SELECT COUNT(*) as c FROM ${hasDocsize ? "chunks_fts_docsize" : "chunks_fts"}`).get() as { c: number }).c;
    const chunkCount = (db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
    const ftsOk = ftsCount === chunkCount;
    core.push({ name: "FTS5 Index", status: ftsOk ? "✅" : "⚠️", detail: `${ftsCount} indexed / ${chunkCount} chunks${ftsOk ? "" : ` — MISMATCH, rebuild the FTS index: sqlite3 "${DB_PATH}" "INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')"`}` });

    // 3. Embeddings (semantic search). Missing key is a degraded mode, not a failure:
    //    search falls back to FTS5.
    const hasKey = Boolean(
      process.env.NOX_EMBEDDING_API_KEY || process.env.NOX_EMBED_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY,
    );
    let embedded = 0;
    try {
      const { ensureVecTable, countEmbedded } = await import("./embed.js");
      ensureVecTable(db);
      embedded = countEmbedded(db);
    } catch {
      // sqlite-vec not loadable — reported through the detail below
    }
    if (!hasKey) {
      core.push({ name: "Embeddings", status: "⚠️", detail: `no GEMINI_API_KEY — search is keyword-only (FTS5); ${embedded}/${chunkCount} embedded` });
    } else {
      const full = embedded >= chunkCount;
      core.push({ name: "Embeddings", status: full ? "✅" : "⚠️", detail: `${embedded}/${chunkCount} embedded${full ? "" : " — run nox-mem vectorize"}` });
    }

    // 4. Consolidated files
    const consolidated = (db.prepare("SELECT COUNT(*) as c FROM consolidated_files WHERE status = 1").get() as { c: number }).c;
    const failed = (db.prepare("SELECT COUNT(*) as c FROM consolidated_files WHERE status = -1").get() as { c: number }).c;
    const pending = (db.prepare("SELECT COUNT(DISTINCT source_file) as c FROM chunks WHERE chunk_type = 'daily' AND source_file NOT IN (SELECT source_file FROM consolidated_files)").get() as { c: number }).c;
    core.push({ name: "Consolidation", status: failed > 0 ? "⚠️" : "✅", detail: `${consolidated} done, ${pending} pending, ${failed} failed` });

    // 5. Last consolidation
    const lastCon = db.prepare("SELECT value FROM meta WHERE key = 'last_consolidation'").get() as { value: string } | undefined;
    core.push({ name: "Last consolidation", status: "ℹ️", detail: lastCon?.value ?? "never" });
  } catch (err) {
    core.push({ name: "SQLite DB", status: "❌", detail: `${err}` });
  }

  // ── Optional integrations ──────────────────────────────────────────────────

  // Ollama — used by consolidate / kg-extract only
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = (await response.json()) as { models: Array<{ name: string; size: number }> };
      const models = data.models.map((m) => m.name).join(", ");
      optional.push({ name: "Ollama", status: "✅", detail: `running, models: ${models}` });
    } else {
      optional.push({ name: "Ollama", status: "⚠️", detail: `HTTP ${response.status}` });
    }
  } catch {
    optional.push({ name: "Ollama", status: "⚪", detail: "not running (optional — used by consolidate and kg-extract)" });
  }

  // Notion token
  const notionTokenPath = process.env.NOX_NOTION_TOKEN_PATH ?? "/root/.config/notion/api_key";
  const notionTokenExists = existsSync(notionTokenPath);
  optional.push({
    name: "Notion token",
    status: notionTokenExists ? "✅" : "⚪",
    detail: notionTokenExists ? `found at ${notionTokenPath}` : "not configured (optional — set NOX_NOTION_TOKEN_PATH to enable)",
  });

  // File watcher (systemd). No systemd, or unit not installed ⇒ optional/absent.
  // Installed but not active ⇒ ⚠️, because someone meant to run it.
  optional.push(await watcherCheck());

  // An FTS/chunks mismatch is ⚠️ on screen (fixable with reindex) but it breaks
  // search, so scripts relying on --quiet must see it as a failure.
  const coreFailed = core.some((c) => c.status === "❌" || (c.name === "FTS5 Index" && c.status !== "✅"));

  if (opts.quiet) {
    for (const check of core.filter((c) => c.status === "❌" || c.status === "⚠️")) {
      console.error(`  ${check.status} ${check.name}: ${check.detail}`);
    }
  } else {
    console.log("\n🩺 nox-mem doctor\n");
    console.log("  Core");
    for (const check of core) console.log(`  ${check.status} ${check.name}: ${check.detail}`);
    console.log("\n  Optional integrations (⚪ = not set up, fine to skip)");
    for (const check of optional) console.log(`  ${check.status} ${check.name}: ${check.detail}`);
    console.log("");
  }

  if (coreFailed) process.exitCode = 1;
}

async function watcherCheck(): Promise<Check> {
  const { execFileSync } = await import("child_process");
  const run = (args: string[]): string | null => {
    try {
      return execFileSync("systemctl", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch (err) {
      // `systemctl is-active` exits non-zero for inactive units but still prints the state
      const out = (err as { stdout?: string }).stdout;
      return typeof out === "string" ? out.trim() : null;
    }
  };

  if (run(["--version"]) === null) {
    return { name: "File watcher", status: "⚪", detail: "no systemd (optional — run `nox-mem watch` in a terminal instead)" };
  }
  for (const unit of WATCHER_UNITS) {
    const state = run(["is-active", unit]);
    if (state === "active") return { name: "File watcher", status: "✅", detail: `${unit} active` };
  }
  for (const unit of WATCHER_UNITS) {
    const loaded = run(["show", "-p", "LoadState", "--value", unit]);
    if (loaded === "loaded") return { name: "File watcher", status: "⚠️", detail: `${unit} installed but not active` };
  }
  return { name: "File watcher", status: "⚪", detail: "not installed (optional — see nox-mem-watcher.service)" };
}

function formatSize(path: string): string {
  try {
    const bytes = statSync(path).size;
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
  } catch {
    return "unknown";
  }
}
