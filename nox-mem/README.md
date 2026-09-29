# nox-mem

Pain-weighted hybrid memory engine for AI agents. Self-hosted, zero vendor lock-in.

**Stack:** TypeScript · Node 20+ · SQLite (FTS5 + sqlite-vec) · Gemini embeddings (default) · OpenAI-compat optional

## Quick start

```bash
npm i -g nox-mem
export GEMINI_API_KEY=AIza...   # https://aistudio.google.com/apikey
nox-mem stats                   # first run creates ~/.nox-mem/nox.db
nox-mem ingest notes/*.md       # one or many files
nox-mem search "what did we decide"
```

The database defaults to `~/.nox-mem/nox.db`; set `NOX_DB_PATH` to put it elsewhere (its folder is created if missing).

---

## Prerequisites

### System packages (Linux)

```bash
apt-get update
apt-get install -y build-essential python3
```

`build-essential` and `python3` matter only when `better-sqlite3` cannot download a prebuilt binary for your platform and has to compile its native addon (`node-gyp` uses `python3`). `inotify-tools` is not needed to install or to run `nox-mem watch`; only the optional systemd script `nox-mem-watch.sh` uses `inotifywait`.

### Node.js 20+

```bash
# Via NodeSource (Ubuntu/Debian); 22 is the current LTS, 20 is the minimum
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version  # expect v20.x or higher
```

---

## Install

### From npm (recommended)

```bash
npm i -g nox-mem
nox-mem stats
```

### Build from source

```bash
git clone https://github.com/totobusnello/nox-mem.git
cd nox-mem/nox-mem
npm ci
npm run build
npm install -g .
```

After either method, the `nox-mem` command is available globally.

---

## Environment variables

