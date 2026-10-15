/**
 * F1 — GET /api/brief (Session Priming Loop, fase 1)
 *
 * Pointer-pattern priming digest: top-N chunks por salience filtrados por
 * escopo. Toda sessão (agente OpenClaw, Claude Code Mac, qualquer cliente
 * MCP/HTTP) nasce contextualizada sem search cego.
 *
 * Specs (memoria-nox):
 *   - PRD:  specs/2026-06-04-session-priming-loop.md (§6 contrato)
 *   - Impl: specs/2026-06-04-F1-api-brief-implementation.md (T0 findings)
 *
 * Invariantes:
 *   - Read-only sobre `chunks`. NÃO toca `chunks.access_count` — o sinal
 *     orgânico fica 100% puro pro audit mensal do Cipher (high-pain órfãos).
 *     Tracking de serving vai pra tabela própria `brief_log`.
 *   - NÃO altera scoring de search (regra #5 do repo) — consome
 *     `calculateSalience` canônica as-is, sem fork nem pesos próprios.
 *   - Framework-agnostic (mesmo padrão de src/api/conflict.ts): handler puro
 *     testável; api-server.ts faz o dispatch HTTP.
 *
 * Scope mapping (T0 2026-06-04, validado em prod 100.5k chunks):
 *   - agent  → `sessions/<persona>/%`           (cipher 7.6k, atlas 3.8k…)
 *   - scope  → `memory/mac-docs/<scope>/%`      (NUVIVI, PESSOAL, PPR…)
 *            | `shared/imports/Claude/Projetos/<scope>/%`
 *            | `shared/imports/<scope>/%`
 *            | `<scope>/%`                      (namespaces top-level)
 *   - global → sem filtro de path
 *
 * Changelog:
 *   - v1.1 (gate T7): age por source_date; dedup exato (title,one_liner);
 *     strip HTML no one_liner.
 *   - v1.2 (gate F3 real, Nox): (a) collapse de near-dups por Jaccard de
 *     tokens; (b) com `agent`, união garantida agente ∪ scope/global
 *     (~n/2 slots cada, backfill mútuo).
 */

import { calculateSalience, type SalienceInput } from "../salience.js";
import {
  type DiversityConfig,
  type BriefDiff,
  briefScore,
  diffBriefs,
  diversityConfigFromEnv,
} from "./brief-diversity.js";

// ─── Tipos estruturais (espelha lib/conflict/db.ts::DBHandle) ────────────────

interface PreparedStatement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
}

export interface BriefDb {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
}

// ─── Contrato ────────────────────────────────────────────────────────────────

export interface BriefItem {
  id: number;
  title: string;
  one_liner: string;
  type: string | null;
  pain: number;
  salience: number;
  age_days: number;
}

export interface BriefResult {
  scope: string;
  agent?: string;
  generated_at: string;
  items: BriefItem[];
  token_estimate: number;
}

export type BriefResponse =
  | { status: number; body: unknown }
  | { status: number; text: string };

// ─── Constantes ──────────────────────────────────────────────────────────────

const DEFAULT_N = 10;
const MAX_N = 25;
/** Pool de candidatos pré-ranqueado em SQL antes do re-rank exato por salience.
 *  Proxy barato (importance + pain + access binário) aproxima a fórmula v2
 *  aditiva; 500 rows re-ranqueadas em JS mantém p50 < 100ms em corpus 100k+. */
const CANDIDATE_POOL = 500;
/** Budget do digest em tokens estimados (chars/4) — princípio 4.3 do PRD. */
const TOKEN_BUDGET = 1200;
const ONE_LINER_MAX = 140;

const SCOPE_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SINCE_RE = /^(\d{1,4})([hdw])$/;

// ─── Validação e parsing ─────────────────────────────────────────────────────

export interface BriefParams {
  scope: string;
  agent?: string;
  n: number;
  format: "json" | "text";
  sinceSql?: string;
}

