// The MCP server's stdout must carry JSON-RPC frames only, including the first session on a
// fresh DB, when the schema migrations log. Before src/lib/stdout-guard.ts, that first session
// wrote "[MIGRATE V5] FTS tokenizer updated ..." to stdout ahead of the first response.
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/mcp-stdout.test.js)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../mcp-server.js", import.meta.url));

test("first session on a fresh DB: every stdout line is a JSON-RPC frame", async () => {
  const root = mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-stdout-test-"));
  const db = join(root, "fresh.db");
  assert.equal(existsSync(db), false, "the DB must not exist yet, so the migrations run and log");
  const env: NodeJS.ProcessEnv = { ...process.env, NOX_DB_PATH: db };
  for (const k of ["GEMINI_API_KEY", "OPENAI_API_KEY", "NOX_EMBEDDING_API_KEY", "NOX_EMBED_API_KEY"]) delete env[k];

  const proc = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
  proc.stderr.on("data", () => {});
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nox_mem_stats", arguments: {} } },
  ];
  for (const f of frames) proc.stdin.write(JSON.stringify(f) + "\n");

  const deadline = Date.now() + 20_000;
  while (!/"id":2/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise<void>((resolve) => { proc.once("exit", () => resolve()); proc.stdin.end(); });
  rmSync(root, { recursive: true, force: true });

  const lines = out.split("\n").filter((l) => l.trim());
  assert.ok(lines.length >= 2, `expected 2 responses, got: ${out.slice(0, 300)}`);
  for (const l of lines) {
    assert.doesNotThrow(() => JSON.parse(l), `non-JSON line on stdout: ${l.slice(0, 120)}`);
  }
});
