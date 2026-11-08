// The `instructions` texts are a measured intervention (skill evaluation, 2026-11-07): the scoped
// text is arm T2, the unscoped text is arm T, both copied here from the builds that were run.
// If a wording change makes these fail, the change needs a new evaluation run, not a new literal.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serverInstructions, normaliseScope } from "../mcp-instructions.js";

const MEASURED_SCOPE = "the nox-mem memory system itself (TypeScript; SQLite with FTS5, sqlite-vec and a knowledge graph; hybrid search; salience; Gemini embeddings; its CLI, MCP server and HTTP API; how it is operated in production), its evaluations and technical paper";
const MEASURED_T2 = "nox-mem holds this user's past work on one scope: the nox-mem memory system itself (TypeScript; SQLite with FTS5, sqlite-vec and a knowledge graph; hybrid search; salience; Gemini embeddings; its CLI, MCP server and HTTP API; how it is operated in production), its evaluations and technical paper. It holds decisions, incidents, measurements and notes about that scope. You cannot see it unless you search, and the usual failure is not searching at all, because the task never names what the memory holds.\n\nSearch nox-mem before acting when the task touches that scope and: you are about to change, or recommend changing, a setting, default, threshold, retention, schedule, schema, model or dependency (past decisions often forbid the obvious change); you are explaining why something is the way it is or what was decided; you are about to state a number about it; an error looks like it may have happened before. Also search when the task names a project or person you do not recognize. Do not search for software outside that scope (a setting of some other service, say), for general knowledge, or for a fully specified code change.\n\nHow: nox_mem_search with 3 to 8 distinctive nouns; nox_mem_get for the full text of a hit; nox_mem_decision_get or nox_mem_decision_list for recorded rules. Stop after three searches and say so if nothing relevant comes back. Treat results as dated evidence and name the source you relied on.\n\nWrite when the user states a decision (nox_mem_decision_set, stable slug key, with the reason) or a root cause is confirmed. Do not write what git already records.";
const MEASURED_T = "nox-mem holds this user's past work: decisions, incidents, measurements, notes. You cannot see it unless you search, and the usual failure is not searching at all, because the task never names what the memory holds.\n\nSearch nox-mem before acting when: you are about to change, or recommend changing, a setting, default, threshold, retention, schedule, schema, model or dependency (past decisions often forbid the obvious change); you are explaining why something is the way it is or what was decided; the task mentions a project, system or person you do not recognize; you are about to state a number about this project; an error looks like it may have happened before. Do not search for general knowledge or a fully specified code change.\n\nHow: nox_mem_search with 3 to 8 distinctive nouns; nox_mem_get for the full text of a hit; nox_mem_decision_get or nox_mem_decision_list for recorded rules. Stop after three searches and say so if nothing relevant comes back. Treat results as dated evidence and name the source you relied on.\n\nWrite when the user states a decision (nox_mem_decision_set, stable slug key, with the reason) or a root cause is confirmed. Do not write what git already records.";

test("scoped text equals the measured T2 text", () => {
  assert.equal(serverInstructions({ NOX_MEM_SCOPE: MEASURED_SCOPE }), MEASURED_T2);
});

test("without a scope the field is omitted (only the scoped text passed the evaluation)", () => {
  assert.equal(serverInstructions({}), undefined);
  assert.equal(serverInstructions({ NOX_MEM_SCOPE: "   " }), undefined);
  assert.equal(serverInstructions({ NOX_MEM_INSTRUCTIONS: "on" }), undefined);
});

test("NOX_MEM_INSTRUCTIONS=unscoped opts into the measured T text", () => {
  assert.equal(serverInstructions({ NOX_MEM_INSTRUCTIONS: "unscoped" }), MEASURED_T);
  assert.equal(serverInstructions({ NOX_MEM_INSTRUCTIONS: " Unscoped " }), MEASURED_T);
  // a scope wins over the unscoped opt-in
  assert.equal(serverInstructions({ NOX_MEM_INSTRUCTIONS: "unscoped", NOX_MEM_SCOPE: MEASURED_SCOPE }), MEASURED_T2);
});

test("NOX_MEM_INSTRUCTIONS=off disables the field", () => {
  for (const v of ["off", "OFF", "0", "false"]) {
    assert.equal(serverInstructions({ NOX_MEM_INSTRUCTIONS: v }), undefined);
    assert.equal(serverInstructions({ NOX_MEM_INSTRUCTIONS: v, NOX_MEM_SCOPE: MEASURED_SCOPE }), undefined);
  }
});

test("scope is normalised: one line, no trailing period, bounded", () => {
  assert.equal(normaliseScope("  my projects:\n  billing API.  "), "my projects: billing API");
  assert.equal(serverInstructions({ NOX_MEM_SCOPE: MEASURED_SCOPE + "." }), MEASURED_T2);
  const long = normaliseScope("word ".repeat(400));
  assert.ok(long.length <= 800 && !long.endsWith(" "));
});

const SERVER = fileURLToPath(new URL("../mcp-server.js", import.meta.url));

async function initialize(extra: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-instr-test-"));
  const env: NodeJS.ProcessEnv = { ...process.env, NOX_DB_PATH: join(root, "t.db"), ...extra };
  for (const k of ["NOX_MEM_SCOPE", "NOX_MEM_INSTRUCTIONS"]) if (!(k in extra)) delete env[k];
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
  proc.stderr.on("data", () => {});
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  const deadline = Date.now() + 20_000;
  while (!/"id":1/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise<void>((resolve) => { proc.once("exit", () => resolve()); proc.stdin.end(); });
  rmSync(root, { recursive: true, force: true });
  const line = out.split("\n").find((l) => /"id":1/.test(l));
  assert.ok(line, `no initialize response: ${out.slice(0, 200)}`);
  return JSON.parse(line).result;
}

test("initialize carries the scoped instructions when NOX_MEM_SCOPE is set", async () => {
  const r = await initialize({ NOX_MEM_SCOPE: MEASURED_SCOPE });
  assert.equal(r.instructions, MEASURED_T2);
});

test("initialize omits instructions when NOX_MEM_INSTRUCTIONS=off", async () => {
  const r = await initialize({ NOX_MEM_INSTRUCTIONS: "off" });
  assert.equal("instructions" in r, false);
});

test("initialize omits instructions when no scope is set", async () => {
  const r = await initialize({});
  assert.equal("instructions" in r, false);
});