export function parseBriefParams(
  q: Record<string, string>,
): { ok: true; params: BriefParams } | { ok: false; error: string } {
  const scope = (q.scope || "").trim();
  if (!scope) return { ok: false, error: "scope é obrigatório" };
  if (!SCOPE_RE.test(scope)) {
    return { ok: false, error: "scope inválido (alfanumérico + ._- , máx 64)" };
  }

  let agent: string | undefined;
  if (q.agent !== undefined && q.agent !== "") {
    if (!AGENT_RE.test(q.agent)) {
      return { ok: false, error: "agent inválido (slug a-z0-9-, máx 32)" };
    }
    agent = q.agent;
  }

  let n = DEFAULT_N;
  if (q.n !== undefined && q.n !== "") {
    const parsed = parseInt(q.n, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return { ok: false, error: "n inválido (inteiro ≥ 1)" };
    }
    n = Math.min(parsed, MAX_N);
  }

  const format = q.format === "text" ? "text" : "json";

  let sinceSql: string | undefined;
  if (q.since !== undefined && q.since !== "") {
    const m = SINCE_RE.exec(q.since);
    if (!m) return { ok: false, error: "since inválido (ex: 24h, 30d, 2w)" };
    const unit = { h: "hours", d: "days", w: "days" }[m[2] as "h" | "d" | "w"];
    const qty = m[2] === "w" ? parseInt(m[1], 10) * 7 : parseInt(m[1], 10);
    sinceSql = `-${qty} ${unit}`;
  }

  return { ok: true, params: { scope, agent, n, format, sinceSql } };
}

// ─── Scope → LIKE patterns ───────────────────────────────────────────────────

/** Escapa metachars do LIKE (`%`, `_`, `\`) no trecho dinâmico — os wildcards
 *  `%` dos patterns são adicionados depois. Queries usam `ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function scopePatterns(scope: string, agent?: string): string[] {
  const patterns: string[] = [];
  if (scope !== "global") {
    const esc = escapeLike(scope);
    patterns.push(
      `memory/mac-docs/${esc}/%`,
      `shared/imports/Claude/Projetos/${esc}/%`,
      `shared/imports/${esc}/%`,
      `${esc}/%`,
    );
  }
  if (agent) patterns.push(`sessions/${escapeLike(agent)}/%`);
  return patterns;
}

// ─── Extração de digest ──────────────────────────────────────────────────────

/** v1.2a — assinatura de tokens pra collapse de near-duplicates.
 *  Gate F3 real (2026-06-04): 4/10 itens do brief do Nox eram variantes de
 *  "Ler/Usar/Seguir HEARTBEAT.md ... estritamente" — dedup exato não pega.
 *
 *  Métrica: CONTAINMENT (interseção / menor assinatura), não Jaccard —
 *  variantes curtas vs longas do mesmo assunto diluem o Jaccard mas mantêm
 *  containment alto. Guarda: assinaturas < MIN_SIG tokens só dedupam por
 *  match exato (containment em sets minúsculos over-colapsa). Mantém sempre
 *  o candidato de maior salience. */
const NEAR_DUP_CONTAINMENT = 0.6;
const MIN_SIG_TOKENS = 3;

export function tokenSignature(title: string, oneLiner: string): Set<string> {
  const tokens = `${title} ${oneLiner}`
    .toLowerCase()
    .split(/[^\p{L}\p{N}.]+/u)
    .filter((t) => t.length >= 4);
  return new Set(tokens);
}

export function isNearDup(a: Set<string>, b: Set<string>): boolean {
  if (a.size < MIN_SIG_TOKENS || b.size < MIN_SIG_TOKENS) return false;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size) >= NEAR_DUP_CONTAINMENT;
}

/** Primeira linha "de conteúdo": pula vazias, fences de frontmatter (---) e
 *  marcação estrutural; strip de tags HTML (docs OCR/import vazam <u> etc.),
 *  heading/list markers; cap ONE_LINER_MAX. */
