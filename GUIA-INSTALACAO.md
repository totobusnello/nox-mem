# Guia de Instalação — nox-mem
### Motor de memória híbrida para agentes de IA — instalação standalone

---

## O que é o nox-mem

O nox-mem é um motor de memória para agentes AI: ele indexa arquivos Markdown, constrói um grafo de conhecimento e expõe busca híbrida (FTS5 + embeddings semânticos + RRF). Roda como processo Node.js em Linux ou macOS. **Não depende do OpenClaw** — pode ser usado com qualquer agente.

**A instalação é um comando:** `npm i -g nox-mem`. Funciona em Linux, macOS e Windows, com Node 20+.
O `install.sh` (só Linux) é opcional: ele confere pré-requisitos, roda esse mesmo `npm i -g` e cria a pasta de dados e o `.env` para você. Veja a Seção 3.

---

## Pré-requisitos

| Requisito | Mínimo | Notas |
|---|---|---|
| SO | Linux ou macOS | Ubuntu 22.04 LTS é a referência; em RHEL/CentOS use `dnf install gcc gcc-c++ make python3` no lugar de `build-essential` |
| RAM | 2 GB | 4 GB+ recomendado para KG extraction |
| Disco | 10 GB | Cresce com o volume de memória |
| Node.js | 20+ | Ver Seção 1 (Node 22 LTS recomendado) |
| Compilador C++ + `python3` | qualquer | Só entram em cena se o `better-sqlite3` não achar binário pronto para sua plataforma e precisar compilar (o `node-gyp` usa `python3`) |

`inotify-tools` **não** é necessário para instalar via npm nem para o `nox-mem watch`. Só o script `nox-mem/nox-mem-watch.sh` (unit systemd, layout OpenClaw) usa `inotifywait`.

---

## Seção 1 — Preparar o servidor e o Node.js

```bash
# Debian/Ubuntu: ferramentas de build (só necessárias se o npm precisar compilar)
sudo apt-get update && sudo apt-get install -y build-essential python3

# Node.js 22 LTS via NodeSource (o requisito mínimo continua sendo 20)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

node --version   # v20.x.x ou superior
npm --version
```

---

## Seção 2 — Instalar

```bash
npm i -g nox-mem
nox-mem --help
```

Isso instala três comandos: `nox-mem` (CLI), `nox-mem-mcp` (servidor MCP) e `nox-mem-api` (API HTTP).

Se o `npm` reclamar de permissão no prefixo global, aponte-o para uma pasta sua em vez de usar `sudo`:

```bash
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Para compilar a partir do código-fonte (só se você quer mexer no motor):

```bash
git clone https://github.com/totobusnello/nox-mem.git
cd nox-mem/nox-mem
npm ci && npm run build && npm install -g .
```

---

## Seção 3 — `install.sh` (opcional, Linux)

O `install.sh` do repositório instala do registry do npm (`npm install -g nox-mem`), não do clone. Ele **não** precisa de root, exceto para instalar ferramentas de build que faltem ou se o prefixo global do npm for do root; nesses casos ele para logo no início e diz o que fazer.

```bash
git clone https://github.com/totobusnello/nox-mem.git && cd nox-mem
bash install.sh --dry-run     # preview: não muda nada
bash install.sh
```

**O que acontece:**
1. Verifica Node.js >= 20 (e as ferramentas de build, se faltarem)
2. `npm install -g nox-mem` (use `NOX_MEM_VERSION=3.5.1 bash install.sh` para fixar uma versão)
3. Cria `~/.nox-mem/` (com `memory/` dentro) e um `.env` em `~/.nox-mem/.env`

**Fora do padrão (você liga com uma flag):**

| Flag | O que faz |
|---|---|
| `--with-cron` | Cron `vectorize` a cada 4h. O cron de `consolidate` (23h) só entra se `OPENCLAW_WORKSPACE` estiver definido, porque o `consolidate` escreve em `$OPENCLAW_WORKSPACE/memory` e faz commit lá. Os crons carregam o `.env` antes de rodar. |
| `--with-watcher` | Unit systemd para o layout OpenClaw. Exige root, systemd e o checkout do repositório. Para uma pasta de notas comum, **não use**: veja a Seção 10. |

---

## Seção 4 — Configurar variáveis de ambiente

Crie `~/.nox-mem/.env` (o `install.sh` já cria; o modelo é o `nox-mem/.env.example` do repositório) e preencha no mínimo:

```bash
GEMINI_API_KEY=AIz...                   # https://aistudio.google.com/apikey
NOX_DB_PATH=$HOME/.nox-mem/nox.db       # opcional: este já é o padrão
NOX_API_TOKEN=                          # opcional; gerar: openssl rand -hex 32
```

Se `NOX_DB_PATH` apontar para uma pasta que não existe, o nox-mem cria a pasta (modo 0700) na primeira execução.

Depois de preencher, carregue o arquivo em todo shell, cron ou serviço que rode o `nox-mem`:

```bash
set -a; source ~/.nox-mem/.env; set +a
```

**Sobre `NOX_MEM_DIR` (opcional):** ela **não** é a pasta de notas e nenhum comando lê arquivos dela. Ela só define onde ficam os snapshots pré-operação (`$NOX_MEM_DIR/.nox-snapshots`) e amplia a lista de caminhos permitidos do op-audit. Sem ela, os snapshots vão para `<pasta do banco>/.nox-snapshots`.

> ⚠️ **Armadilha do `OPENCLAW_WORKSPACE`:** não defina essa variável num setup standalone. Sem `NOX_DB_PATH`, ela move o banco para `$OPENCLAW_WORKSPACE/tools/nox-mem/nox-mem.db`, um banco diferente e vazio.

> **Sobre a chave Gemini:** o saldo prepaid é por projeto GCP, não por chave. Se você receber erro 429 com uma chave nova, o projeto pode estar sem saldo.

---

## Seção 5 — Verificar a instalação

```bash
nox-mem --help
nox-mem doctor      # Core deve ficar ✅/⚠️; ⚪ em "Optional integrations" é normal

