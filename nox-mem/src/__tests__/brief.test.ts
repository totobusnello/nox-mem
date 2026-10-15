// F1 — testes do GET /api/brief (Session Priming Loop fase 1).
// Spec: memoria-nox specs/2026-06-04-F1-api-brief-implementation.md (T5).
//
// Run: cd tools/nox-mem && npx tsc && node --test dist/__tests__/brief.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  parseBriefParams,
  scopePatterns,
  extractOneLiner,
  titleFromSourceFile,
  buildBrief,
  renderBriefText,
  handleBrief,
  _resetBriefLogMemo,
  tokenSignature,
  isNearDup,
  type BriefDb,
} from "../api/brief.js";

// ─── Fixture ─────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-06-04T12:00:00Z");

function makeDb(): BriefDb & InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      source_file TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      chunk_type TEXT NOT NULL DEFAULT 'other',
      source_type TEXT,
      tier TEXT DEFAULT 'peripheral',
      pain REAL DEFAULT 0.2,
      importance REAL DEFAULT 0.5,
      retention_days INTEGER,
      source_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      last_accessed_at TEXT,
      access_count INTEGER DEFAULT 0
    );
  `);
  _resetBriefLogMemo();
  return db as unknown as BriefDb & InstanceType<typeof Database>;
}

interface ChunkSeed {
  source_file: string;
  chunk_text?: string;
  chunk_type?: string;
  pain?: number;
  importance?: number;
  access_count?: number;
  updated_at?: string;
  created_at?: string;
  source_date?: string | null;
}

function seed(db: BriefDb, rows: ChunkSeed[]): void {
  const ins = db.prepare(`
    INSERT INTO chunks (source_file, chunk_text, chunk_type, pain, importance,
                        access_count, created_at, updated_at, source_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    ins.run(
      r.source_file,
      r.chunk_text ?? "conteúdo padrão",
      r.chunk_type ?? "other",
      r.pain ?? 0.2,
      r.importance ?? 0.5,
      r.access_count ?? 0,
      r.created_at ?? "2026-06-01 00:00:00",
      r.updated_at ?? "2026-06-01 00:00:00",
      r.source_date ?? null,
    );
  }
}

// ─── parseBriefParams ────────────────────────────────────────────────────────

test("params: scope obrigatório", () => {
  const r = parseBriefParams({});
  assert.equal(r.ok, false);
});

test("params: scope malformado rejeitado", () => {
  for (const bad of ["a%b", "../etc", "a b", "-inicio"]) {
    const r = parseBriefParams({ scope: bad });
    assert.equal(r.ok, false, `esperava rejeitar: ${bad}`);
  }
});

test("brief: underscore no scope é escapado no LIKE — a_b não casa aXb", () => {
  const db = makeDb();
  seed(db, [
    { source_file: "a_b/doc.md", chunk_text: "scope certo" },
    { source_file: "aXb/doc.md", chunk_text: "wildcard leak" },
  ]);
  const r = buildBrief(db, { scope: "a_b", n: 10, format: "json" }, NOW);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].one_liner, "scope certo");
});

test("params: defaults n=10 format=json", () => {
  const r = parseBriefParams({ scope: "NUVIVI" });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.params.n, 10);
    assert.equal(r.params.format, "json");
  }
});

test("params: n cap em 25", () => {
  const r = parseBriefParams({ scope: "NUVIVI", n: "999" });
  assert.ok(r.ok && r.params.n === 25);
});

test("params: since 30d/24h/2w aceitos, lixo rejeitado", () => {
  assert.ok(parseBriefParams({ scope: "x", since: "30d" }).ok);
  assert.ok(parseBriefParams({ scope: "x", since: "24h" }).ok);
  assert.ok(parseBriefParams({ scope: "x", since: "2w" }).ok);
  assert.equal(parseBriefParams({ scope: "x", since: "amanhã" }).ok, false);
});

// ─── scopePatterns ───────────────────────────────────────────────────────────