export function extractOneLiner(text: string | null | undefined): string {
  if (!text) return "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!line || line === "---" || line === "```") continue;
    const cleaned = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*>]\s+/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (!cleaned) continue;
    return cleaned.length > ONE_LINER_MAX
      ? cleaned.slice(0, ONE_LINER_MAX - 1) + "…"
      : cleaned;
  }
  return "";
}

/** Datas do SQLite vêm "YYYY-MM-DD HH:MM:SS" (UTC) ou "YYYY-MM-DD" (source_date).
 *  Date.parse direto trata date-only como UTC; o formato com espaço precisa
 *  virar ISO + Z explícito pra não cair em timezone local. */
export function parseDbDateMs(ref: string): number {
  if (ref.includes(" ")) return Date.parse(ref.replace(" ", "T") + "Z");
  return Date.parse(ref);
}

export function titleFromSourceFile(sourceFile: string | null | undefined): string {
  if (!sourceFile) return "(sem origem)";
  const base = sourceFile.split("/").pop() || sourceFile;
  return base.replace(/\.(md|txt|json|jsonl)$/i, "");
}

/**
 * Título exibido (2026-10-15). Itens distilled têm source_file "sessions/<agente>/<agente>:<uuid>", e o
 * basename era só o id da sessão. Exibe "sessão <agente> <data>". Só renderização: dedup e diversidade
 * continuam com titleFromSourceFile, então a seleção não muda.
 */
const SESSION_TITLE = /^([a-z0-9_-]+):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function displayTitle(title: string, chunkType: string | null, contentDate: string | null): string {
  if (chunkType !== "distilled") return title;
  const m = SESSION_TITLE.exec(title);
  if (!m) return title;
  return contentDate ? `sessão ${m[1]} ${contentDate.slice(0, 10)}` : `sessão ${m[1]}`;
}

// ─── brief_log (única escrita do endpoint — schema próprio, zero ALTER) ─────

let briefLogReady = false;

export function ensureBriefLog(db: BriefDb): void {
  if (briefLogReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_log (
      id INTEGER PRIMARY KEY,
      chunk_id INTEGER NOT NULL,
      scope TEXT NOT NULL,
      agent TEXT,
      served_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_brief_log_chunk ON brief_log(chunk_id, served_at);
  `);
  briefLogReady = true;
}

/** Test-only: reseta o memo de criação (cada DB de teste é novo). */
export function _resetBriefLogMemo(): void {
  briefLogReady = false;
}

// ─── Core ────────────────────────────────────────────────────────────────────

interface CandidateRow {
  id: number;
  source_file: string | null;
  chunk_text: string | null;
  chunk_type: string | null;
  source_type: string | null;
  tier: string | null;
  pain: number | null;
  importance: number | null;
  retention_days: number | null;
  source_date: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_accessed_at: string | null;
  access_count: number | null;
}

interface RankedCandidate {
  row: CandidateRow;
  salience: number;
  /** D2: salience − novelty penalty (re-rank pós-salience). Default = salience. */
  briefScore?: number;
  /** D2: marcado quando entrou via freshness slot (parte B). */
  fresh?: boolean;
}

interface Picked extends RankedCandidate {
  title: string;
  oneLiner: string;
}

/** Pool de candidatos: pré-rank SQL barato (proxy da fórmula v2 aditiva)
 *  → LIMIT 500 → re-rank exato com calculateSalience. */
