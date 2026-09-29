// Temporal filter (--as-of / --changed-since) on `answer`, across CLI, HTTP and MCP.
//
// Same semantics as `search` (src/lib/dates.ts): as_of = created_at IS NULL OR
// created_at <= d (bare date = end of day UTC); changed_since = updated_at > d OR
// created_at > d. The filter is chained answer() -> retrieveContext() -> searchHybrid();
// these tests run the REAL retrieval against a throwaway DB so that dropping the hand-off
// anywhere in that chain fails them (see the mutation noted in the commit message).
//
// Never calls a paid API: provider keys are stripped from the env before anything is
// imported, and every answer comes from the "mock" provider.
//
// Run: npm test  (or: npx tsc -p tsconfig.test.json && node --test dist/__tests__/answer-temporal.test.js)

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TMP_ROOT = mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-answer-temporal-test-"));
process.env.NOX_DB_PATH = join(TMP_ROOT, "test.db");
for (const k of ["GEMINI_API_KEY", "OPENAI_API_KEY", "NOX_EMBEDDING_API_KEY", "NOX_EMBED_API_KEY", "NOX_ANSWER_PROVIDER"]) {
  delete process.env[k];
}

let getDb: any, closeDb: any;
let runCli: typeof import("../cli/answer.js").runCli;
let parseArgs: typeof import("../cli/answer.js").parseArgs;
let handleAnswerRequest: typeof import("../api/answer.js").handleAnswerRequest;
let noxMemAnswerTool: typeof import("../mcp/tools/answer.js").noxMemAnswerTool;
let answer: typeof import("../lib/answer/index.js").answer;
let retrieveContext: typeof import("../lib/answer/index.js").retrieveContext;
let setRawSearch: typeof import("../lib/answer/index.js").__setRawSearchForTests;
let resolveTemporalFilter: typeof import("../lib/answer/index.js").resolveTemporalFilter;