# Indexe suas notas: aceita vários arquivos por chamada
nox-mem ingest ~/.nox-mem/memory/*.md

# Iniciar a API (porta padrão 18802; NOX_API_PORT muda)
nox-mem-api &

# Health check — cobertura de vetores (embedded / total) deve ser >= 0.99
curl -s http://127.0.0.1:18802/api/health | jq '.vectorCoverage | .embedded/.total'
```

`vectorCoverage` é um objeto (`embedded`, `total`, `orphans`, `indexOnly`), não um número. Se `embedded/total` estiver abaixo de 0.99, rode:

```bash
nox-mem vectorize
```

> ⚠️ `nox-mem reindex` **não** indexa as suas notas. Ele reconstrói o índice a partir de `$OPENCLAW_WORKSPACE/memory` e `/shared` (layout OpenClaw) e, num setup standalone, recusa rodar ou não acha nada. Para notas, use `nox-mem ingest` (ou o watcher da Seção 10).

Uma pasta passada ao `ingest` dá erro com o nome dela e o comando segue para os outros arquivos (saída final com código 1 se algum falhou). Passe arquivos: `nox-mem ingest pasta/*.md`.

---

## Seção 6 — Multi-provider (alternativa ao Gemini)

Por padrão o nox-mem usa Gemini via AI Studio. Para usar outro provider (DeepSeek, OpenRouter, Ollama local, etc.), adicione ao `.env`. Os nomes válidos de provider são `gemini` e `openai` (o `openai` cobre **qualquer endpoint compatível com a API da OpenAI**); qualquer outro nome dá erro.

```bash
# LLM (reflect, answer)
NOX_LLM_PROVIDER=openai
NOX_LLM_BASE_URL=https://openrouter.ai/api/v1
NOX_LLM_MODEL=deepseek/deepseek-chat
NOX_LLM_API_KEY=sk-...

# Embeddings — a dimensão TEM que ser 3072 (a mesma da tabela vec0 padrão)
NOX_EMBEDDING_PROVIDER=openai
NOX_EMBEDDING_BASE_URL=https://api.openai.com/v1
NOX_EMBEDDING_MODEL=text-embedding-3-large
NOX_EMBEDDING_DIM=3072
NOX_EMBEDDING_API_KEY=sk-...
```

A troca é feita em runtime — não precisa recompilar. Trocar de modelo de embedding exige re-embedar o corpus inteiro; `text-embedding-3-small` (1536 dimensões) só serve para um banco novo e vazio. Detalhes e a lista completa de variáveis: `nox-mem/README.md`.

`consolidate`, `kg-extract`, `digest` e a expansão de query ainda não passam pela camada de providers: eles chamam o Gemini diretamente (o `consolidate` cai para Groq e depois Claude; o `digest`, para Groq e depois Ollama local) e precisam de `GEMINI_API_KEY`, mesmo com outro provider configurado.

---

## Seção 7 — Usar o motor

### Busca

```bash
nox-mem search "decisão de arquitetura"
nox-mem search "erro prod" --limit 10
```

Sem `GEMINI_API_KEY` (ou sem vetores), a busca é por palavra-chave (FTS5). Se a busca em AND não achar nada, o nox-mem tenta de novo em OR com as palavras de conteúdo, então uma pergunta em linguagem natural também funciona. Esse fallback só fica desligado quando o provider de embedding configurado tem chave.

### Ingerir arquivos

```bash
# Markdown convencional: um ou vários arquivos
nox-mem ingest ~/.nox-mem/memory/2026-06-15.md ~/.nox-mem/memory/2026-06-16.md
nox-mem ingest ~/.nox-mem/memory/*.md

# Entity file (formato frontmatter + compiled + timeline)
nox-mem ingest-entity ~/.nox-mem/memory/entities/person/toto.md
```

Passado de 10.000 chunks no banco, o `ingest` (e o `watch`) pede confirmação: rode com `--allow-prod` ou com `NOX_ALLOW_PROD_INGEST=1`. Isso existe para um script de teste não escrever por engano no seu banco principal.

### Estatísticas

```bash
nox-mem stats
# Mostra: chunks, vetores, entidades KG, cobertura
```

### Grafo de conhecimento

```bash
nox-mem kg-build            # extrai entidades e relações com Gemini
nox-mem kg-query "nome"     # uma entidade e suas relações
```

### API HTTP (porta 18802)

```bash
# Busca via API
curl -H "Authorization: Bearer $NOX_API_TOKEN" \
     "http://127.0.0.1:18802/api/search?q=query"

# Síntese sobre memória + KG (exige ?q=)
curl -H "Authorization: Bearer $NOX_API_TOKEN" \
     "http://127.0.0.1:18802/api/reflect?q=o+que+decidimos+sobre+preco"

# Health
curl http://127.0.0.1:18802/api/health | jq .
```

---

## Seção 8 — Backups e operações destrutivas

O nox-mem cria snapshots automáticos antes de qualquer operação destrutiva (`reindex`, `consolidate`, `compact`, `crystallize`, `kg-prune`). Numa instalação standalone os snapshots ficam em `<NOX_MEM_DIR ou pasta do banco>/.nox-snapshots/` (por exemplo `~/.nox-mem/.nox-snapshots/`), com retenção de 7 dias. `NOX_PRE_OP_SNAPSHOT_DIR` muda o destino.

Não existe (ainda) um comando de restauração na CLI. Para restaurar, **com o `nox-mem-api`, o watcher e qualquer outro processo parados**: copie o snapshot por cima do arquivo do banco e só depois apague os arquivos `-wal` e `-shm` ao lado dele.

```bash
cp ~/.nox-mem/.nox-snapshots/<snapshot>.db ~/.nox-mem/nox.db
rm -f ~/.nox-mem/nox.db-wal ~/.nox-mem/nox.db-shm
```

Copiar sem apagar o WAL antigo corrompe o banco. Faça uma cópia do banco atual antes, por precaução.

Para testar qualquer operação destrutiva sem mutar dados:

```bash
nox-mem reindex --dry-run
nox-mem kg-prune --dry-run
```

---

## Seção 9 — Crons automáticos (opcional)

O `install.sh --with-cron` instala o cron abaixo (e o de `consolidate`, só com `OPENCLAW_WORKSPACE` definido). Cron não herda o seu ambiente, por isso a linha carrega o `.env` antes:

```
0 */4 * * *  set -a; . $HOME/.nox-mem/.env; set +a; nox-mem vectorize >> $HOME/.nox-mem/logs/nox-mem.log 2>&1
```

Verificar:

```bash
crontab -l | grep -A5 NOX-MEM
tail -f ~/.nox-mem/logs/nox-mem.log
```

---

## Seção 10 — Indexação automática (watcher)

Para indexar sozinho o que você salvar numa pasta, sem systemd e sem `inotify-tools`:

```bash
set -a; source ~/.nox-mem/.env; set +a
NOX_WATCH_DIRS="$HOME/.nox-mem/memory" nox-mem watch
```

`NOX_WATCH_DIRS` é uma lista de caminhos absolutos separados por vírgula. **Sem ela**, o `nox-mem watch` observa o layout OpenClaw (`$OPENCLAW_WORKSPACE/memory` e `/shared`), que não existe num setup standalone, e imprime "Watching 0 directories". Deixe-o rodando num `tmux`/`screen`, ou num serviço seu que carregue o `.env`.

A unit systemd do repositório (`install.sh --with-watcher`) é para o layout OpenClaw: ela observa `$OPENCLAW_WORKSPACE/{memory,shared}`, não a sua pasta de notas.

---

## Seção 11 — Troubleshooting

**`nox-mem: command not found` após instalação**

```bash
# Verificar onde npm instala globalmente
npm prefix -g
# Adicionar ao PATH se necessário
export PATH="$(npm prefix -g)/bin:$PATH"
```

**`vectorize` retorna "0 embedded, N errors"**

```bash
# O env não foi carregado. Verificar:
echo $GEMINI_API_KEY
# Recarregar:
set -a; source ~/.nox-mem/.env; set +a
nox-mem vectorize
```

**`sqlite-vec` não encontrado / `vec0` não carrega**

O `sqlite-vec` usa binários nativos por plataforma (pacotes opcionais `sqlite-vec-<os>-<arch>`). O conserto é reinstalar o próprio `nox-mem`, para o npm puxar o binário da sua plataforma. `npm i -g sqlite-vec` não resolve.

```bash
npm i -g nox-mem
# a partir de um clone:  cd nox-mem/nox-mem && npm ci --include=optional
```

**API não responde**

```bash
# Verificar se está rodando
ps aux | grep nox-mem-api

# Verificar a porta
ss -tlnp | grep 18802

# Iniciar manualmente
set -a; source ~/.nox-mem/.env; set +a
nox-mem-api
```

Se a porta 18802 estiver ocupada, mude com `NOX_API_PORT`.

---

*nox-mem | MIT License | github.com/totobusnello/nox-mem*