function fetchRankedPool(
  db: BriefDb,
  patterns: string[],
  sinceSql: string | undefined,
  nowMs: number,
): RankedCandidate[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (patterns.length > 0) {
    where.push(`(${patterns.map(() => "source_file LIKE ? ESCAPE '\\'").join(" OR ")})`);
    args.push(...patterns);
  }
  if (sinceSql) {
    where.push("updated_at >= datetime('now', ?)");
    args.push(sinceSql);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT id, source_file, chunk_text, chunk_type, source_type, tier,
              pain, importance, retention_days, source_date, created_at,
              updated_at, last_accessed_at, access_count
         FROM chunks
         ${whereSql}
        ORDER BY (0.55 * COALESCE(importance, 0.5)
                + 0.10 * COALESCE(pain, 0.2)
                + CASE WHEN COALESCE(access_count, 0) > 0 THEN 0.1 ELSE 0 END) DESC,
                 updated_at DESC
        LIMIT ${CANDIDATE_POOL}`,
    )
    .all(...args) as CandidateRow[];

  return rows
    .map((r) => ({
      row: r,
      salience: calculateSalience(r as SalienceInput, nowMs),
    }))
    .sort((a, b) => b.salience - a.salience);
}

/** Score efetivo do re-rank: briefScore (D2) quando presente, senão salience. */
function effScore(c: RankedCandidate): number {
  return c.briefScore ?? c.salience;
}

/** Seleção com dedup global (exato por id + near-dup por assinatura de tokens,
 *  v1.2a) — mantém sempre o candidato de maior score. Parametrizado por
 *  `scoreOf` (off=salience, D2=briefScore) e por freshness slots (parte B):
 *  reserva `freshSlots` dos `n`, preenchidos com `freshPool` (recência) após
 *  os slots principais; backfill cobre fresh insuficiente. Com freshSlots=0 e
 *  scoreOf=salience reproduz exatamente o pick v1.2 (off bit-idêntico). */
function pickDedup(
  pools: RankedCandidate[][],
  quotas: number[],
  n: number,
  scoreOf: (c: RankedCandidate) => number,
  freshPool: RankedCandidate[] = [],
  freshSlots = 0,
  pinnedIds: Set<number> = new Set(),
): Picked[] {
  const picked: Picked[] = [];
  const seenIds = new Set<number>();
  const seenKeys = new Set<string>();
  const seenSigs: Set<string>[] = [];

  const tryPick = (cand: RankedCandidate, asFresh = false): boolean => {
    if (seenIds.has(cand.row.id)) return false;
    const title = titleFromSourceFile(cand.row.source_file);
    const oneLiner = extractOneLiner(cand.row.chunk_text);
    // Dedup exato (v1.1) — cinto de segurança pra assinaturas < MIN_SIG_TOKENS.
    const key = `${title}|${oneLiner}`;
    if (seenKeys.has(key)) return false;
    const sig = tokenSignature(title, oneLiner);
    for (const s of seenSigs) if (isNearDup(s, sig)) return false;
    seenIds.add(cand.row.id);
    seenKeys.add(key);
    seenSigs.push(sig);
    picked.push({ ...cand, fresh: asFresh || cand.fresh, title, oneLiner });
    return true;
  };

  const mainTarget = Math.max(0, n - freshSlots);

  // Fase 0 (D2 floor — invariante #4): pinned = high-pain que JÁ estavam no
  // brief atual. Entram primeiro e nunca são expulsos pelo freshness slot (que
  // reserva slots e empurraria os últimos por salience pra fora). Sem isto, B
  // podia esconder incident pain≥0.9. Pinned excedente come dos fresh slots.
  if (pinnedIds.size > 0) {
    const pinnedCands = pools
      .flat()
      .filter((c) => pinnedIds.has(c.row.id))
      .sort((a, b) => scoreOf(b) - scoreOf(a));
    for (const c of pinnedCands) {
      if (picked.length >= n) break;
      tryPick(c);
    }
  }

  // Fase 1: cotas por pool (ordem de score dentro de cada pool).
  pools.forEach((pool, i) => {
    let got = 0;
    for (const cand of pool) {
      if (got >= quotas[i] || picked.length >= mainTarget) break;
      if (tryPick(cand)) got++;
    }
  });
  // Fase 2: backfill até mainTarget com as sobras de todos os pools (score global).
  if (picked.length < mainTarget) {
    const leftovers = pools.flat().sort((a, b) => scoreOf(b) - scoreOf(a));
    for (const cand of leftovers) {
      if (picked.length >= mainTarget) break;
      tryPick(cand);
    }
  }
  // Fase 3 (D2 parte B): freshness slots — novidade recente relevante.
  let freshGot = 0;
  for (const cand of freshPool) {
    if (freshGot >= freshSlots || picked.length >= n) break;
    if (tryPick(cand, true)) freshGot++;
  }
  // Fase 4: backfill restante até n (fresh insuficiente cai pros pools).
  if (picked.length < n) {
    const leftovers = pools.flat().sort((a, b) => scoreOf(b) - scoreOf(a));
    for (const cand of leftovers) {
      if (picked.length >= n) break;
      tryPick(cand);
    }
  }
  picked.sort((a, b) => scoreOf(b) - scoreOf(a));
  return picked;
}

function toItems(picked: Picked[], nowMs: number): BriefItem[] {
  return picked.map(({ row, salience, title, oneLiner }) => {
    // v1.1: idade do CONTEÚDO (source_date ?? created_at), não do último toque.
    const ref = row.source_date ?? row.created_at ?? row.updated_at;
    const refMs = ref ? parseDbDateMs(ref) : NaN;
    const ageDays = Number.isFinite(refMs)
      ? Math.max(0, Math.floor((nowMs - refMs) / 86_400_000))
      : 0;
    return {
      id: row.id,
      title: displayTitle(title, row.chunk_type, ref ?? null),
      one_liner: oneLiner,
      type: row.chunk_type,
      pain: row.pain ?? 0.2,
      salience: Math.round(salience * 10_000) / 10_000,
      age_days: ageDays,
    };
  });
}

function assembleResult(params: BriefParams, items: BriefItem[], nowMs: number): BriefResult {
  const tokenEstimate = Math.ceil(
    items.reduce((acc, i) => acc + i.title.length + i.one_liner.length + 24, 0) / 4,
  );
  return {
    scope: params.scope,
    ...(params.agent ? { agent: params.agent } : {}),
    generated_at: new Date(nowMs).toISOString(),
    items,
    token_estimate: tokenEstimate,
  };
}

/** Monta os pools (união agente ∪ scope/global) + cotas — v1.2b. */
function buildPools(
  db: BriefDb,
  params: BriefParams,
  nowMs: number,
): { pools: RankedCandidate[][]; quotas: number[] } {
  const scopeOnly = scopePatterns(params.scope);
  const pools: RankedCandidate[][] = [];
  const quotas: number[] = [];
  if (params.agent) {
    pools.push(fetchRankedPool(db, scopePatterns("global", params.agent), params.sinceSql, nowMs));
    quotas.push(Math.ceil(params.n / 2));
    pools.push(fetchRankedPool(db, scopeOnly, params.sinceSql, nowMs));
    quotas.push(Math.floor(params.n / 2));
  } else {
    pools.push(fetchRankedPool(db, scopeOnly, params.sinceSql, nowMs));
    quotas.push(params.n);
  }
  return { pools, quotas };
}

export function buildBrief(
  db: BriefDb,
  params: BriefParams,
  nowMs: number = Date.now(),
): BriefResult {
  // v1.2b: com `agent`, o brief é UNIÃO GARANTIDA — ~metade dos slots pro
  // pool do agente, ~metade pro scope/global, backfill mútuo se um vier magro.
  const { pools, quotas } = buildPools(db, params, nowMs);
  const picked = pickDedup(pools, quotas, params.n, (c) => c.salience);
  return assembleResult(params, toItems(picked, nowMs), nowMs);
}

// ─── D2: serve-history + freshness (queries; lógica pura em brief-diversity) ──

/** Parte A — nº de serves por chunk na janela T (1 query agregada, índice
 *  idx_brief_log_chunk). Read-only sobre brief_log; tabela própria. */
export function serveCounts(
  db: BriefDb,
  ids: number[],
  windowSql: string,
): Map<number, number> {
  const counts = new Map<number, number>();
  if (ids.length === 0) return counts;
  try {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT chunk_id, COUNT(*) AS n
           FROM brief_log
          WHERE chunk_id IN (${placeholders})
            AND served_at > datetime('now', ?)
          GROUP BY chunk_id`,
      )
      .all(...ids, windowSql) as { chunk_id: number; n: number }[];
    for (const r of rows) counts.set(r.chunk_id, r.n);
  } catch {
    // fail-open (invariante #3): sem serve-history ⇒ penalty 0 pra todos.
  }
  return counts;
}

