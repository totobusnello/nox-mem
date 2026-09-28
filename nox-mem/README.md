# nox-mem

Pain-weighted hybrid memory engine for AI agents. Self-hosted, zero vendor lock-in.

**Stack:** TypeScript · Node 20+ · SQLite (FTS5 + sqlite-vec) · Gemini embeddings (default) · OpenAI-compat optional

## Quick start

```bash
npm i -g nox-mem
export GEMINI_API_KEY=AIza...   # https://aistudio.google.com/apikey
export NOX_DB_PATH="$HOME/.nox-mem/nox.db"
export NOX_MEM_DIR="$HOME/.nox-mem/memory"
mkdir -p "$HOME/.nox-mem/memory"
nox-mem stats
```

---

## Prerequisites

### System packages (Linux)

```bash
apt-get update
apt-get install -y build-essential python3 python3-pip inotify-tools
```

`build-essential` and `python3` are required by `better-sqlite3` (compiles a native addon) and `@xenova/transformers` (optional local embeddings).

### Node.js 20+

```bash
# Via NodeSource (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
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
git clone https://github.com/totobusnello/nox-supermem.git
cd nox-supermem/nox-mem
npm ci
npm run build
npm install -g .
```

After either method, the `nox-mem` command is available globally.

---

## Environment variables

Copy `.env.example` to `.env` in your install directory and fill in the required values, then source it before running:

```bash
set -a; source /path/to/.env; set +a
nox-mem stats
```

### Required

| Var | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Google AI Studio key (default LLM + embedding provider). |
| `NOX_DB_PATH` | `<cwd>/nox-mem.db` | SQLite database path. Its directory is auto-added to the op-audit allowlist. |
| `NOX_MEM_DIR` | — | Directory of markdown memory files to ingest/watch. |

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
| `OPENCLAW_WORKSPACE` | `/root/.openclaw/workspace` | Origin platform workspace root (origin/legacy only). |
| `NOX_OP_AUDIT_ALLOWED_PREFIXES` | derived from `NOX_DB_PATH`/`NOX_MEM_DIR` + origin defaults | Comma-sep path prefixes the DB/snapshots may live under. |
| `NOX_PRE_OP_SNAPSHOT_DIR` | `<NOX_MEM_DIR>/.nox-snapshots` (standalone) | Pre-op snapshot directory. |
| `NOX_PROTECTED_NAMES` | empty | Comma-sep names never auto-merged in the KG. |
| `NOX_NAME_ALIASES` | empty | `from:To` name-normalization pairs for the KG. |
| `NOX_ENTITY_PATTERNS` / `NOX_PROJECT_PATTERNS` | empty | Terms for the legacy regex entity extractor. |
| `NOX_KNOWN_PROJECTS` | empty | Project slugs for `project-context-gen`. |
| `NOX_AGENTS` / `NOX_AGENTS_DIR` | empty / — | Multi-agent cross-search layout (no-op standalone). |
| `NOX_WATCH_DIRS` | origin layout | Comma-sep dirs for the file watcher. |
| `NOX_SPEAKER_FILTER` | empty | One-time V7 migration speaker classification. |
| `NOX_NOTION_TOKEN` / `NOX_NOTION_TOKEN_PATH` | — / `/root/.config/notion/api_key` | Optional Notion sync token (value or file path). |

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

Supported values for `NOX_EMBEDDING_PROVIDER` (alias `NOX_EMBED_PROVIDER`): `gemini` (default) · `openai` (any OpenAI-compat endpoint, including local Ollama/vLLM) · `voyage`.

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

All destructive operations (reindex, consolidate, compact, crystallize, kg-prune) create an atomic SQLite snapshot before mutating data. Snapshots land in `$NOX_PRE_OP_SNAPSHOT_DIR` (default: `/var/backups/nox-mem/pre-op/`). Retention: 7 days. Do NOT restore with raw `cp` — use the `safeRestore()` path or the `--restore` flag which handles WAL/SHM cleanup correctly.

---

## Sanity check

After install, verify the engine is healthy:

```bash
nox-mem doctor          # Core must be ✅/⚠️; ⚪ under "Optional integrations" is fine
nox-mem doctor --quiet  # scripts: prints only core problems, exits 1 if one failed

# Start the API server
nox-mem-api &

# Check vector coverage (should be close to 1.0). Code default port is 18800.
curl -s "http://127.0.0.1:${NOX_API_PORT:-18800}/api/health" | jq .vectorCoverage
```

