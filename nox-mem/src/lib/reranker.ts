// D01 — Cross-encoder Reranker (shadow)
// 2026-05-07 impl. Spec: specs/2026-05-07-D01-cross-encoder-reranker.md (memoria-nox)
//
// Adiciona camada de cross-encoder pós-RRF ao hybrid pipeline. BGE-reranker-base
// via @xenova/transformers (ONNX in Node, ~85MB on disk). Default off; shadow
// computa lift sem mutar resultados; active substitui ranking pelo reranker.
//
// Modes (env NOX_RERANKER_MODE):
//   off      — disabled (default), no compute, no apply
//   shadow   — rerank executa, telemetria, ranking final = original (não muta)
//   active   — rerank substitui ranking final
//
// Fail-open: model load falha, ONNX timeout, exception qualquer → log + retorna
// candidates originais (off-mode efetivo). Zero crash exposto ao caller.
//
// Telemetria computada mesmo em shadow:
//   - position_changes: chunks que mudaram posição entre orig top-K e rerank top-K
//   - lift_score: |sum(orig_pos − new_pos)| / K_OUT, normalizado [0,1]
//
// Cache do modelo: default em node_modules/@xenova/transformers/.cache/
// Override via env TRANSFORMERS_CACHE (recomendado prod: /var/cache/nox-mem-models/).

export type RerankerMode = "off" | "shadow" | "active";

export interface RerankCandidate {
  id?: number;
  chunk_text: string;
  // restante dos campos passa-through (preservado no output)
  [k: string]: any;
}

export interface RerankSummary {
  mode: RerankerMode;
  topKIn: number;
  topKOut: number;
  latencyMs: number;
  positionChanges: number;
  liftScore: number;
  failed: boolean;
  failureReason?: string;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_TOP_K_IN = 50;
export const DEFAULT_TOP_K_OUT = 10;
export const DEFAULT_MODEL = "Xenova/bge-reranker-base";
export const DEFAULT_TIMEOUT_MS = 2000;

// ─── Env config ──────────────────────────────────────────────────────────────

export function getMode(): RerankerMode {
  const v = (process.env.NOX_RERANKER_MODE || "off").toLowerCase();
  if (v === "off" || v === "shadow" || v === "active") return v;
  return "off";
}

export function getTopKIn(): number {
  const raw = process.env.NOX_RERANKER_TOP_K_IN;
  if (!raw) return DEFAULT_TOP_K_IN;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_K_IN;
  return n;
}

export function getTopKOut(): number {
  const raw = process.env.NOX_RERANKER_TOP_K_OUT;
  if (!raw) return DEFAULT_TOP_K_OUT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOP_K_OUT;
  return n;
}

export function getModelName(): string {
  return process.env.NOX_RERANKER_MODEL || DEFAULT_MODEL;
}

export function getTimeoutMs(): number {
  const raw = process.env.NOX_RERANKER_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 100) return DEFAULT_TIMEOUT_MS;
  return n;
}

// ─── Pipeline lazy singleton + DI hook (for tests) ──────────────────────────

// Type alias: cross-encoder retorna array de objetos com label+score.
// xenova text-classification pipeline: input pair {text, text_pair} ou string,
// output: [{label: 'LABEL_0', score: 0.x}] por par.
export type RerankerFn = (
  pairs: Array<{ text: string; text_pair: string }>
) => Promise<Array<{ score: number }>>;

let cachedFn: RerankerFn | null = null;
let cachedModelName: string | null = null;
let cachedFactoryError: Error | null = null;

/**
 * Test hook: injetar uma fn mock pra evitar download do modelo.
 * Em produção, NÃO chamar — `rerank()` carrega lazy via @xenova/transformers.
 *
 * Quando fn=null + reset=true (default), limpa singleton + cached error.
 * Use reset=false só pra cenários onde você quer preservar erro cacheado.
 */
export function __setRerankerFnForTesting(fn: RerankerFn | null, reset: boolean = true): void {
  cachedFn = fn;
  if (reset || fn !== null) {
    cachedFactoryError = null;
  }
  cachedModelName = fn ? "__test__" : null;
}

/**
 * Lazy-load do modelo. First call paga ~2-4s de cold start (ONNX bind).
 * Subsequent calls reusam singleton. Fail-open: se carga falha, cacheia error
 * pra evitar retry-storm.
 */