/** Parte B — candidatos de freshness: recentes, relevantes e NÃO servidos na
 *  janela. Query própria (o pool de 500 prioriza importance+access, barra
 *  recentes com access=0). Ordenado por recência do conteúdo. */
function fetchFreshCandidates(
  db: BriefDb,
  patterns: string[],
  cfg: DiversityConfig,
  nowMs: number,
): RankedCandidate[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (patterns.length > 0) {
    where.push(`(${patterns.map(() => "source_file LIKE ? ESCAPE '\\'").join(" OR ")})`);
    args.push(...patterns);
  }
  where.push("(COALESCE(importance, 0) >= ? OR COALESCE(pain, 0) >= ?)");
  args.push(cfg.freshMinImp, cfg.freshMinPain);
  where.push(
    "julianday('now') - julianday(COALESCE(source_date, created_at)) <= ?",
  );
  args.push(cfg.freshMaxAgeDays);
  where.push(
    "id NOT IN (SELECT chunk_id FROM brief_log WHERE served_at > datetime('now', ?))",
  );
  args.push(cfg.windowSql);

  try {
    const rows = db
      .prepare(
        `SELECT id, source_file, chunk_text, chunk_type, source_type, tier,
                pain, importance, retention_days, source_date, created_at,
                updated_at, last_accessed_at, access_count
           FROM chunks
          WHERE ${where.join(" AND ")}
          ORDER BY COALESCE(source_date, created_at) DESC
          LIMIT ${Math.max(1, cfg.freshSlots * 4)}`,
      )
      .all(...args) as CandidateRow[];
    return rows.map((r) => {
      const s = calculateSalience(r as SalienceInput, nowMs);
      return { row: r, salience: s, briefScore: s, fresh: true };
    });
  } catch {
    return []; // fail-open
  }
}

