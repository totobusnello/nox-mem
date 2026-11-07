// `nox_mem_search` over MCP returns each hit's chunk id and whole text; `nox_mem_get` returns
// chunks by id. Before this, the MCP search showed the first 200 characters of each chunk and no
// tool returned more, so an agent found the right chunk and never saw the fact past character 200
// (skill evaluation, 2026-11-06: 10 of 36 tasks answered even when told to search).
//
// The server runs as a real child process (dist/mcp-server.js) against a throwaway DB, with every
// provider key stripped, so search is FTS only and nothing paid is reachable.
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/mcp-search-full.test.js)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const TMP_ROOT = mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-search-full-test-"));
process.env.NOX_DB_PATH = join(TMP_ROOT, "test.db");
for (const k of ["GEMINI_API_KEY", "OPENAI_API_KEY", "NOX_EMBEDDING_API_KEY", "NOX_EMBED_API_KEY"]) {
  delete process.env[k];
}

const SERVER = fileURLToPath(new URL("../mcp-server.js", import.meta.url));

interface RpcMessage {
  id?: number | string;
  result?: any;
  error?: { code: number; message: string };
}

class McpClient {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiters = new Map<number, (m: RpcMessage) => void>();
  private nextId = 1;

  constructor() {
    this.proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, NOX_DB_PATH: process.env.NOX_DB_PATH! },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (d: Buffer) => {
      this.buf += d.toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as RpcMessage;
        if (typeof msg.id === "number") this.waiters.get(msg.id)?.(msg);
      }
    });
    this.proc.stderr.on("data", () => {});
  }

  call(method: string, params?: Record<string, unknown>, timeoutMs = 20_000): Promise<RpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
      this.waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  callTool(name: string, args: Record<string, unknown>): Promise<RpcMessage> {
    return this.call("tools/call", { name, arguments: args });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.proc.once("exit", () => resolve());
      this.proc.stdin.end();
    });
  }
}

// The fact sits past character 1,000, where the old 200-character preview could never reach.
const FILLER = "Context paragraph about the loader and its history. ".repeat(20);
const FACT = "DECISIVE: arbitrary extension paths are refused; only the pinned vec0 build loads.";
const LONG_TEXT = `zebrafinch loader decision. ${FILLER}${FACT}`;
let longId = 0;
let client: McpClient;

before(async () => {
  const { getDb, closeDb } = await import("../db.js");
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO chunks (source_file, chunk_type, chunk_text, source_date, created_at, updated_at)
     VALUES (?, 'decision', ?, '2026-05-01', '2026-05-01 08:00:00', '2026-05-01 08:00:00')`,
  );
  longId = Number(ins.run("docs/DECISIONS.md", LONG_TEXT).lastInsertRowid);
  ins.run("notes.md", "zebrafinch short note");
  closeDb();
  client = new McpClient();
  await client.call("initialize", {});
});

after(async () => {
  await client.close();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const text = (m: RpcMessage): string => m.result.content[0].text;

test("nox_mem_search returns the chunk id and the text past character 200", async () => {
  assert.ok(LONG_TEXT.indexOf(FACT) > 1000, "fixture must put the fact beyond any short preview");
  const res = await client.callTool("nox_mem_search", { query: "zebrafinch loader", limit: 5 });
  assert.notEqual(res.result.isError, true, text(res));
  const out = text(res);
  assert.ok(out.includes(FACT), "the decisive sentence must be in the search output");
  assert.ok(out.includes(`chunk ${longId}`), "each hit must carry its chunk id");
});

test("nox_mem_get returns a chunk's full text by id, and says which ids do not exist", async () => {
  const res = await client.callTool("nox_mem_get", { ids: [longId, 999999] });
  assert.notEqual(res.result.isError, true, text(res));
  const out = text(res);
  assert.ok(out.includes(LONG_TEXT), "full text, unaltered");
  assert.ok(out.includes("docs/DECISIONS.md"));
  assert.ok(out.includes("chunk 999999: not found"));
  const one = await client.callTool("nox_mem_get", { id: longId });
  assert.ok(text(one).includes(FACT));
});

test("nox_mem_get rejects a call with no ids, too many, or non-integers", async () => {
  for (const args of [{}, { ids: Array.from({ length: 11 }, (_, i) => i + 1) }, { id: "abc" }, { ids: [1.5] }]) {
    const res = await client.callTool("nox_mem_get", args);
    assert.equal(res.result.isError, true, JSON.stringify(args));
  }
});

test("formatResultsForAgent: past the budget a hit is cut, and the cut says how to get the rest", async () => {
  const { formatResultsForAgent } = await import("../search.js");
  const big = "x".repeat(3000);
  const hits = [1, 2, 3].map((id) => ({ id, score: 1, source_file: `f${id}.md`, chunk_type: "other", chunk_text: big, source_date: null }));
  const out = formatResultsForAgent(hits, 4000);
  assert.ok(out.includes("[cut at 1000 of 3000 characters: nox_mem_get with id 2 returns the rest]"), out.slice(0, 200));
  assert.ok(out.includes("[cut at 400 of 3000 characters: nox_mem_get with id 3 returns the rest]"));
  assert.equal(formatResultsForAgent(hits.slice(0, 1), 4000).includes("[cut"), false, "under budget: no cut");
});