async function getRerankerFn(): Promise<RerankerFn> {
  const wantedModel = getModelName();
  // Test injection bypass: __test__ marker overrides model match check.
  if (cachedFn && (cachedModelName === "__test__" || cachedModelName === wantedModel)) return cachedFn;
  if (cachedFactoryError) throw cachedFactoryError;

  try {
    // Dynamic import: Node ESM, evita carga em paths off-mode.
    // Specifier held in a variable so tsc does not require the optional
    // dependency at build time; a clone without it still type-checks.
    const xenovaSpecifier = "@xenova/transformers";
    const t: any = await import(xenovaSpecifier);
    // BGE-reranker-base é cross-encoder. xenova text-classification pipeline NÃO
    // suporta text_pair (passa pares como string única → tokenizer ignora pair).
    // Usar API low-level: AutoTokenizer + AutoModelForSequenceClassification com
    // tokenize batch de pares (queries + docs) → logits.
    // Quantized=true reduz disk de ~430MB → ~85MB sem perda significativa.
    const tokenizer = await t.AutoTokenizer.from_pretrained(wantedModel);
    const model = await t.AutoModelForSequenceClassification.from_pretrained(wantedModel, {
      quantized: true,
    });
    const fn: RerankerFn = async (pairs) => {
      if (pairs.length === 0) return [];
      const queries = pairs.map((p) => p.text);
      const docs = pairs.map((p) => p.text_pair);
      const encoded = await tokenizer(queries, {
        text_pair: docs,
        padding: true,
        truncation: true,
      });
      const out: any = await model(encoded);
      // out.logits.dims = [batch, 1]; data = Float32Array
      const data = Array.from(out.logits.data as Float32Array);
      // Sigmoid-like normalize não obrigatório (sort desc por logit funciona).
      // Mantemos raw logits — sort desc preserva ordem correta.
      return data.map((s) => ({ score: s }));
    };
    cachedFn = fn;
    cachedModelName = wantedModel;
    return fn;
  } catch (e: any) {
    cachedFactoryError = e instanceof Error ? e : new Error(String(e));
    throw cachedFactoryError;
  }
}

/**
 * Pre-warm o singleton do modelo. Chamado pelo nox-mem-api boot quando
 * NOX_RERANKER_MODE != off, pra evitar cold-start de ~12-90s no primeiro
 * search request (D01 spec §risks §1). Idempotente: subsequent calls são no-op.
 */
export async function preloadModel(): Promise<void> {
  await getRerankerFn();
}

// ─── Helpers: telemetry math (pure, testable) ────────────────────────────────

/**
 * Conta chunks que mudaram posição entre os top-K original e o pós-rerank.
 * Trabalha por id (campo opcional). Chunks sem id são ignorados (não rastreáveis).
 */
export function computePositionChanges(
  origTopK: RerankCandidate[],
  newTopK: RerankCandidate[]
): number {
  const origPos = new Map<number, number>();
  const newPos = new Map<number, number>();
  origTopK.forEach((c, i) => {
    if (typeof c.id === "number") origPos.set(c.id, i);
  });
  newTopK.forEach((c, i) => {
    if (typeof c.id === "number") newPos.set(c.id, i);
  });
  const allIds = new Set<number>([...origPos.keys(), ...newPos.keys()]);
  let changes = 0;
  for (const id of allIds) {
    const a = origPos.get(id);
    const b = newPos.get(id);
    if (a === undefined || b === undefined) {
      // chunk entrou ou saiu do top-K → mudança
      changes++;
    } else if (a !== b) {
      changes++;
    }
  }
  return changes;
}

/**
 * Lift score: mean displacement normalizado em [0, 1].
 *
 * Combina dois sinais:
 *   1) displacement intra-intersection: |orig_pos − new_pos| pra ids em ambos
 *   2) turnover (set churn): id que entrou OU saiu conta como displacement = K
 *
 * Total = sum(deltas) / (count * K), onde K = max(|orig|, |new|).
 *
 * Edge cases:
 *   - sets disjoint → todos turnover, score = 1
 *   - identical → 0
 *   - swap top-2 (K=5) → 2 ids movem 1 cada → 2/(5*4) = 0.1
 */
export function computeLiftScore(
  origTopK: RerankCandidate[],
  newTopK: RerankCandidate[]
): number {
  if (origTopK.length === 0 || newTopK.length === 0) return 0;
  const k = Math.max(origTopK.length, newTopK.length);
  if (k <= 1) return 0;
  const origPos = new Map<number, number>();
  const newPos = new Map<number, number>();
  origTopK.forEach((c, i) => {
    if (typeof c.id === "number") origPos.set(c.id, i);
  });
  newTopK.forEach((c, i) => {
    if (typeof c.id === "number") newPos.set(c.id, i);
  });
  const allIds = new Set<number>([...origPos.keys(), ...newPos.keys()]);
  if (allIds.size === 0) return 0;
  let sumDelta = 0;
  for (const id of allIds) {
    const a = origPos.get(id);
    const b = newPos.get(id);
    if (a === undefined || b === undefined) {
      // turnover: id entrou ou saiu → trata como displacement máximo (k)
      sumDelta += k;
    } else {
      sumDelta += Math.abs(a - b);
    }
  }
  // Normalize: max possible = allIds.size * k (all turned over)
  const norm = sumDelta / (allIds.size * k);
  return Math.min(1, Math.max(0, norm));
}