test("scopePatterns: scope vira 4 namespaces; agent adiciona sessions/", () => {
  const p = scopePatterns("memoria-nox", "cipher");
  assert.ok(p.includes("memory/mac-docs/memoria-nox/%"));
  assert.ok(p.includes("shared/imports/Claude/Projetos/memoria-nox/%"));
  assert.ok(p.includes("sessions/cipher/%"));
  assert.equal(p.length, 5);
});

test("scopePatterns: global sem filtro de path", () => {
  assert.equal(scopePatterns("global").length, 0);
  assert.deepEqual(scopePatterns("global", "atlas"), ["sessions/atlas/%"]);
});

// ─── extractOneLiner / titleFromSourceFile ───────────────────────────────────

test("one_liner: pula frontmatter e vazias, strip heading, cap 140", () => {
  assert.equal(extractOneLiner("---\n\n## Título Forte\ncorpo"), "Título Forte");
  assert.equal(extractOneLiner("- **item** bold"), "item bold");
  assert.equal(extractOneLiner(""), "");
  const longo = "x".repeat(300);
  assert.equal(extractOneLiner(longo).length, 140);
});

test("title: basename sem extensão", () => {
  assert.equal(titleFromSourceFile("memory/mac-docs/NUVIVI/relatorio-q2.md"), "relatorio-q2");
});

// ─── v1.1 polish (gate T7: quirks observados em prod) ───────────────────────

test("v1.1 one_liner: strip de tags HTML (docs OCR/import)", () => {
  assert.equal(
    extractOneLiner("<u>CONTRATO DE COMPRA</u> e venda de ações"),
    "CONTRATO DE COMPRA e venda de ações",
  );
  // linha só de tags é pulada
  assert.equal(extractOneLiner("<div><br/></div>\nconteúdo real"), "conteúdo real");
});

test("v1.1 age_days: usa source_date (idade do conteúdo), não updated_at tocado por cron", () => {
  const db = makeDb();
  seed(db, [{
    source_file: "x/doc-abril.md",
    source_date: "2026-04-21",
    created_at: "2026-05-25 00:00:00", // re-ingest pós-restore
    updated_at: "2026-06-04 01:00:00", // cron noturno tocou
  }]);
  const r = buildBrief(db, { scope: "x", n: 1, format: "json" }, NOW);
  assert.equal(r.items[0].age_days, 44); // 2026-04-21 → 2026-06-04
});

test("v1.1 dedup: cópia idêntica não gasta slot; próximo único preenche", () => {
  const db = makeDb();
  seed(db, [
    { source_file: "x/design-merge.md", chunk_text: "## Design de merge\ncorpo", importance: 0.9 },
    { source_file: "y/design-merge.md", chunk_text: "## Design de merge\ncorpo", importance: 0.8 }, // dupe (mesmo title+one_liner)
    { source_file: "x/outro-doc.md", chunk_text: "## Outro doc\ncorpo", importance: 0.3 },
  ]);
  const r = buildBrief(db, { scope: "global", n: 2, format: "json" }, NOW);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].title, "design-merge");
  assert.equal(r.items[1].title, "outro-doc"); // dupe pulado, único entrou
  assert.ok(r.items[0].salience >= r.items[1].salience);
});

// ─── buildBrief ──────────────────────────────────────────────────────────────

test("brief: filtra por scope — não vaza namespace alheio", () => {
  const db = makeDb();
  seed(db, [
    { source_file: "memory/mac-docs/NUVIVI/a.md", chunk_text: "doc nuvini" },
    { source_file: "memory/mac-docs/PESSOAL/b.md", chunk_text: "doc pessoal" },
    { source_file: "sessions/cipher/s1.md", chunk_text: "sessão cipher" },
  ]);
  const r = buildBrief(db, { scope: "NUVIVI", n: 10, format: "json" }, NOW);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].one_liner, "doc nuvini");
});