Put your settings in a `.env` and source it before running (the template is [`.env.example`](https://github.com/totobusnello/nox-mem/blob/main/nox-mem/.env.example) in the GitHub repo; it is **not** shipped in the npm package):

```bash
set -a; source ~/.nox-mem/.env; set +a
nox-mem stats
```

### Required

| Var | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Google AI Studio key (default LLM + embedding provider). Without it search still works as keyword search; `vectorize`, `answer` and `kg-build` need it. |

### Common (all optional)

| Var | Default | Purpose |
|---|---|---|
| `NOX_DB_PATH` | `~/.nox-mem/nox.db` | SQLite database path. A missing parent directory is created (mode 0700). Its directory is auto-added to the op-audit allowlist. |
| `NOX_MEM_DIR` | — | **Not** the notes folder: nothing ingests or watches it. It only sets where pre-op snapshots go (`$NOX_MEM_DIR/.nox-snapshots`) and widens the op-audit allowlist. |
| `NOX_ALLOW_PROD_INGEST` | — | `1` skips the large-database ingest guard (same as `--allow-prod`). See [Large databases](#large-databases-the-ingest-guard). |

### API server

| Var | Default | Purpose |
|---|---|---|
| `NOX_API_PORT` | `18802` | HTTP API port. |
| `NOX_API_HOST` | `127.0.0.1` | HTTP API bind host. |
| `NOX_API_TOKEN` | — | If set, requires `Authorization: Bearer <token>` on the API. |

### Multi-provider (optional — default is Gemini / AI Studio)

| Var | Default | Purpose |
|---|---|---|
| `NOX_LLM_PROVIDER` | `gemini` | `gemini` (default) or `openai` (any OpenAI-compatible endpoint). `anthropic` is interface-ready but not yet implemented. |
| `NOX_LLM_MODEL` | `gemini-2.5-flash-lite` | LLM model id (e.g. `gpt-4o-mini`, `claude-3-5-haiku-20241022`). |
| `NOX_LLM_BASE_URL` | provider default | OpenAI-compat base URL — DeepSeek/OpenRouter/Together/Ollama/vLLM. Ignored for `anthropic`. |
| `NOX_LLM_API_KEY` | falls back to `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | LLM key. |
| `NOX_LLM_FALLBACK` | — | Fallback chain, e.g. `openai:gpt-4o-mini`. |
| `NOX_EMBEDDING_PROVIDER` | `gemini` | `gemini` (default) or `openai` (any OpenAI-compat endpoint). `voyage` is interface-ready but not yet implemented. Alias: `NOX_EMBED_PROVIDER`. |
| `NOX_EMBEDDING_MODEL` | `gemini-embedding-001` | Embedding model id (e.g. `text-embedding-3-large`, `voyage-3`). Alias: `NOX_EMBED_MODEL`. |
| `NOX_EMBEDDING_BASE_URL` | provider default | Embedding base URL for OpenAI-compat providers. Alias: `NOX_EMBED_BASE_URL`. |
| `NOX_EMBEDDING_API_KEY` | falls back to provider key | Embedding key. Alias: `NOX_EMBED_API_KEY`. |
| `NOX_EMBEDDING_DIM` | `3072` | Vector dimension. **MUST equal the vec0 table dim** — changing it requires re-embedding the whole corpus. Alias: `NOX_EMBED_DIM`. |

> ⚠️ **Dimension lock:** the sqlite-vec table is created with a fixed dimension. Switching embedding provider or model requires re-embedding the **entire corpus** with a single model at a single dimension, and that dimension must match the `vec0` table. `text-embedding-3-large` supports `dimensions=3072` (matches the default Gemini table); `text-embedding-3-small` is 1536 — only usable with a fresh/empty database. Set `NOX_EMBEDDING_MODEL` + `NOX_EMBEDDING_DIM` deliberately. Vectors from different models are not comparable — mixing silently corrupts semantic search.

### Advanced (safe to leave unset — defaults are standalone-neutral)

| Var | Default | Purpose |
|---|---|---|
| `OPENCLAW_WORKSPACE` | unset | Origin platform workspace root (origin/legacy only). ⚠️ Leave it unset on a standalone install: without `NOX_DB_PATH` it moves the database to `$OPENCLAW_WORKSPACE/tools/nox-mem/nox-mem.db`, a different and empty one. |
| `NOX_OP_AUDIT_ALLOWED_PREFIXES` | derived from `NOX_DB_PATH`/`NOX_MEM_DIR` + origin defaults | Comma-sep path prefixes the DB/snapshots may live under. |
| `NOX_PRE_OP_SNAPSHOT_DIR` | `<NOX_MEM_DIR or the DB's folder>/.nox-snapshots` (standalone) | Pre-op snapshot directory. |
| `NOX_PROTECTED_NAMES` | empty | Comma-sep names never auto-merged in the KG. |
| `NOX_NAME_ALIASES` | empty | `from:To` name-normalization pairs for the KG. |
| `NOX_ENTITY_PATTERNS` / `NOX_PROJECT_PATTERNS` | empty | Terms for the legacy regex entity extractor. |
| `NOX_KNOWN_PROJECTS` | empty | Project slugs for `project-context-gen`. |
| `NOX_AGENTS` / `NOX_AGENTS_DIR` | empty / — | Multi-agent cross-search layout (no-op standalone). |
| `NOX_WATCH_DIRS` | OpenClaw layout (`$OPENCLAW_WORKSPACE/memory`, `/shared`, …) | Comma-sep **absolute** dirs for `nox-mem watch`. Standalone: `NOX_WATCH_DIRS="$HOME/notes" nox-mem watch`. Unset on a machine without that layout, the watcher reports "Watching 0 directories". |
| `NOX_SPEAKER_FILTER` | empty | One-time V7 migration speaker classification. |
| `NOX_NOTION_TOKEN_PATH` | `/root/.config/notion/api_key` | Path of an optional Notion token file (only `doctor` looks at it). |

---

## Multi-provider support

By default nox-mem uses **Gemini via Google AI Studio** for both LLM synthesis and embeddings (`GEMINI_API_KEY`, model `gemini-2.5-flash-lite`, embeddings `gemini-embedding-001` at 3072 dimensions).

The RAG answer/reflect layer and embeddings are provider-pluggable at runtime — no rebuild required. Note: some internal LLM operations (knowledge-graph extraction, consolidation, digest, query expansion) still call Gemini directly and require `GEMINI_API_KEY` even when another provider is set — full provider routing is on the roadmap.

### LLM synthesis (reflect, answer)

Supported values for `NOX_LLM_PROVIDER`: `gemini` (default) · `openai` (any OpenAI-compatible endpoint). `anthropic` is interface-ready but not yet implemented.

**Example — DeepSeek via direct API (OpenAI-compat):**
```bash
NOX_LLM_PROVIDER=openai
NOX_LLM_BASE_URL=https://api.deepseek.com/v1
NOX_LLM_MODEL=deepseek-chat
NOX_LLM_API_KEY=sk-...
```

> `anthropic` (LLM) and `voyage` (embeddings) are interface-ready stubs — not implemented yet. Use `gemini` or any OpenAI-compatible endpoint today.

**Example — local Ollama:**
```bash
NOX_LLM_PROVIDER=openai
NOX_LLM_BASE_URL=http://127.0.0.1:11434/v1
NOX_LLM_MODEL=llama3.2
NOX_LLM_API_KEY=ollama
```

**Fallback chain:** `NOX_LLM_FALLBACK=openai:gpt-4o-mini` — tried if the primary LLM call fails.

### Embedding provider

Supported values for `NOX_EMBEDDING_PROVIDER` (alias `NOX_EMBED_PROVIDER`): `gemini` (default) · `openai` (any OpenAI-compat endpoint, including local Ollama/vLLM). `voyage` is a stub that cannot embed yet. Any other name (for example `openai-compat`) is rejected.

**Example — OpenAI native (3072-dim parity with default Gemini table):**
```bash
NOX_EMBEDDING_PROVIDER=openai
NOX_EMBEDDING_BASE_URL=https://api.openai.com/v1
NOX_EMBEDDING_MODEL=text-embedding-3-large
NOX_EMBEDDING_DIM=3072
NOX_EMBEDDING_API_KEY=sk-...
```

**Example — local Ollama embedding:**
```bash
NOX_EMBEDDING_PROVIDER=openai
NOX_EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
NOX_EMBEDDING_MODEL=nomic-embed-text
NOX_EMBEDDING_DIM=768          # must match the model's output dim
NOX_EMBEDDING_API_KEY=ollama
```

> ⚠️ **Dimension lock:** the sqlite-vec table is created once with a fixed dimension. Switching embedding provider or model requires re-embedding the **entire corpus** with a single model at a single dimension, and that dimension must match the `vec0` table. `text-embedding-3-large` supports `dimensions=3072` (matches the default Gemini table). `text-embedding-3-small` outputs 1536 — only usable with a fresh/empty database. Set `NOX_EMBEDDING_MODEL` + `NOX_EMBEDDING_DIM` deliberately and do not mix vectors from different models.

---

## Operation audit snapshots

All destructive operations (reindex, consolidate, compact, crystallize, kg-prune) create an atomic SQLite snapshot before mutating data. On a standalone install snapshots land in `<NOX_MEM_DIR or the database's folder>/.nox-snapshots` (for example `~/.nox-mem/.nox-snapshots/`); `NOX_PRE_OP_SNAPSHOT_DIR` overrides it. Retention: 7 days.

There is no restore command in the CLI. To restore, stop `nox-mem-api`, the watcher and anything else using the database, copy the snapshot over the database file, and only then delete the `-wal` and `-shm` files next to it (copying without removing a stale WAL corrupts the database):

```bash
cp ~/.nox-mem/.nox-snapshots/<snapshot>.db ~/.nox-mem/nox.db
rm -f ~/.nox-mem/nox.db-wal ~/.nox-mem/nox.db-shm
```

### Large databases: the ingest guard

Once the database holds more than 10,000 chunks, `ingest`, `ingest-entity` and `watch` refuse to write until you confirm it is the database you mean. The check stops a test or eval script from writing into your real database by accident. Confirm with either:

```bash
nox-mem ingest --allow-prod notes/*.md        # also: ingest-entity, watch
NOX_ALLOW_PROD_INGEST=1 nox-mem ingest notes/*.md
```

If the database is not the one you meant, point `NOX_DB_PATH` at another file instead.

---

## Sanity check

After install, verify the engine is healthy:

```bash
nox-mem doctor          # Core must be ✅/⚠️; ⚪ under "Optional integrations" is fine
nox-mem doctor --quiet  # scripts: prints only core problems, exits 1 if one failed

# Start the API server (default port 18802; NOX_API_PORT overrides)
nox-mem-api &

# Vector coverage: embedded / total (should be close to 1.0)
curl -s "http://127.0.0.1:${NOX_API_PORT:-18802}/api/health" | jq '.vectorCoverage | .embedded/.total'
```

`vectorCoverage` is an object (`embedded`, `total`, `orphans`, `indexOnly`), not a single number. If `embedded/total` is below 0.99 some chunks are not yet embedded — run `nox-mem vectorize` to catch up.

---

## Key commands

```
nox-mem search "query"     — hybrid search (FTS5 + semantic + RRF)
nox-mem search "q" --as-of 2026-05-01        — time-travel: chunks that existed then
nox-mem search "q" --changed-since 7d        — recency window (15m, 2h, 7d, 1w or ISO)
NOX_FTS_OR_FALLBACK=auto|on|off — FTS5 OR retry (stopwords dropped) when the AND query finds nothing; auto (default) = only when the key of the resolved embedding provider (NOX_EMBEDDING_PROVIDER, default gemini) is missing, so natural-language questions work on keyless installs and keyed setups are unchanged. An unrelated key such as OPENAI_API_KEY under the default gemini provider does not turn it off
nox-mem answer "question"  — grounded answer with citations (needs GEMINI_API_KEY); --as-of / --changed-since filter the evidence
nox-mem ingest <files...>  — ingest one or more markdown/json files; a directory is an error naming it, the other files still run, exit 1 if any failed
nox-mem watch              — auto-ingest changes; set NOX_WATCH_DIRS=/abs/dir[,/abs/dir2] (see Environment variables)
nox-mem reindex            — rebuild the index from $OPENCLAW_WORKSPACE (see warning below)
nox-mem vectorize          — embed any unembedded chunks
nox-mem stats              — chunk/entity/vector counts
nox-mem kg-build           — extract knowledge graph entities
nox-mem reflect "question" — synthesis over memory + KG, with cited sources
nox-mem-api                — start HTTP API on $NOX_API_PORT (default 18802)
nox-mem-mcp                — start MCP server over stdio (21 tools, incl. nox_mem_answer, for agents)
nox-mem doctor             — health check (core + optional integrations)
nox-mem --help             — full command reference
```

Wire the MCP server into Claude Code:

```bash
claude mcp add nox-mem -e NOX_DB_PATH="$HOME/.nox-mem/nox.db" -e GEMINI_API_KEY="$GEMINI_API_KEY" -- nox-mem-mcp
```

HTTP endpoints worth knowing: `GET /api/health`, `GET /api/search?q=`, `GET /api/brief`, `POST /api/answer`, `GET /api/kg`, and `GET /api/reflect?q=…` (synthesis over memory + KG; `q` is required, a request without it is a 400).

The temporal filter is also on HTTP (`?as_of=` / `?changed_since=` on `/api/search`, or the same keys in a POST body) and MCP (`as_of` / `changed_since` on `nox_mem_search`). `answer` takes it too: `--as-of` / `--changed-since` on the CLI, and `as_of` / `changed_since` on `POST /api/answer` and on the `nox_mem_answer` MCP tool. A bad or blank date gives exit 2 / HTTP 400 / MCP `isError`. It is a hard SQL pre-filter on `created_at` / `updated_at` (ingestion time), not a ranking boost. `as_of` answers *which chunks existed then*, not *what they said then*: there is no version history, so a chunk edited after the date comes back with its current text. A bare date means the whole day in UTC (`--as-of 2026-05-01` includes 23:59 that day; `--changed-since 2026-05-01` starts at 00:00); a time without an offset is read as UTC. An unparseable date is an error on every surface (exit 2 / HTTP 400 / MCP `isError`), never a silently unfiltered search.

> ⚠️ **`reindex` rebuilds only from `$OPENCLAW_WORKSPACE/memory` and `/shared`** (default workspace `/root/.openclaw/workspace`). If that source is missing or empty while the DB holds chunks, it **refuses before touching the DB**; if the rebuild would drop more than 10% of the chunks, it refuses before deleting anything (`NOX_REINDEX_MIN_RETENTION_RATIO`, override `NOX_REINDEX_ALLOW_WIPE=1`). Chunks ingested from outside the workspace are still treated as orphans by a reindex that does run. Preview with `nox-mem reindex --dry-run`. On a standalone install that adds notes with `nox-mem ingest <file>` you normally do not need `reindex`.

> **Where the database lives.** `NOX_DB_PATH` if set; else `$OPENCLAW_WORKSPACE/tools/nox-mem/nox-mem.db`; else an existing `<package>/nox-mem.db` (installs from ≤3.4 keep working — with a warning if it sits inside `node_modules`, which `npm update -g` replaces); else `~/.nox-mem/nox.db`. `nox-mem doctor` prints the resolved path.

> Without embeddings, search is FTS5 keyword search. When every term must match and nothing does, the OR fallback (see `NOX_FTS_OR_FALLBACK` above) retries with the content words, so a full question (`"when was the zebra migration?"`) still finds `zebra migration`. Run `vectorize` for semantic search.

---

## sqlite-vec and platform binaries

`sqlite-vec` ships native `.so`/`.dylib`/`.dll` files as platform-specific optional npm packages (`sqlite-vec-linux-x64`, `sqlite-vec-darwin-arm64`, etc.). A plain `npm install` on a supported platform automatically resolves and downloads the correct binary — no `postinstall` script required. The nox-mem `package.json` explicitly lists all platform variants under `optionalDependencies` so package managers that strip optional deps by default still see them declared.

---

*MIT License — Copyright (c) 2026 Luiz Antonio Busnello (Toto)*