// ─── Core rerank function ────────────────────────────────────────────────────

/**
 * Rerank candidates via cross-encoder. Comportamento per mode:
 *
 *   - off:    no-op, retorna candidates.slice(0, topK), summary mode='off'
 *   - shadow: roda reranker, calcula lift, retorna candidates ORIGINAIS top-K
 *             (não muta ranking — caller recebe ordem pre-rerank)
 *   - active: roda reranker, retorna pós-rerank top-K (muta ranking)
 *
 * Fail-open: qualquer erro (model load, timeout, ONNX crash) → retorna
 * candidates.slice(0, topK) original com summary.failed=true. Não joga.
 */
export async function rerank(
  query: string,
  candidates: RerankCandidate[],
  topKOut?: number
): Promise<{ results: RerankCandidate[]; summary: RerankSummary }> {
  const mode = getMode();
  const kIn = getTopKIn();
  const kOut = topKOut ?? getTopKOut();
  const t0 = Date.now();

  const summaryBase = (
    overrides: Partial<RerankSummary> = {}
  ): RerankSummary => ({
    mode,
    topKIn: 0,
    topKOut: 0,
    latencyMs: 0,
    positionChanges: 0,
    liftScore: 0,
    failed: false,
    ...overrides,
  });

  // off-mode: bypass total
  if (mode === "off") {
    return {
      results: candidates.slice(0, kOut),
      summary: summaryBase({ topKOut: Math.min(candidates.length, kOut) }),
    };
  }

  // empty / single candidate: nothing to rerank
  if (candidates.length <= 1 || !query || query.trim().length === 0) {
    return {
      results: candidates.slice(0, kOut),
      summary: summaryBase({ topKOut: Math.min(candidates.length, kOut), latencyMs: Date.now() - t0 }),
    };
  }

  const slice = candidates.slice(0, kIn);
  const origTopK = candidates.slice(0, kOut);

  let scored: Array<{ candidate: RerankCandidate; score: number }>;
  try {
    const fn = await getRerankerFn();
    const pairs = slice.map((c) => ({
      text: query,
      text_pair: (c.chunk_text || "").slice(0, 4000), // safety truncate (model max 512 tokens)
    }));

    const timeoutMs = getTimeoutMs();
    // Race contra timeout
    const rerankPromise = fn(pairs);
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`reranker timeout after ${timeoutMs}ms`)), timeoutMs)
    );
    const scores = await Promise.race([rerankPromise, timer]);

    if (!Array.isArray(scores) || scores.length !== slice.length) {
      throw new Error(`reranker returned ${Array.isArray(scores) ? scores.length : "non-array"} scores for ${slice.length} pairs`);
    }
    scored = slice.map((c, i) => ({ candidate: c, score: scores[i].score }));
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (process.env.NOX_RERANKER_LOG === "1") {
      logRerank(query, mode, kIn, kOut, Date.now() - t0, 0, 0, true, msg);
    }
    return {
      results: origTopK,
      summary: summaryBase({
        topKIn: slice.length,
        topKOut: origTopK.length,
        latencyMs: Date.now() - t0,
        failed: true,
        failureReason: msg.slice(0, 200),
      }),
    };
  }

  // Sort by reranker score desc
  scored.sort((a, b) => b.score - a.score);
  const newTopK = scored.slice(0, kOut).map((s) => s.candidate);

  const positionChanges = computePositionChanges(origTopK, newTopK);
  const liftScore = computeLiftScore(origTopK, newTopK);
  const latencyMs = Date.now() - t0;

  if (process.env.NOX_RERANKER_LOG === "1") {
    logRerank(query, mode, kIn, kOut, latencyMs, positionChanges, liftScore, false);
  }

  const summary = summaryBase({
    topKIn: slice.length,
    topKOut: kOut,
    latencyMs,
    positionChanges,
    liftScore,
    failed: false,
  });

  // mode=shadow: NÃO muta resultado retornado (ranking original)
  // mode=active: substitui pelo rerank
  return {
    results: mode === "active" ? newTopK : origTopK,
    summary,
  };
}

function logRerank(
  query: string,
  mode: RerankerMode,
  kIn: number,
  kOut: number,
  latencyMs: number,
  positionChanges: number,
  liftScore: number,
  failed: boolean,
  failureReason?: string
): void {
  const safeQuery = (query || "").replace(/[\r\n"]/g, " ").slice(0, 80);
  const tag = mode === "active" ? "rerank-active" : mode === "shadow" ? "rerank-shadow" : "rerank-off";
  const status = failed ? `FAILED reason="${(failureReason || "").slice(0, 120)}"` : "ok";
  console.error(
    `[${tag}] query="${safeQuery}" kIn=${kIn} kOut=${kOut} lat=${latencyMs}ms changes=${positionChanges} lift=${liftScore.toFixed(3)} ${status}`
  );
}