test("brief: agent compõe em união com scope", () => {
  const db = makeDb();
  seed(db, [
    { source_file: "memory/mac-docs/NUVIVI/a.md" },
    { source_file: "sessions/cipher/s1.md" },
    { source_file: "sessions/atlas/s2.md" },
  ]);
  const r = buildBrief(db, { scope: "NUVIVI", agent: "cipher", n: 10, format: "json" }, NOW);
  assert.equal(r.items.length, 2); // NUVIVI + cipher; atlas fora
});

test("brief: ranking por salience — importance alta + acessado vence default antigo", () => {
  const db = makeDb();
  // chunk_texts distintos: corpos idênticos colapsariam por near-dup (v1.2a, correto)
  seed(db, [
    { source_file: "x/baixo.md", chunk_text: "registro antigo irrelevante sem acesso", importance: 0.1, pain: 0.2, access_count: 0, updated_at: "2025-01-01 00:00:00" },
    { source_file: "x/alto.md", chunk_text: "decisão crítica recente muito consultada", importance: 0.95, pain: 0.9, access_count: 40, updated_at: "2026-06-03 00:00:00" },
  ]);
  const r = buildBrief(db, { scope: "x", n: 2, format: "json" }, NOW);
  assert.equal(r.items[0].title, "alto");
  assert.ok(r.items[0].salience > r.items[1].salience);
});

test("brief: n limita itens; scope vazio = 200 com items []", () => {
  const db = makeDb();
  seed(db, [
    { source_file: "x/1.md" }, { source_file: "x/2.md" }, { source_file: "x/3.md" },
  ]);
  assert.equal(buildBrief(db, { scope: "x", n: 2, format: "json" }, NOW).items.length, 2);
  assert.equal(buildBrief(db, { scope: "inexistente", n: 5, format: "json" }, NOW).items.length, 0);
});

test("brief: since exclui updated_at antigo", () => {
  const db = makeDb();
  seed(db, [
    { source_file: "x/velho.md", updated_at: "2026-01-01 00:00:00" },
    { source_file: "x/novo.md" }, // default 2026-06-01 — mas since usa datetime('now') real;
  ]);
  // novo: updated_at = agora (insert com datetime explícito recente não dá — usar now real)
  db.prepare("UPDATE chunks SET updated_at = datetime('now') WHERE source_file = ?").run("x/novo.md");
  const r = buildBrief(db, { scope: "x", n: 10, format: "json", sinceSql: "-30 days" }, NOW);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, "novo");
});

// ─── renderBriefText ─────────────────────────────────────────────────────────