/** D2 — buildBrief com diversidade (A novelty penalty + B freshness slot).
 *  Retorna o surface do `mode` + o brief atual + o diff (pra shadow log). */
export function buildBriefDiverse(
  db: BriefDb,
  params: BriefParams,
  cfg: DiversityConfig,
  nowMs: number = Date.now(),
): { current: BriefResult; alt: BriefResult; diff: BriefDiff } {
  // Garante brief_log antes de lê-lo (1ª chamada em DB fresco vem antes do
  // insert de handleBrief; em prod já existe). Idempotente (memo interno).
  ensureBriefLog(db);
  const { pools, quotas } = buildPools(db, params, nowMs);

  // Brief atual (baseline, score = salience) — o que está em prod hoje.
  const currentPicked = pickDedup(pools, quotas, params.n, (c) => c.salience);
  const current = assembleResult(params, toItems(currentPicked, nowMs), nowMs);

  // Parte A: novelty penalty sobre os candidatos dos pools.
  const allIds = [...new Set(pools.flat().map((c) => c.row.id))];
  const counts = serveCounts(db, allIds, cfg.windowSql);
  for (const c of pools.flat()) {
    c.briefScore = briefScore(c.salience, counts.get(c.row.id) ?? 0, c.row.pain ?? 0.2, cfg);
  }

  // Parte B: pool de freshness (recência relevante não-servida).
  const freshPatterns = params.agent
    ? scopePatterns(params.scope, params.agent)
    : scopePatterns(params.scope);
  const freshPool = cfg.freshSlots > 0
    ? fetchFreshCandidates(db, freshPatterns, cfg, nowMs)
    : [];

  // Floor (invariante #4): high-pain que já estavam no brief atual viram
  // pinned — nunca expulsos pelo freshness slot. Sem isto, B escondia incidents
  // pain≥0.9 (detectado pelo gate report no 1º shadow: would_leave pain=1.0).
  const pinnedIds = new Set(
    current.items.filter((i) => (i.pain ?? 0) >= cfg.painFloor).map((i) => i.id),
  );
  const altPicked = pickDedup(pools, quotas, params.n, effScore, freshPool, cfg.freshSlots, pinnedIds);
  const alt = assembleResult(params, toItems(altPicked, nowMs), nowMs);

  const freshIds = altPicked.filter((p) => p.fresh).map((p) => p.row.id);
  const diff = diffBriefs(
    current.items.map((i) => i.id),
    alt.items.map((i) => i.id),
    freshIds,
  );
  return { current, alt, diff };
}