A `vectorCoverage` value below 0.99 means some chunks are not yet embedded — run `nox-mem vectorize` to catch up.

---

## Key commands

```
nox-mem search "query"     — hybrid search (FTS5 + semantic + RRF)
nox-mem search "q" --as-of 2026-05-01        — time-travel: chunks that existed then
nox-mem search "q" --changed-since 7d        — recency window (15m, 2h, 7d, 1w or ISO)
NOX_FTS_OR_FALLBACK=auto|on|off — FTS5 OR retry (stopwords dropped) when the AND query finds nothing; auto (default) = only when no GEMINI_API_KEY/OPENAI_API_KEY is set, so natural-language questions work on keyless installs and keyed setups are unchanged
nox-mem answer "question"  — grounded answer with citations (needs GEMINI_API_KEY)
nox-mem ingest <file>      — ingest a markdown or entity file (one file per call)
nox-mem reindex            — rebuild the index from $OPENCLAW_WORKSPACE (see warning below)
nox-mem vectorize          — embed any unembedded chunks
nox-mem stats              — chunk/entity/vector counts
nox-mem kg-build           — extract knowledge graph entities
nox-mem reflect            — surface high-salience insights
nox-mem-api                — start HTTP API on $NOX_API_PORT (code default 18800)
nox-mem-mcp                — start MCP server over stdio (20 tools, for agents)
nox-mem doctor             — health check (core + optional integrations)
nox-mem --help             — full command reference
```

Wire the MCP server into Claude Code:

```bash
claude mcp add nox-mem -e NOX_DB_PATH="$HOME/.nox-mem/nox.db" -e GEMINI_API_KEY="$GEMINI_API_KEY" -- nox-mem-mcp
```

The temporal filter is also on HTTP (`?as_of=` / `?changed_since=` on `/api/search`, or the same keys in a POST body) and MCP (`as_of` / `changed_since` on `nox_mem_search`). It is a hard SQL pre-filter on `created_at` / `updated_at` (ingestion time), not a ranking boost. `as_of` answers *which chunks existed then*, not *what they said then*: there is no version history, so a chunk edited after the date comes back with its current text. A bare date means the whole day in UTC (`--as-of 2026-05-01` includes 23:59 that day; `--changed-since 2026-05-01` starts at 00:00); a time without an offset is read as UTC. An unparseable date is an error on every surface (exit 2 / HTTP 400 / MCP `isError`), never a silently unfiltered search.

> ⚠️ **`reindex` rebuilds only from `$OPENCLAW_WORKSPACE/memory` and `/shared`** (default workspace `/root/.openclaw/workspace`). If that source is missing or empty while the DB holds chunks, it **refuses before touching the DB**; if the rebuild would drop more than 10% of the chunks, it refuses before deleting anything (`NOX_REINDEX_MIN_RETENTION_RATIO`, override `NOX_REINDEX_ALLOW_WIPE=1`). Chunks ingested from outside the workspace are still treated as orphans by a reindex that does run. Preview with `nox-mem reindex --dry-run`. On a standalone install that adds notes with `nox-mem ingest <file>` you normally do not need `reindex`.

> **Where the database lives.** `NOX_DB_PATH` if set; else `$OPENCLAW_WORKSPACE/tools/nox-mem/nox-mem.db`; else an existing `<package>/nox-mem.db` (installs from ≤3.4 keep working — with a warning if it sits inside `node_modules`, which `npm update -g` replaces); else `~/.nox-mem/nox.db`. `nox-mem doctor` prints the resolved path.

> Without embeddings, search is FTS5 keyword search, which requires every term to match: prefer keywords (`"zebra migration"`) over full questions (`"when was the zebra migration?"`) until you run `vectorize`.

---

## sqlite-vec and platform binaries

`sqlite-vec` ships native `.so`/`.dylib`/`.dll` files as platform-specific optional npm packages (`sqlite-vec-linux-x64`, `sqlite-vec-darwin-arm64`, etc.). A plain `npm install` on a supported platform automatically resolves and downloads the correct binary — no `postinstall` script required. The nox-mem `package.json` explicitly lists all platform variants under `optionalDependencies` so package managers that strip optional deps by default still see them declared.

---

*MIT License — Copyright (c) 2026 Luiz Antonio Busnello (Toto)*
