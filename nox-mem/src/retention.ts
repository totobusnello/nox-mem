// Fase 1.7b-a — Typed Source Retention Matrix
// Central source of truth para políticas de retenção por chunk_type.
// Alinhado com migration v8 em db.ts.
//
// Regra de projeto: NULL = never auto-decay (user-declared preservation).
// Valores em dias desde created_at. Core tier ignora retention (sempre preservado).

export type RetentionDays = number | null;

/**
 * RETENTION_BY_TYPE — mapping canônico chunk_type → retention_days.
 * Deve ficar em sync com o UPDATE no migrateToV8 (db.ts).
 *
 * Derivado do paper "Claude Memory Setup" + calibração com os 2106 chunks
 * reais do nox-mem (distribuição em 2026-04-23):
 *   team=961, daily=630, other=278, decision=138, lesson=45,
 *   feedback=17, project=15, pending=9, digest=7, person=6
 */
export const RETENTION_BY_TYPE: Record<string, RetentionDays> = {
  feedback: null,   // never — user feedback é evidência preservada
  person:   null,   // never — ontology estável de pessoas
  lesson:   180,    // mistakes caros merecem 6 meses
  decision: 365,    // decisões têm lifespan longo
  project:  365,    // projetos duram
  daily:    90,     // daily session notes
  team:     120,    // team state evolui
  digest:   180,    // digest consolida várias sessões
  pending:  30,     // se 30d sem resolver, escala pra review
  graph_node: 60,   // repos externos indexados via graphify — research-like, decay rápido
  distilled: null,  // never — escolha explícita (DECISIONS 27/10 #3); session-distill grava NULL
  other:    90,     // default
};

export const DEFAULT_RETENTION_DAYS = 90;

/**
 * Resolve retention pro chunk baseado no tipo.
 * Retorna null (never-decay) ou número de dias.
 */
export function getRetentionForType(chunkType: string): RetentionDays {
  if (chunkType in RETENTION_BY_TYPE) return RETENTION_BY_TYPE[chunkType];
  return DEFAULT_RETENTION_DAYS;
}

/**
 * Detecta override de retention em HTML comment no markdown fonte.
 * Formatos aceitos:
 *   <!-- retention: never -->
 *   <!-- retention: 365 -->
 *   <!-- retention: 30 days -->
 *
 * Retorna:
 *   { found: true, value: null }           — explicit never-decay
 *   { found: true, value: <days> }         — explicit days
 *   { found: false }                       — no override (caller uses chunk_type default)
 */
export function parseRetentionOverride(
  source: string,
): { found: true; value: RetentionDays } | { found: false } {
  // Case-insensitive, tolerant to whitespace and CRLF line endings.
  // Multiline anchors: comment MUST be alone on its line (frontmatter-style).
  // Prevents false matches when docs describe the syntax in prose.
  // Only scans the first 30 lines (frontmatter window) to avoid scanning long files.
  const normalized = source.replace(/\r\n/g, "\n"); // CRLF → LF for Windows files
  const head = normalized.split("\n").slice(0, 30).join("\n");
  const re = /^[ \t]*<!--\s*retention:\s*([^-\s][^-]*?)\s*-->[ \t]*$/im;
  const m = head.match(re);
  if (!m) return { found: false };

  const raw = m[1].trim().toLowerCase();
  if (raw === "never" || raw === "null" || raw === "infinite") {
    return { found: true, value: null };
  }

  // Extract leading integer (handles "30", "30 days", "30d")
  const numMatch = raw.match(/^(\d+)/);
  if (!numMatch) return { found: false };
  const days = parseInt(numMatch[1], 10);
  if (!Number.isFinite(days) || days <= 0 || days > 36500) return { found: false };
  return { found: true, value: days };
}

/**
 * Determina retention_days final pro chunk sendo ingested.
 * Precedência: override HTML comment > chunk_type default.
 */
export function resolveRetention(
  chunkType: string,
  sourceContent?: string,
): RetentionDays {
  if (sourceContent) {
    const override = parseRetentionOverride(sourceContent);
    if (override.found) return override.value;
  }
  return getRetentionForType(chunkType);
}
