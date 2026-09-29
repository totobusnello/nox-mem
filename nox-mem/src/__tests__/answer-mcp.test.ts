// `nox_mem_answer` on the MCP server (stdio JSON-RPC).
//
// The tool definition/handler already lived in src/mcp/tools/answer.ts; what these tests
// pin is that mcp-server.ts REGISTERS it (tools/list) and routes tools/call to it.
// The server runs as a real child process (dist/mcp-server.js) against a throwaway DB.
// No paid API is reachable: every provider key is stripped from the env, answers come
// from the "mock" provider, and the real Gemini path is only exercised to prove it
// fails closed (isError) instead of hanging.
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/answer-mcp.test.js)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const TMP_ROOT = mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-answer-mcp-test-"));
process.env.NOX_DB_PATH = join(TMP_ROOT, "test.db");
for (const k of ["GEMINI_API_KEY", "OPENAI_API_KEY", "NOX_EMBEDDING_API_KEY", "NOX_EMBED_API_KEY", "NOX_ANSWER_PROVIDER"]) {
  delete process.env[k];
}

const SERVER = fileURLToPath(new URL("../mcp-server.js", import.meta.url));

interface RpcMessage {
  id?: number | string;
  result?: any;
  error?: { code: number; message: string };
}

/** Minimal JSON-RPC client over the server's stdio. Keeps stdin open until close(). */
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
    this.proc.stderr.on("data", () => { /* server logs are irrelevant here */ });
  }

  call(method: string, params?: Record<string, unknown>, timeoutMs = 20_000): Promise<RpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
      this.waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<RpcMessage> {
    return this.call("tools/call", { name, arguments: args }, timeoutMs);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.proc.once("exit", () => resolve());
      this.proc.stdin.end();
    });
  }
}

let client: McpClient;
let closeDb: () => void;

before(async () => {
  const { getDb, closeDb: c } = await import("../db.js");
  closeDb = c;
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO chunks (source_file, chunk_type, chunk_text, source_date, created_at, updated_at)
     VALUES (?, 'other', ?, NULL, ?, ?)`,
  );
  ins.run("okapi-notes.md", "okapi habitat notes: the okapi lives in the Ituri forest", "2026-01-10 08:00:00", "2026-01-10 08:00:00");
  closeDb(); // the server child opens the same file
  client = new McpClient();
  await client.call("initialize", {});
});

after(async () => {
  await client.close();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const payload = (m: RpcMessage) => JSON.parse(m.result.content[0].text);

test("tools/list: nox_mem_answer is registered (21 tools) with the answer input schema", async () => {
  const res = await client.call("tools/list");
  const tools: Array<{ name: string; description: string; inputSchema: any }> = res.result.tools;
  assert.equal(tools.length, 21);
  const t = tools.find((x) => x.name === "nox_mem_answer");
  assert.ok(t, "nox_mem_answer missing from tools/list");
  assert.deepEqual(t!.inputSchema.required, ["question"]);
  assert.ok("question" in t!.inputSchema.properties);
  assert.ok("provider" in t!.inputSchema.properties);
  // the pre-existing tools are still there and names are unique
  assert.ok(tools.some((x) => x.name === "nox_mem_search"));
  assert.equal(new Set(tools.map((x) => x.name)).size, tools.length);
});

test("tools/call nox_mem_answer (mock provider): answers with a citation from the corpus", async () => {
  const res = await client.callTool("nox_mem_answer", { question: "okapi", provider: "mock" });
  assert.notEqual(res.result.isError, true);
  const p = payload(res);
  assert.match(p.answer, /Mock answer/);
  assert.equal(p.metadata.provider, "mock");
  assert.equal(p.metadata.retrieval_count, 1);
  assert.equal(p.citations.length, 1);
  assert.equal(p.citations[0].file_path, "okapi-notes.md");
});

test("tools/call nox_mem_answer: invalid input comes back as isError, not a crash", async () => {
  const res = await client.callTool("nox_mem_answer", { question: "" });
  assert.equal(res.result.isError, true);
  assert.equal(payload(res).reason, "invalid_input");
});

test("tools/call nox_mem_answer: no GEMINI_API_KEY ⇒ clear isError (llm_error), never a hang", async () => {
  const res = await client.callTool("nox_mem_answer", { question: "okapi" }); // default provider = gemini
  assert.equal(res.result.isError, true);
  const p = payload(res);
  assert.equal(p.error, true);
  assert.equal(p.reason, "llm_error");
  assert.match(p.message, /GEMINI_API_KEY/);
});