before(async () => {
  ({ getDb, closeDb } = await import("../db.js"));
  ({ runCli, parseArgs } = await import("../cli/answer.js"));
  ({ handleAnswerRequest } = await import("../api/answer.js"));
  ({ noxMemAnswerTool } = await import("../mcp/tools/answer.js"));
  ({ answer, retrieveContext, __setRawSearchForTests: setRawSearch, resolveTemporalFilter } =
    await import("../lib/answer/index.js"));

  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO chunks (source_file, chunk_type, chunk_text, source_date, created_at, updated_at)
     VALUES (?, 'other', ?, NULL, ?, ?)`,
  );
  // Same shape as temporal-filter.test.ts: an old row, a row created early but edited
  // late, a recent row, and a legacy row without created_at.
  ins.run("old.md", "okapi migration notes, first draft", "2026-01-10 08:00:00", "2026-01-10 08:00:00");
  ins.run("edited.md", "okapi migration notes, revised", "2026-01-15 08:00:00", "2026-09-27 09:00:00");
  ins.run("new.md", "okapi migration notes, final", "2026-09-26T10:00:00.000Z", "2026-09-26T10:00:00.000Z");
  ins.run("legacy.md", "okapi migration notes, legacy import", null, null);
});

afterEach(() => setRawSearch(null));

after(() => {
  closeDb();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * The mock provider only ever cites [chunk_1], so `citations` shows one file at best.
 * The retrieved set itself is what the filter must shape — read it straight from
 * retrieveContext() with the same arguments answer() uses.
 */
async function retrievedFiles(question: string, filter?: Parameters<typeof retrieveContext>[2]): Promise<string[]> {
  return (await retrieveContext(question, 8, filter)).map((c) => c.file_path).sort();
}

async function cli(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli({ argv, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out, err };
}

// ─── resolveTemporalFilter (shared by the three surfaces) ────────────────────

test("resolveTemporalFilter: same semantics as search; unset ⇒ undefined", () => {
  const NOW = Date.parse("2026-09-28T12:00:00Z");
  const f = resolveTemporalFilter({ asOf: "2026-05-01", changedSince: "2026-05-01" }, NOW)!;
  assert.equal(f.asOf!.toISOString(), "2026-05-01T23:59:59.999Z");
  assert.equal(f.changedSince!.toISOString(), "2026-05-01T00:00:00.000Z");
  assert.equal(resolveTemporalFilter({}, NOW), undefined);
  assert.equal(resolveTemporalFilter({ asOf: null, changedSince: undefined }, NOW), undefined);
});

test("resolveTemporalFilter: a provided-but-unusable value throws (blank and non-string included)", () => {
  for (const bad of ["soon", "1mo", "May 1", "", "   ", 20260501, true, {}]) {
    assert.throws(() => resolveTemporalFilter({ asOf: bad as any }), /as_of/, `as_of ${JSON.stringify(bad)}`);
    assert.throws(() => resolveTemporalFilter({ changedSince: bad as any }), /changed_since/, `changed_since ${JSON.stringify(bad)}`);
  }
});

// ─── the chain answer() → retrieveContext() → raw search ─────────────────────

test("answer(): opts.temporal reaches the retrieval function", async () => {
  let seen: unknown = "not-called";
  const filter = resolveTemporalFilter({ asOf: "2026-01-12" })!;
  await answer({
    question: "okapi",
    provider: "mock",
    temporal: filter,
    retrieveOverride: async (_q, _k, f) => { seen = f; return []; },
  });
  assert.equal(seen, filter);
});

test("answer(): no filter ⇒ retrieval gets undefined (unchanged unfiltered path)", async () => {
  let seen: unknown = "not-called";
  await answer({
    question: "okapi",
    provider: "mock",
    retrieveOverride: async (_q, _k, f) => { seen = f; return []; },
  });
  assert.equal(seen, undefined);
});

test("retrieveContext(): the filter reaches the underlying raw search", async () => {
  let seen: unknown = "not-called";
  setRawSearch(async (_q, _k, f) => { seen = f; return []; });
  const filter = resolveTemporalFilter({ changedSince: "2026-09-01" })!;
  await retrieveContext("okapi", 4, filter);
  assert.equal(seen, filter);
});

// ─── real retrieval against the DB ───────────────────────────────────────────

test("retrieval baseline: no filter returns every match", async () => {
  assert.deepEqual(await retrievedFiles("okapi"), ["edited.md", "legacy.md", "new.md", "old.md"]);
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

test("CLI parseArgs: --as-of / --changed-since are captured as raw strings", () => {
  const a = parseArgs(["okapi", "--as-of", "2026-01-12", "--changed-since", "7d"]);
  assert.equal(a.asOf, "2026-01-12");
  assert.equal(a.changedSince, "7d");
  assert.equal(a.question, "okapi");
  assert.throws(() => parseArgs(["okapi", "--as-of"]), /requires a value/);
  assert.throws(() => parseArgs(["okapi", "--changed-since"]), /requires a value/);
});

test("CLI --as-of excludes chunks outside the window (old + legacy only; exit 0)", async () => {
  const { code, out } = await cli(["okapi", "--provider", "mock", "--json", "--as-of", "2026-01-12"]);
  assert.equal(code, 0);
  const res = JSON.parse(out[0]!);
  // old.md (created 2026-01-10) and legacy.md (no created_at) pass; edited.md/new.md are
  // created after 2026-01-12 and must not be retrieved.
  assert.equal(res.metadata.retrieval_count, 2);
  assert.ok(!JSON.stringify(res.citations).includes("new.md"));
  assert.ok(!JSON.stringify(res.citations).includes("edited.md"));
});

test("CLI --changed-since with an empty window ⇒ retrieval_empty (exit 3), not an unfiltered answer", async () => {
  // Every real row was created after 2000-01-01, except the legacy row (created_at NULL,
  // "always existed"). Use --changed-since instead to get a truly empty window:
  const { code, out } = await cli(["okapi", "--provider", "mock", "--json", "--changed-since", "2099-01-01"]);
  assert.equal(code, 3);
  const res = JSON.parse(out[0]!);
  assert.equal(res.metadata.retrieval_count, 0);
  assert.equal(res.metadata.failed_reason, "retrieval_empty");
});

test("CLI --changed-since keeps edited + new (created early but edited late counts)", async () => {
  const { code, out } = await cli(["okapi", "--provider", "mock", "--json", "--changed-since", "2026-09-01"]);
  assert.equal(code, 0);
  const res = JSON.parse(out[0]!);
  assert.equal(res.metadata.retrieval_count, 2);
});

test("CLI --as-of and --changed-since combine (a range)", async () => {
  // created <= 2026-01-12 AND changed after 2026-01-01 ⇒ old.md only (legacy has NULL
  // updated_at/created_at so it fails the changed_since leg).
  const { code, out } = await cli([
    "okapi", "--provider", "mock", "--json", "--as-of", "2026-01-12", "--changed-since", "2026-01-01",
  ]);
  assert.equal(code, 0);
  const res = JSON.parse(out[0]!);
  assert.equal(res.metadata.retrieval_count, 1);
  assert.equal(res.citations[0].file_path, "old.md");
});

test("CLI: invalid date ⇒ exit 2 and an error naming the flag; no answer is produced", async () => {
  for (const argv of [
    ["okapi", "--provider", "mock", "--as-of", "not-a-date"],
    ["okapi", "--provider", "mock", "--changed-since", "1mo"],
    ["okapi", "--provider", "mock", "--as-of", ""],
    ["okapi", "--provider", "mock", "--json", "--as-of", "2026-02-30x"],
  ]) {
    const { code, out, err } = await cli(argv);
    assert.equal(code, 2, `argv ${JSON.stringify(argv)}`);
    assert.equal(out.length, 0, "must not print an answer");
    assert.match(err.join("\n"), /as_of|changed_since/);
  }
});

test("CLI --help documents both flags", async () => {
  const { code, out } = await cli(["--help"]);
  assert.equal(code, 0);
  assert.match(out[0]!, /--as-of/);
  assert.match(out[0]!, /--changed-since/);
});

// ─── HTTP handler (POST /api/answer body) ────────────────────────────────────

test("HTTP as_of filters retrieval (200, retrieval_count reflects the window)", async () => {
  const out = await handleAnswerRequest({ body: { question: "okapi", provider: "mock", as_of: "2026-01-12" } });
  assert.equal(out.status, 200);
  assert.equal((out.body as any).metadata.retrieval_count, 2);
});

test("HTTP changed_since with an empty window ⇒ 503 retrieval_empty", async () => {
  const out = await handleAnswerRequest({ body: { question: "okapi", provider: "mock", changed_since: "2099-01-01" } });
  assert.equal(out.status, 503);
  assert.equal((out.body as any).metadata.failed_reason, "retrieval_empty");
});

test("HTTP: invalid date ⇒ 400, and answer() is never invoked", async () => {
  for (const body of [
    { question: "okapi", as_of: "not-a-date" },
    { question: "okapi", changed_since: "yesterday" },
    { question: "okapi", as_of: "" },
    { question: "okapi", as_of: 20260501 },
  ]) {
    let called = false;
    const out = await handleAnswerRequest({
      body,
      answer: async () => { called = true; throw new Error("must not run"); },
    });
    assert.equal(out.status, 400, JSON.stringify(body));
    assert.equal((out.body as any).error, true);
    assert.match((out.body as any).message, /as_of|changed_since/);
    assert.equal(called, false);
  }
});

// ─── MCP tool ────────────────────────────────────────────────────────────────

test("MCP tool schema advertises as_of / changed_since", () => {
  const props = (noxMemAnswerTool.inputSchema as any).properties;
  assert.equal(props.as_of.type, "string");
  assert.equal(props.changed_since.type, "string");
});

test("MCP as_of filters retrieval", async () => {
  const res = await noxMemAnswerTool.handler({ question: "okapi", provider: "mock", as_of: "2026-01-12" });
  assert.notEqual(res.isError, true);
  assert.equal(JSON.parse(res.content[0]!.text).metadata.retrieval_count, 2);
});

test("MCP: invalid date ⇒ isError invalid_input, answer() is never invoked", async () => {
  for (const input of [
    { question: "okapi", as_of: "not-a-date" },
    { question: "okapi", changed_since: "1mo" },
    { question: "okapi", as_of: "" },
    { question: "okapi", changed_since: 7 },
  ]) {
    let called = false;
    const res = await noxMemAnswerTool.handler(input, {
      answer: async () => { called = true; throw new Error("must not run"); },
    });
    assert.equal(res.isError, true, JSON.stringify(input));
    const p = JSON.parse(res.content[0]!.text);
    assert.equal(p.reason, "invalid_input");
    assert.match(p.message, /as_of|changed_since/);
    assert.equal(called, false);
  }
});

test("MCP over stdio (real server process): as_of filters, invalid date is isError", async () => {
  const SERVER = fileURLToPath(new URL("../mcp-server.js", import.meta.url));
  closeDb(); // the child opens the same DB file; reopened lazily by later getDb() callers
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, NOX_DB_PATH: process.env.NOX_DB_PATH! },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiters = new Map<number, (m: any) => void>();
  proc.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) { const m = JSON.parse(line); waiters.get(m.id)?.(m); }
    }
  });
  proc.stderr.on("data", () => {});
  let nextId = 1;
  const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await rpc("initialize", {});
    const ok = await rpc("tools/call", { name: "nox_mem_answer", arguments: { question: "okapi", provider: "mock", as_of: "2026-01-12" } });
    assert.notEqual(ok.result.isError, true);
    assert.equal(JSON.parse(ok.result.content[0].text).metadata.retrieval_count, 2);
    const bad = await rpc("tools/call", { name: "nox_mem_answer", arguments: { question: "okapi", provider: "mock", as_of: "not-a-date" } });
    assert.equal(bad.result.isError, true);
    assert.equal(JSON.parse(bad.result.content[0].text).reason, "invalid_input");
  } finally {
    await new Promise<void>((resolve) => { proc.once("exit", () => resolve()); proc.stdin.end(); });
  }
});
