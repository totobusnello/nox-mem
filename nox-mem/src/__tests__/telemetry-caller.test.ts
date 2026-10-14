// v20 — `requesting_agent` and `was_temporal_query` in search telemetry.
//
// Both columns existed only in the canonical engine, and there they had sat
// without a writer for months: 100% NULL for who searched, 0 for whether the
// query was temporal. A column without a writer is indistinguishable from a
// feature nobody used, so the tests below read the INSERT out of search.ts and
// fail if either column leaves it.
//
// Run: npm run build && node --test dist/__tests__/telemetry-caller.test.js

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const TMP_ROOT = mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-telemetry-caller-"));
const TEST_DB = join(TMP_ROOT, "fresh.db");
process.env.NOX_DB_PATH = TEST_DB;

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

let telemetryCaller: typeof import("../search.js").telemetryCaller;
let temporalQueryKind: typeof import("../temporal-retrieval.js").temporalQueryKind;

before(async () => {
  ({ telemetryCaller } = await import("../search.js"));
  ({ temporalQueryKind } = await import("../temporal-retrieval.js"));
});

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const colunas = (db: Database.Database, tabela: string): string[] =>
  (db.pragma(`table_info(${tabela})`) as Array<{ name: string }>).map((c) => c.name);

test("A1 — clean install has both columns", async () => {
  const m = await import("../db.js");
  const cols = colunas(m.getDb(), "search_telemetry");
  assert.ok(cols.includes("requesting_agent"), cols.join(", "));
  assert.ok(cols.includes("was_temporal_query"), cols.join(", "));
  m.closeDb();
});

test("A2 — a DB stopped at v19 gains both columns on reopen", async () => {
  const legado = join(TMP_ROOT, "v19.db");
  const raw = new Database(legado);
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE search_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      query_hash TEXT NOT NULL,
      query_words INTEGER NOT NULL,
      variants_count INTEGER NOT NULL DEFAULT 1,
      results_count INTEGER NOT NULL DEFAULT 0,
      has_semantic INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      expansion_skipped_reason TEXT,
      top_chunk_ids TEXT,
      top_scores TEXT
    );
    INSERT INTO meta (key, value) VALUES ('schema_version', '19');
  `);
  raw.pragma("user_version = 19");
  assert.ok(!colunas(raw, "search_telemetry").includes("requesting_agent"), "precondition broke");
  raw.close();

  process.env.NOX_DB_PATH = legado;
  // New module instance: db.js memoises the connection at module scope.
  const espec = "../db.js?v19";
  const m = (await import(espec)) as typeof import("../db.js");
  const depois = colunas(m.getDb(), "search_telemetry");
  assert.ok(depois.includes("requesting_agent") && depois.includes("was_temporal_query"), depois.join(", "));
  assert.ok(depois.includes("top_chunk_ids"), "migration lost an older column");
  m.closeDb();
  process.env.NOX_DB_PATH = TEST_DB;
});

test("B1 — the telemetry INSERT writes both columns, and still not query_text", () => {
  const fonte = readFileSync(join(SRC, "search.ts"), "utf8");
  const m = fonte.match(/INSERT INTO search_telemetry \(([^)]*)\)/);
  assert.ok(m, "INSERT INTO search_telemetry not found in search.ts");
  const escritas = m[1].split(",").map((s) => s.trim());
  assert.ok(escritas.includes("requesting_agent"), escritas.join(", "));
  assert.ok(escritas.includes("was_temporal_query"), escritas.join(", "));
  assert.ok(!escritas.includes("query_text"), "privacy regression: query_text in the INSERT");
});

test("B2 — every production caller of searchHybrid declares its surface", () => {
  for (const [arq, sup] of [
    ["api-server.ts", "http"],
    ["mcp-server.ts", "mcp"],
    ["index.ts", "cli"],
    ["reflect.ts", "reflect"],
    ["lib/answer/retrieval.ts", "answer"],
  ] as const) {
    const fonte = readFileSync(join(SRC, arq), "utf8");
    const chamadas = fonte.match(/searchHybrid\([^;]*\);/g) ?? [];
    assert.ok(chamadas.length > 0, `${arq}: no call to searchHybrid`);
    for (const c of chamadas) assert.ok(c.includes(`surface: "${sup}"`), `${arq}: call without surface "${sup}": ${c}`);
  }
});

test("C1 — surface and agent become `<surface>:<agent>`", () => {
  assert.equal(telemetryCaller({ surface: "http", agent: "nox" }, true), "http:nox");
  assert.equal(telemetryCaller({ surface: "mcp", agent: "Atlas" }, true), "mcp:atlas");
  assert.equal(telemetryCaller({ surface: "cli" }, true), "cli:unknown");
  assert.equal(telemetryCaller({}, true), "unknown:unknown");
});

test("C2 — trackAccess=false (the probe marker) becomes `probe:<agent>`", () => {
  assert.equal(telemetryCaller({ surface: "http" }, false), "probe:unknown");
  assert.equal(telemetryCaller({ surface: "http", agent: "semantic-canary" }, false), "probe:semantic-canary");
});

test("C3 — a header-borne name only passes [a-z0-9_.-]{1,40}", () => {
  assert.equal(telemetryCaller({ surface: "http", agent: "x'; DROP TABLE chunks;--" }, true), "http:invalid");
  assert.equal(telemetryCaller({ surface: "http", agent: "a".repeat(41) }, true), "http:invalid");
  assert.equal(telemetryCaller({ surface: "http", agent: "   " }, true), "http:unknown");
});

test("D1 — was_temporal_query: 0 none, 1 word without date, 2 date in the query", () => {
  assert.equal(temporalQueryKind("how does salience work"), 0);
  assert.equal(temporalQueryKind(""), 0);
  assert.equal(temporalQueryKind("quando o compact foi pausado"), 1);
  assert.equal(temporalQueryKind("when did the deploy happen"), 1);
  assert.equal(temporalQueryKind("o que mudou em 2026-10-14"), 2);
  assert.equal(temporalQueryKind("decisões de abril de 2026"), 2);
  assert.equal(temporalQueryKind("roadmap 2026"), 2);
});

test("D2 — was_temporal_query does not depend on NOX_TEMPORAL_PATH", () => {
  const antes = process.env.NOX_TEMPORAL_PATH;
  try {
    delete process.env.NOX_TEMPORAL_PATH;
    assert.equal(temporalQueryKind("quando o compact foi pausado"), 1);
    process.env.NOX_TEMPORAL_PATH = "off";
    assert.equal(temporalQueryKind("o que mudou em 2026-10-14"), 2);
  } finally {
    if (antes === undefined) delete process.env.NOX_TEMPORAL_PATH; else process.env.NOX_TEMPORAL_PATH = antes;
  }
});