// ─── Render text (stdout-ready pra hooks SessionStart) ──────────────────────

export function renderBriefText(result: BriefResult): string {
  const head = `# nox-mem brief — scope=${result.scope}${
    result.agent ? ` agent=${result.agent}` : ""
  } — ${result.generated_at} — ${result.items.length} items`;
  const lines: string[] = [head];
  let budget = TOKEN_BUDGET - Math.ceil(head.length / 4);
  for (const item of result.items) {
    const line = `[${item.type ?? "?"}|pain ${item.pain.toFixed(1)}|${item.age_days}d] ${item.title} — ${item.one_liner} (chk ${item.id})`;
    const cost = Math.ceil(line.length / 4);
    if (cost > budget) break;
    lines.push(line);
    budget -= cost;
  }
  return lines.join("\n") + "\n";
}

// ─── Handler HTTP-agnostic (api-server.ts despacha) ──────────────────────────

export function handleBrief(db: BriefDb, query: Record<string, string>): BriefResponse {
  const parsed = parseBriefParams(query);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };

  // D2 — diversidade (NOX_BRIEF_DIVERSITY=off|shadow|active). off ⇒ caminho
  // v1.2 intocado. shadow ⇒ computa o alt, loga o diff, serve o atual. active
  // ⇒ serve o alt. Fail-open: qualquer erro cai no brief atual (invariante #3).
  const cfg = diversityConfigFromEnv();
  let result: BriefResult;
  if (cfg.mode === "off") {
    result = buildBrief(db, parsed.params);
  } else {
    try {
      const { current, alt, diff } = buildBriefDiverse(db, parsed.params, cfg);
      if (cfg.mode === "shadow") {
        if (diff.churn > 0) {
          // stderr → journalctl. Gate D2 mede sobre estes ids × tabela chunks.
          console.error(
            JSON.stringify({
              tag: "brief_diversity_shadow",
              scope: parsed.params.scope,
              agent: parsed.params.agent ?? null,
              n: parsed.params.n,
              churn: diff.churn,
              would_enter: diff.would_enter,
              would_leave: diff.would_leave,
              fresh_added: diff.fresh_added,
            }),
          );
        }
        result = current;
      } else {
        result = alt;
      }
    } catch {
      result = buildBrief(db, parsed.params); // fail-open
    }
  }

  // Tracking de serving — brief_log próprio; chunks.access_count INTOCADO.
  try {
    ensureBriefLog(db);
    const ins = db.prepare(
      "INSERT INTO brief_log (chunk_id, scope, agent) VALUES (?, ?, ?)",
    );
    for (const item of result.items) {
      ins.run(item.id, parsed.params.scope, parsed.params.agent ?? null);
    }
  } catch {
    // fail-open: tracking nunca derruba o priming
  }

  if (parsed.params.format === "text") {
    return { status: 200, text: renderBriefText(result) };
  }
  return { status: 200, body: result };
}
