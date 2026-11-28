/**
 * kg-llm.ts — LLM-powered entity and relation extraction for Knowledge Graph v2
 * Uses Gemini 2.5 Flash (free tier, 500 RPM) for rich extraction.
 * Migrated from Ollama llama3.2:3b (2026-04-11) — Ollama was inactive since ~March.
 *
 * Fase 1.7a (2026-04-19):
 *   - Ontology grounding: campos ricos por tipo (project.value_brl, person.whatsapp_number, etc)
 *   - Multi-stage fast-path regex PT-BR: detecta entidades óbvias sem chamar Gemini
 *     (valores R$/US$, CNPJ/CPF, datas BR, telefones +55, emails, URLs)
 *   - Economia esperada: 30-40% de chamadas Gemini em chunks densos
 */

import { appendFileSync } from "fs";
import { join } from "path";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// ─── Logging ────────────────────────────────────────────────────────────────

const LOG_PATH = join(process.cwd(), "nox-mem.log");
let consecutiveFailures = 0;

function logKG(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  const line = `[${ts}] [KG-LLM] ${level}: ${msg}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // If log write fails, don't crash extraction
  }
  if (level === "ERROR") {
    console.error(`[KG-LLM] ${msg}`);
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

type EntityType =
  | "person" | "project" | "agent" | "tool" | "concept"
  | "organization" | "technology" | "document" | "decision" | "metric";

interface LLMEntity {
  name: string;
  type: EntityType;
  attributes?: Record<string, string | number | boolean>;
}

// E05 (2026-05-02) — Edge Typing FULL: closed enum 7 values per CLAUDE.md D12/D13.
// 'unknown' is fallback when extraction fails or not yet inferred.
export type RelationReason =
  | 'depends_on'
  | 'derived_from'
  | 'opposes'
  | 'extends'
  | 'replaces'
  | 'mentions'
  | 'unknown';

export const VALID_RELATION_REASONS: RelationReason[] = [
  'depends_on', 'derived_from', 'opposes', 'extends', 'replaces', 'mentions', 'unknown',
];

// E05 B1 (2026-05-03): defensive mapping pra recuperar reason de relation_type literal
// quando Gemini omite o campo. 14% → expected ~50%+ classification rate.
const RELATION_TYPE_TO_REASON: Record<string, RelationReason> = {
  // depends_on
  'depends_on': 'depends_on', 'depends on': 'depends_on',
  'requires': 'depends_on', 'needs': 'depends_on',
  'blocked_by': 'depends_on', 'blocked by': 'depends_on',
  'uses': 'depends_on', 'consumes': 'depends_on',
  // mentions
  'mentions': 'mentions', 'mentioned_in': 'mentions', 'mentioned in': 'mentions',
  'mentioned_with': 'mentions', 'mentioned with': 'mentions',
  'references': 'mentions', 'referenced by': 'mentions',
  'includes commit': 'mentions',
  // extends
  'extends': 'extends', 'enhances': 'extends', 'augments': 'extends',
  // replaces
  'replaces': 'replaces', 'supersedes': 'replaces', 'migrates_from': 'replaces',
  // derived_from
  'derived_from': 'derived_from', 'derived from': 'derived_from',
  'extracted_from': 'derived_from', 'extracted from': 'derived_from',
  'generated_from': 'derived_from',
  // opposes
  'opposes': 'opposes', 'contradicts': 'opposes',
  'blocks': 'opposes', 'conflicts_with': 'opposes',
};

export function mapRelationTypeToReason(relationType: string | undefined): RelationReason | null {
  if (typeof relationType !== 'string') return null;
  const key = relationType.toLowerCase().trim();
  return RELATION_TYPE_TO_REASON[key] ?? null;
}

export function normalizeRelationReason(raw: any, relationType?: string): RelationReason {
  // Path 1: Gemini deu reason válida
  if (typeof raw === 'string') {
    const v = raw.toLowerCase().trim();
    if ((VALID_RELATION_REASONS as string[]).includes(v) && v !== 'unknown') {
      return v as RelationReason;
    }
  }
  // Path 2 (B1): inferir de relation_type literal
  const inferred = mapRelationTypeToReason(relationType);
  if (inferred) return inferred;
  // Path 3: fallback
  return 'unknown';
}

interface LLMRelation {
  source: string;
  relation: string;
  target: string;
  reason?: RelationReason;
}

interface LLMExtraction {
  entities: LLMEntity[];
  relations: LLMRelation[];
  fast_path_used?: boolean;
}

// ─── Fast-path regex (PT-BR) ────────────────────────────────────────────────
//
// Detecta entidades óbvias sem LLM. Se ≥3 encontradas, pula Gemini.
// Patterns calibrados para documentos de negócio em PT-BR.

const RE_VALUE_BRL = /R\$\s?\d[\d\.,]*(?:\s?(?:mil|milh[ãa]o|milh[õo]es|bi|bilh[ãa]o|k|m|b))?/gi;
const RE_VALUE_USD = /US?\$\s?\d[\d\.,]*(?:\s?(?:k|m|b|million|thousand|billion))?/gi;
const RE_VALUE_EUR = /€\s?\d[\d\.,]*/gi;
const RE_CNPJ = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g;
const RE_CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
const RE_DATE_BR = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const RE_PHONE_BR = /\+?55[\s\-]?\(?\d{2}\)?[\s\-]?\d{4,5}[\s\-]?\d{4}/g;
const RE_EMAIL = /[\w.+\-]+@[\w\-]+\.[\w\-.]+/g;
const RE_URL = /https?:\/\/[^\s)]+/g;
const RE_PERCENT = /\b\d+(?:[.,]\d+)?\s?%/g;
// Proper nouns: 2+ palavras capitalizadas consecutivas (captura nomes próprios compostos)
const RE_PROPER_NOUN = /\b[A-ZÁÉÍÓÚÂÊÎÔÛÀÃÕÇ][a-záéíóúâêîôûàãõç]+(?:\s+(?:de|da|do|das|dos|e)\s+)?(?:\s+[A-ZÁÉÍÓÚÂÊÎÔÛÀÃÕÇ][a-záéíóúâêîôûàãõç]+)+\b/g;

interface FastPathHit {
  kind: "value_brl" | "value_usd" | "value_eur" | "cnpj" | "cpf" | "date" | "phone" | "email" | "url" | "percent" | "proper_noun";
  match: string;
}

export function fastPathExtract(text: string): FastPathHit[] {
  const hits: FastPathHit[] = [];
  const add = (kind: FastPathHit["kind"], re: RegExp) => {
    for (const m of text.match(re) || []) hits.push({ kind, match: m.trim() });
  };
  add("value_brl", RE_VALUE_BRL);
  add("value_usd", RE_VALUE_USD);
  add("value_eur", RE_VALUE_EUR);
  add("cnpj", RE_CNPJ);
  add("cpf", RE_CPF);
  add("date", RE_DATE_BR);
  add("phone", RE_PHONE_BR);
  add("email", RE_EMAIL);
  add("url", RE_URL);
  add("percent", RE_PERCENT);
  add("proper_noun", RE_PROPER_NOUN);
  return hits;
}

// ─── Ontology grounding prompt ──────────────────────────────────────────────
//
// Schema rico por tipo. Gemini retorna `attributes` com campos relevantes
// quando encontrar evidência no texto. Se não houver dado, omitir o campo
// (não inventar). Resultado final salvo em kg_entities.attributes como JSON.

const EXTRACTION_PROMPT = `Extract entities and relationships from this text (PT-BR + EN mixed). Return ONLY valid JSON.

Entity types with RICH attributes (infer from text ONLY — never invent):

- **person**: role, organization, email, whatsapp_number, notes
- **project**: status (prospect|active|closed|paused), value_brl, value_usd, stage, key_person, industry, ebitda_multiple
- **organization**: type (company|fund|institution|government), country, sector, size
- **agent**: owner, purpose, status (active|dormant)
- **document**: doc_type (contract|NDA|MoU|PDF|spreadsheet|termo|aditivo), date, parties, file_path
- **decision**: what, who, date, outcome, rationale
- **metric**: metric_name, value, unit, period
- **tool** / **concept** / **technology**: category, domain

Relation types (free-form, descriptive): works_on, decided, uses, depends_on, blocked_by, reviewed, created, manages, communicates_with, invested_in, negotiated_with, approved, rejected, owns, signed, paid, owes

Relation REASON (closed enum, REQUIRED for every relation — classify the SEMANTIC TYPE):
- **depends_on**: A requires B to exist/work (project depends_on tool; relation verbs: requires, needs, uses, blocked_by)
- **derived_from**: A is created/extracted from B (chunk derived_from document; verbs: extracted_from, generated_from)
- **opposes**: A contradicts/blocks/replaces B (decision opposes prior decision; verbs: contradicts, conflicts_with, blocks)
- **extends**: A adds capability to B (plugin extends platform, v2 extends v1; verbs: extends, enhances, augments)
- **replaces**: A supersedes/migrates from B (Gemini replaces Ollama; verbs: supersedes, migrates_from)
- **mentions**: A references/discusses B without strong dep (document mentions person; verbs: references, mentioned_in, mentioned_with, includes)
- **unknown**: ONLY when relation verb is truly ambiguous (e.g. interacts_with, associated_with). PREFER classifying when verb maps directly to a reason above.

CRITICAL: if your relation verb already matches one of {extends, mentions, depends_on, replaces, derived_from, opposes}, ALWAYS use that as reason.

Rules:
- Entity names: proper nouns or specific identifiers (skip generic "system", "code", "file")
- Attributes: only include fields with clear textual evidence. Omit unknowns. NEVER hallucinate.
- Values: preserve original formatting ("R$ 8.5k", "USD 280K", "10,5%")
- Dates: ISO format when possible (YYYY-MM-DD), or preserve original
- Relations reference entities by exact extracted name
- Max 20 entities and 15 relations per chunk

Text:
`;

// ─── Extraction ─────────────────────────────────────────────────────────────

const FAST_PATH_THRESHOLD = 3; // ≥N hits pula Gemini

export async function extractWithLLM(text: string): Promise<LLMExtraction> {
  // Fast-path: se texto tem ≥3 entidades óbvias capturáveis via regex,
  // retornar direto sem chamar Gemini (economia de ~30-40% de API calls).
  const fastHits = fastPathExtract(text);

  // Proper_noun entra no count mas não é suficiente sozinho — exige ≥2 hits
  // de tipo estruturado (valor/cnpj/email/etc) antes de ativar fast-path.
  const structuredHits = fastHits.filter((h) => h.kind !== "proper_noun").length;

  if (structuredHits >= FAST_PATH_THRESHOLD) {
    // Fast-path: monta entidades/relações mínimas sem LLM.
    // Mais confiável do que texto livre; trade-off é sem relações ricas.
    const entities: LLMEntity[] = [];
    const seen = new Set<string>();

    for (const h of fastHits) {
      const key = `${h.kind}:${h.match}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (h.kind === "email") {
        entities.push({ name: h.match, type: "person", attributes: { email: h.match } });
      } else if (h.kind === "phone") {
        entities.push({ name: h.match, type: "person", attributes: { whatsapp_number: h.match } });
      } else if (h.kind === "cnpj") {
        entities.push({ name: h.match, type: "organization", attributes: { cnpj: h.match } });
      } else if (h.kind === "cpf") {
        entities.push({ name: h.match, type: "person", attributes: { cpf: h.match } });
      } else if (h.kind === "value_brl" || h.kind === "value_usd" || h.kind === "value_eur") {
        entities.push({ name: h.match, type: "metric", attributes: { metric_name: "value", value: h.match } });
      } else if (h.kind === "date") {
        // Dates ficam como metric (sem criar entidade "date" — baixo valor isolado)
        // Skip para não poluir KG.
      } else if (h.kind === "url") {
        entities.push({ name: h.match, type: "document", attributes: { doc_type: "url", file_path: h.match } });
      } else if (h.kind === "percent") {
        entities.push({ name: h.match, type: "metric", attributes: { metric_name: "percent", value: h.match } });
      } else if (h.kind === "proper_noun") {
        // Proper nouns viram person/organization genérico — tipo será refinado
        // em kg-build pass subsequente se houver mais contexto.
        entities.push({ name: h.match, type: "person" });
      }
    }

    logKG("INFO", `Fast-path hit: ${structuredHits} structured + ${fastHits.length - structuredHits} nouns — skipped Gemini`);
    return { entities: entities.slice(0, 20), relations: [], fast_path_used: true };
  }

  if (!GEMINI_API_KEY) {
    logKG("ERROR", "GEMINI_API_KEY not set — KG extraction disabled");
    return { entities: [], relations: [] };
  }

  const trimmed = text.substring(0, 8000);

  try {
    const url = `${API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: EXTRACTION_PROMPT + trimmed }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              entities: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    name: { type: "STRING" },
                    type: { type: "STRING", enum: ["person", "project", "agent", "tool", "concept", "organization", "technology", "document", "decision", "metric"] },
                    attributes: { type: "OBJECT" },
                  },
                  required: ["name", "type"],
                },
              },
              relations: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    source: { type: "STRING" },
                    relation: { type: "STRING" },
                    target: { type: "STRING" },
                    reason: { type: "STRING", enum: ["depends_on", "derived_from", "opposes", "extends", "replaces", "mentions", "unknown"] },
                  },
                  required: ["source", "relation", "target"],
                },
              },
            },
            required: ["entities", "relations"],
          },
          temperature: 0.1,
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      throw new Error(`Gemini ${resp.status}: ${errText.substring(0, 200)}`);
    }

    const data = await resp.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      logKG("WARN", "Gemini returned empty response — skipping chunk");
      return { entities: [], relations: [] };
    }

    const parsed = JSON.parse(rawText) as LLMExtraction;

    if (!Array.isArray(parsed.entities)) parsed.entities = [];
    if (!Array.isArray(parsed.relations)) parsed.relations = [];
    // E05: normalize reason via enum guard (LLM may return invalid value)
    parsed.relations = parsed.relations.map((r) => ({ ...r, reason: normalizeRelationReason(r.reason, r.relation) }));
    parsed.fast_path_used = false;

    if (consecutiveFailures > 0) {
      logKG("INFO", `Recovered after ${consecutiveFailures} consecutive failures`);
      consecutiveFailures = 0;
    }

    return parsed;
  } catch (err: unknown) {
    consecutiveFailures++;
    const msg = err instanceof Error ? err.message : String(err);
    logKG("ERROR", `Extraction failed (${consecutiveFailures}x consecutive): ${msg}`);

    if (consecutiveFailures >= 5) {
      logKG("ERROR", "🔴 KG extraction failing repeatedly — check GEMINI_API_KEY and API status");
    }

    return { entities: [], relations: [] };
  }
}
