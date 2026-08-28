// v19 — telemetria por chunk (`top_chunk_ids` / `top_scores`).
//
// Dois grupos de asserção, com propósitos diferentes:
//
//   (A) schema — a coluna existe tanto num install limpo quanto num DB legado
//       que já estava em v18. Um `ALTER TABLE` só no caminho de migração deixa
//       o install limpo sem a coluna; um `CREATE TABLE` só no caminho novo
//       deixa o DB existente sem ela. Os dois caminhos são testados separados
//       porque falham separado.
//
//   (B) privacidade — o INSERT de `search.ts` NÃO pode conter `query_text`.
//       Isso não é preferência de estilo: `db.ts` declara, no comentário do v6,
//       que "não armazenamos texto cru da query por privacidade". A coluna
//       `query_text` existe em alguns DBs por reconciliação de drift de schema,
//       e existir não é autorização para escrever. Este teste lê o fonte e
//       morde se alguém a reintroduzir — inclusive eu, que já fiz exatamente
//       isso uma vez.
//
// Run: npm run build && node --test dist/__tests__/telemetry-per-chunk.test.js

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const TMP_ROOT = mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-telemetry-test-"));
const TEST_DB = join(TMP_ROOT, "fresh.db");

process.env.NOX_DB_PATH = TEST_DB;

// dist/__tests__/ → ../../../src/search.ts
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

let getDb: () => Database.Database;
let closeDb: () => void;

before(async () => {
  const m = await import("../db.js");
  getDb = m.getDb;
  closeDb = m.closeDb;
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const colunas = (db: Database.Database, tabela: string): string[] =>
  (db.pragma(`table_info(${tabela})`) as Array<{ name: string }>).map((c) => c.name);

test("A1 — install limpo cria search_telemetry já com as duas colunas", () => {
  const cols = colunas(getDb(), "search_telemetry");
  assert.ok(cols.includes("top_chunk_ids"), `top_chunk_ids ausente: ${cols.join(", ")}`);
  assert.ok(cols.includes("top_scores"), `top_scores ausente: ${cols.join(", ")}`);
  closeDb();
});

test("A2 — DB legado parado em v18 ganha as colunas ao reabrir", async () => {
  const legado = join(TMP_ROOT, "v18.db");
  // Reconstrói o estado v6/v18: a tabela SEM as colunas novas, e o meta dizendo 18.
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
      expansion_skipped_reason TEXT
    );
    INSERT INTO meta (key, value) VALUES ('schema_version', '18');
  `);
  const antes = (raw.pragma("table_info(search_telemetry)") as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!antes.includes("top_chunk_ids"), "pré-condição do teste quebrou: legado já tinha a coluna");
  raw.close();

  process.env.NOX_DB_PATH = legado;
  // Especificador em variável: precisa de uma instância NOVA do módulo (db.js
  // memoiza a conexão em escopo de módulo), e o `?v18` faz o loader tratar como
  // outra entrada de cache. Literal aqui faria o tsc tentar resolver o arquivo.
  const espec = "../db.js?v18";
  const m = (await import(espec)) as typeof import("../db.js");
  const db = m.getDb();
  const depois = colunas(db, "search_telemetry");
  assert.ok(depois.includes("top_chunk_ids") && depois.includes("top_scores"), depois.join(", "));
  // E a migração não perdeu as colunas antigas.
  assert.ok(depois.includes("query_hash") && depois.includes("expansion_skipped_reason"));
  m.closeDb();
  process.env.NOX_DB_PATH = TEST_DB;
});

test("B1 — o INSERT de telemetria NÃO grava o texto cru da query", () => {
  const fonte = readFileSync(join(SRC, "search.ts"), "utf8");
  const m = fonte.match(/INSERT INTO search_telemetry \(([^)]*)\)/);
  assert.ok(m, "não achei o INSERT INTO search_telemetry em search.ts");
  const escritas = m[1].split(",").map((s) => s.trim());

  assert.ok(!escritas.includes("query_text"), `regressão de privacidade: ${escritas.join(", ")}`);
  assert.ok(escritas.includes("query_hash"), "o hash é a ÚNICA representação da query que pode ser gravada");
  assert.ok(escritas.includes("top_chunk_ids") && escritas.includes("top_scores"), escritas.join(", "));
});

test("B2 — a lista de colunas do INSERT casa com o número de parâmetros", () => {
  // Defeito mecânico clássico: adicionar coluna e esquecer o `?`, ou o argumento
  // do `.run()`. O SQLite aceita a discrepância de argumento em silêncio em
  // alguns casos, e a coluna nova fica NULL para sempre — que é indistinguível
  // de "a feature não foi usada".
  const fonte = readFileSync(join(SRC, "search.ts"), "utf8");
  const bloco = fonte.slice(fonte.indexOf("INSERT INTO search_telemetry"));
  const cols = bloco.match(/INSERT INTO search_telemetry \(([^)]*)\)/)![1].split(",").length;
  const placeholders = bloco.match(/VALUES \(([^)]*)\)/)![1].split(",").length;
  const args = bloco.slice(bloco.indexOf(".run(")).match(/\.run\(([^;]*)\)/)![1].split(",").length;
  assert.equal(placeholders, cols, `${cols} colunas mas ${placeholders} placeholders`);
  assert.equal(args, cols, `${cols} colunas mas ${args} argumentos no .run()`);
});