test("text: header + linhas no formato pointer; respeita budget", () => {
  const db = makeDb();
  seed(db, [{ source_file: "x/a.md", chunk_text: "## Lição\ncorpo", chunk_type: "lesson", pain: 0.9 }]);
  const r = buildBrief(db, { scope: "x", n: 5, format: "text" }, NOW);
  const txt = renderBriefText(r);
  assert.match(txt, /^# nox-mem brief — scope=x/);
  assert.match(txt, /\[lesson\|pain 0\.9\|\d+d\] a — Lição \(chk \d+\)/);
});

test("text: budget de ~1200 tokens trunca antes de n", () => {
  const db = makeDb();
  const rows: ChunkSeed[] = [];
  for (let i = 0; i < 25; i++) {
    rows.push({ source_file: `x/${"t".repeat(120)}-${i}.md`, chunk_text: "y".repeat(400) });
  }
  seed(db, rows);
  const r = buildBrief(db, { scope: "x", n: 25, format: "text" }, NOW);
  const txt = renderBriefText(r);
  assert.ok(txt.length / 4 <= 1300, `texto estourou budget: ~${Math.ceil(txt.length / 4)} tokens`);
  assert.ok(txt.split("\n").length - 2 < 25, "deveria truncar antes de 25 itens");
});

// ─── handleBrief (integração + invariantes) ──────────────────────────────────

test("handle: 400 em scope ausente/inválido", () => {
  const db = makeDb();
  assert.equal((handleBrief(db, {}) as { status: number }).status, 400);
  assert.equal((handleBrief(db, { scope: "a%b" }) as { status: number }).status, 400);
});

test("handle: serve brief, loga em brief_log e NÃO toca access_count", () => {
  const db = makeDb();
  seed(db, [
    { source_file: "memory/mac-docs/NUVIVI/a.md", access_count: 7 },
    { source_file: "memory/mac-docs/NUVIVI/b.md", access_count: 0 },
  ]);
  const out = handleBrief(db, { scope: "NUVIVI" });
  assert.equal(out.status, 200);

  const logged = db.prepare("SELECT COUNT(*) c FROM brief_log WHERE scope='NUVIVI'").get() as { c: number };
  assert.equal(logged.c, 2);

  // Invariante central (§2.3): access_count orgânico permanece intocado.
  const counts = db.prepare("SELECT access_count FROM chunks ORDER BY id").all() as { access_count: number }[];
  assert.deepEqual(counts.map((r) => r.access_count), [7, 0]);
});

// ─── v1.2 (gate F3 real: brief do Nox) ───────────────────────────────────────

test("v1.2a near-dup: variantes HEARTBEAT colapsam; itens distintos não", () => {
  const a = tokenSignature("nota", "Ler HEARTBEAT.md do workspace e seguir estritamente");
  const b = tokenSignature("nota", "Seguir HEARTBEAT.md estritamente, sem inferir tarefas");
  const c = tokenSignature("nota", "Contrato Malvas x Treviso x GLPG pendente");
  assert.ok(isNearDup(a, b), "variantes HEARTBEAT deveriam colapsar");
  assert.ok(!isNearDup(a, c), "itens distintos não podem colapsar");
});

test("v1.2a brief: só 1 variante HEARTBEAT sobrevive; slots vão pra itens novos", () => {
  const db = makeDb();
  seed(db, [
    { source_file: "x/n1.md", chunk_text: "Ler HEARTBEAT.md do workspace e seguir estritamente", importance: 0.9 },
    { source_file: "x/n2.md", chunk_text: "Seguir HEARTBEAT.md estritamente, sem inferir ou repetir tarefas", importance: 0.85 },
    { source_file: "x/n3.md", chunk_text: "Usar agents/nox/HEARTBEAT.md exatamente como está, seguir estritamente", importance: 0.8 },
    { source_file: "x/n4.md", chunk_text: "Contrato Malvas x Treviso x GLPG pendente", importance: 0.3 },
    { source_file: "x/n5.md", chunk_text: "Invoice Aspen dezembro janeiro — Sylinc", importance: 0.25 },
  ]);
  const r = buildBrief(db, { scope: "x", n: 3, format: "json" }, NOW);
  const liners = r.items.map((i) => i.one_liner);
  assert.equal(liners.filter((l) => l.includes("HEARTBEAT")).length, 1, "só 1 HEARTBEAT");
  assert.ok(liners.some((l) => l.includes("Malvas")));
  assert.ok(liners.some((l) => l.includes("Aspen")));
});

test("v1.2b união: agent traz sessions E itens globais high-salience", () => {
  const db = makeDb();
  seed(db, [
    // pool do agente (sessions/nox)
    { source_file: "sessions/nox/s1.md", chunk_text: "Pendência alfa do nox", importance: 0.7 },
    { source_file: "sessions/nox/s2.md", chunk_text: "Pendência beta do nox", importance: 0.65 },
    { source_file: "sessions/nox/s3.md", chunk_text: "Pendência gama do nox", importance: 0.6 },
    // pool global (alta salience — lições/incidents)
    { source_file: "memory/lessons/incident-x.md", chunk_text: "Lição incident gateway crítica", importance: 0.95, pain: 0.9, access_count: 50 },
    { source_file: "memory/lessons/regra-y.md", chunk_text: "Regra crítica de produção zeta", importance: 0.9, pain: 0.8, access_count: 30 },
  ]);
  const r = buildBrief(db, { scope: "global", agent: "nox", n: 4, format: "json" }, NOW);
  const fromAgent = r.items.filter((i) => i.one_liner.includes("nox")).length;
  const fromGlobal = r.items.filter((i) => i.one_liner.includes("incident") || i.one_liner.includes("Regra")).length;
  assert.ok(fromAgent >= 2, `esperava ≥2 do agente, veio ${fromAgent}`);
  assert.ok(fromGlobal >= 2, `esperava ≥2 globais, veio ${fromGlobal}`);
});

test("v1.2b backfill: pool global magro ⇒ agente preenche o resto", () => {
  const db = makeDb();
  seed(db, [
    { source_file: "sessions/lex/s1.md", chunk_text: "Item um do lex" },
    { source_file: "sessions/lex/s2.md", chunk_text: "Item dois do lex" },
    { source_file: "sessions/lex/s3.md", chunk_text: "Item três do lex" },
    { source_file: "sessions/lex/s4.md", chunk_text: "Item quatro do lex" },
  ]);
  const r = buildBrief(db, { scope: "global", agent: "lex", n: 4, format: "json" }, NOW);
  assert.equal(r.items.length, 4, "backfill deve completar os 4 slots só com o agente");
});

test("handle: format=text retorna text/plain pronto pra hook", () => {
  const db = makeDb();
  seed(db, [{ source_file: "sessions/cipher/s.md", chunk_text: "## Estado\nok" }]);
  const out = handleBrief(db, { scope: "global", agent: "cipher", format: "text" });
  assert.equal(out.status, 200);
  assert.ok("text" in out && out.text.startsWith("# nox-mem brief — scope=global agent=cipher"));
});

// ─── título de itens distilled (2026-10-15) ──────────────────────────────────
// O título era o basename do source_file ("lex:d12d3a69-…"), o id da sessão: ~45 caracteres sem
// informação. Passa a ser "sessão <agente> <data>". Só renderização: dedup e diversidade continuam
// usando o basename, então a seleção não muda.

const UUID_A = "d12d3a69-2579-4bcf-8fdd-e21e31dec4be";
const UUID_B = "54091067-ebe0-4175-ae61-ba24d939272e";

function distilledFixture(db: BriefDb): void {
  seed(db, [
    { source_file: `sessions/lex/lex:${UUID_A}`, chunk_type: "distilled", source_date: "2026-06-01",
      chunk_text: "[lesson|lex] entregue" },
    // mesma data, mesmo texto curto, outra sessão: hoje os dois entram (a chave de dedup carrega o uuid);
    // se o título novo vazasse para dedup/diversidade, um deles cairia.
    { source_file: `sessions/lex/lex:${UUID_B}`, chunk_type: "distilled", source_date: "2026-06-01",
      chunk_text: "[lesson|lex] entregue" },
    { source_file: "memory/lessons.md", chunk_type: "lesson", source_date: "2026-05-30",
      chunk_text: "SQLite com múltiplos writers exige coordenação" },
  ]);
}

test("brief: item distilled leva título 'sessão <agente> <data>', não o id da sessão", () => {
  const db = makeDb();
  distilledFixture(db);
  const r = buildBrief(db, { scope: "global", n: 10, format: "json" }, NOW);
  const titles = r.items.map((i) => i.title);
  assert.ok(titles.every((t) => !t.includes(UUID_A) && !t.includes(UUID_B)), titles.join(" | "));
  assert.ok(titles.includes("sessão lex 2026-06-01"), titles.join(" | "));
  assert.ok(titles.includes("lessons"), "outros tipos mantêm o basename");
});

test("brief: o título novo não muda quais itens são selecionados", () => {
  const db = makeDb();
  distilledFixture(db);
  const r = buildBrief(db, { scope: "global", n: 10, format: "json" }, NOW);
  assert.deepEqual(r.items.map((i) => i.id).sort((a, b) => a - b), PINNED_DISTILLED_IDS);
});
const PINNED_DISTILLED_IDS: number[] = [1, 2, 3];
