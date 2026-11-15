// Guards for what the distiller says about each block and each run. Before them every failed
// block returned [] exactly like "the model found nothing", a fallback provider was tried on any
// empty result, the pending list was cut at maxSessionsPerRun in readdir order, and short sessions
// spent that budget. Each test below fails if one of those comes back.
//
// Run: npx tsc && node --test dist/__tests__/session-distill-outcomes.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Module-level constants in session-distill read these at import: set them first, import after.
const root = mkdtempSync(resolve(tmpdir(), "nox-distill-out-"));
process.env.NOX_DB_PATH = resolve(root, "never-opened.db");
process.env.OPENCLAW_WORKSPACE = resolve(root, "ws");
process.env.NOX_AGENTS_DIR = resolve(root, "ws", "agents");
process.env.NOX_CLAUDE_PROJECTS_DIR = resolve(root, "projects");
delete process.env.NOX_DISTILL_OUTCOMES_PATH;

const mod = await import("../session-distill.js");
const { distillWithGemini, recordOutcomes, listUnprocessedSessions, partitionPending } = mod;

const realFetch = globalThis.fetch;
function withFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = realFetch; });
}
function geminiReply(text: string | undefined, status = 200): Response {
  const body = text === undefined ? { candidates: [] } : { candidates: [{ content: { parts: [{ text }] } }] };
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("no key: outcome no_key, and no request is made", async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  let called = 0;
  await withFetch((async () => { called++; return geminiReply("{}"); }) as typeof fetch, async () => {
    const r = await distillWithGemini("bloco");
    assert.equal(r.outcome, "no_key");
    assert.deepEqual(r.memories, []);
  });
  assert.equal(called, 0);
  if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
});

test("each failure has its own outcome, and only Gemini is ever called", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  const hosts: string[] = [];
  const cases: Array<[string, () => Response]> = [
    ["http_error", () => geminiReply("{}", 500)],
    ["no_text", () => geminiReply(undefined)],
    ["bad_json", () => geminiReply("not json")],
    ["bad_json", () => new Response("<html>", { status: 200 })],
    ["empty", () => geminiReply(JSON.stringify({ memories: [] }))],
    ["empty", () => geminiReply(JSON.stringify({ memories: [{ text: "x", category: "context", importance: 0.3 }] }))],
  ];
  for (const [want, reply] of cases) {
    await withFetch((async (url: string | URL | Request) => { hosts.push(new URL(String(url)).host); return reply(); }) as typeof fetch, async () => {
      const r = await distillWithGemini("bloco");
      assert.equal(r.outcome, want);
      assert.deepEqual(r.memories, []);
    });
  }
  await withFetch((async () => { throw new TypeError("fetch failed"); }) as typeof fetch, async () => {
    assert.equal((await distillWithGemini("bloco")).outcome, "network_error");
  });
  // One request per block, all to Gemini: an empty or failed result tries no second provider.
  assert.equal(hosts.length, cases.length);
  assert.ok(hosts.every((h) => h === "generativelanguage.googleapis.com"), hosts.join(","));
});

test("ok keeps only memories with importance >= 0.5", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  const memories = [
    { text: "decidiu usar só Gemini", category: "decision", importance: 0.9 },
    { text: "ruído", category: "context", importance: 0.2 },
  ];
  await withFetch((async () => geminiReply(JSON.stringify({ memories }))) as typeof fetch, async () => {
    const r = await distillWithGemini("bloco");
    assert.equal(r.outcome, "ok");
    assert.deepEqual(r.memories.map((m) => m.text), ["decidiu usar só Gemini"]);
  });
});

const stats = {
  processedSessions: 2, skippedSessions: 1, messagesRead: 40, memoriesExtracted: 3,
  memoriesDeduplicated: 1, memoriesIngested: 2, blockOutcomes: { ok: 2, no_key: 1 },
};

test("outcomes file: off when unset, one line of counts when set, nothing on dry run", () => {
  const file = resolve(root, "outcomes.jsonl");
  recordOutcomes(false, ["nox"], 7, 3, stats);
  assert.equal(existsSync(file), false);

  process.env.NOX_DISTILL_OUTCOMES_PATH = file;
  try {
    recordOutcomes(true, ["nox"], 7, 3, stats);
    assert.equal(existsSync(file), false, "dry run must not write");
    recordOutcomes(false, ["nox", "main"], 7, 3, stats);
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(row).sort(), [
      "agents", "block_outcomes", "deduped", "extracted", "ingested", "lookback_days", "pending", "processed", "skipped", "ts",
    ]);
    assert.deepEqual(row.block_outcomes, { ok: 2, no_key: 1 });
    assert.equal(row.pending, 3);
  } finally {
    delete process.env.NOX_DISTILL_OUTCOMES_PATH;
  }
});

test("outcomes file in a missing directory warns and does not throw or create it", () => {
  const dir = resolve(root, "missing-dir");
  process.env.NOX_DISTILL_OUTCOMES_PATH = resolve(dir, "outcomes.jsonl");
  const warn = console.warn;
  let warned = "";
  console.warn = (m: string) => { warned = m; };
  try {
    recordOutcomes(false, ["nox"], 7, 0, stats);
  } finally {
    console.warn = warn;
    delete process.env.NOX_DISTILL_OUTCOMES_PATH;
  }
  assert.match(warned, /could not record outcomes/);
  assert.equal(existsSync(dir), false);
});

test("pending sessions come oldest first, across agents", () => {
  const now = Date.now() / 1000;
  const put = (agent: string, name: string, ageDays: number) => {
    const dir = resolve(process.env.NOX_AGENTS_DIR!, agent, "sessions");
    mkdirSync(dir, { recursive: true });
    const f = resolve(dir, `${name}.jsonl`);
    writeFileSync(f, "{}\n");
    const t = now - ageDays * 86400;
    utimesSync(f, t, t);
  };
  put("nox", "new", 1);
  put("nox", "old", 5);
  put("atlas", "mid", 3);
  put("atlas", "expired", 40);
  const db = { prepare: () => ({ get: () => undefined }) } as unknown as Parameters<typeof listUnprocessedSessions>[0];
  const got = listUnprocessedSessions(db, ["nox", "atlas"], 30).map((s) => s.sessionKey);
  assert.deepEqual(got, ["nox:old", "atlas:mid", "nox:new"]);
});

test("short sessions are set aside without spending the budget, and reading stops when it is full", () => {
  const mk = (key: string) => ({ agentId: "nox", sessionFile: `/x/${key}.jsonl`, sessionKey: `nox:${key}`, mtimeMs: 0 });
  const sizes: Record<string, number> = { a: 1, b: 0, c: 5, d: 2, e: 9, f: 4, g: 1 };
  const pending = Object.keys(sizes).map(mk);
  const read: string[] = [];
  const r = partitionPending(pending, 2, (s) => { read.push(s.sessionKey); return new Array(sizes[s.sessionKey.slice(4)]).fill("m"); });
  assert.deepEqual(r.take.map((t) => t.session.sessionKey), ["nox:c", "nox:e"]);
  assert.deepEqual(r.take.map((t) => t.messages.length), [5, 9]);
  assert.deepEqual(r.short.map((s) => [s.session.sessionKey, s.count]), [["nox:a", 1], ["nox:b", 0], ["nox:d", 2]]);
  assert.equal(r.left, 2);
  assert.deepEqual(read, ["nox:a", "nox:b", "nox:c", "nox:d", "nox:e"]);
});
