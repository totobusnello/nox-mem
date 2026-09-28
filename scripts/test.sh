#!/usr/bin/env bash
# NOX-Supermem — Smoke Test
# Uso: bash scripts/test.sh
# Valida que todos os comandos core funcionam após instalação

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; RESET='\033[0m'; BOLD='\033[1m'

pass() { echo -e "${GREEN}[✓]${RESET} $*"; }
fail() { echo -e "${RED}[✗]${RESET} $*"; exit 1; }
warn() { echo -e "${YELLOW}[!]${RESET} $*"; }

echo -e "${BOLD}NOX-Supermem — Smoke Test${RESET}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Verifica que o binário existe
command -v nox-mem &>/dev/null || fail "nox-mem não encontrado — execute install.sh primeiro"
pass "nox-mem disponível"

# 2. Doctor — verifica saúde do sistema
nox-mem doctor --quiet 2>/dev/null || fail "nox-mem doctor falhou — corrija os problemas reportados"
pass "nox-mem doctor OK"

# 3. Stats — banco acessível
nox-mem stats &>/dev/null || fail "nox-mem stats falhou — banco de dados inacessível"
pass "nox-mem stats OK"

# 4. Search — FTS5 funcional
nox-mem search "teste" &>/dev/null || fail "nox-mem search falhou — FTS5 com problema"
pass "nox-mem search OK"

# 5. Primer — recuperação de contexto
nox-mem primer &>/dev/null || fail "nox-mem primer falhou"
pass "nox-mem primer OK"

# 6. Watcher — serviço systemd (opcional, pode não ter systemd)
if command -v systemctl &>/dev/null; then
  systemctl is-active nox-mem-watcher 2>/dev/null && pass "watcher ativo" || warn "watcher inativo (systemctl encontrado mas serviço parado)"
else
  warn "watcher não testado (systemctl não disponível)"
fi

# 7. Crons — consolidação agendada
crontab -l 2>/dev/null | grep -q "nox-mem consolidate" && pass "cron de consolidação configurado" || warn "cron de consolidação não encontrado"

# 8. Integridade do índice — coberta pelo `doctor` (FTS5 indexed == chunks).
# NÃO rodar `reindex` aqui: ele reconstrói a partir de OPENCLAW_WORKSPACE, e numa
# instalação sem esse diretório apaga todo chunk ingerido com `nox-mem ingest`
# (há snapshot em .nox-snapshots/, mas smoke test não pode ser destrutivo).
# `reindex` também não tem `--dry-run`: a primeira perna sempre falhava e a
# segunda rodava o reindex de verdade.

# 9. Teste de ingest (cria nota temporária e ingere)
TEST_NOTE="${TMPDIR:-/tmp}/nox-mem-test-$$.md"
echo "# Teste Forge\nDecisão de teste: ingest funcionando em $(date)" > "$TEST_NOTE"
nox-mem ingest "$TEST_NOTE" &>/dev/null && pass "ingest: nota de teste ingerida" || fail "ingest: falhou"
rm -f "$TEST_NOTE"

# 10. Ollama — modelo de embedding acessível
curl -sf http://localhost:11434/api/tags &>/dev/null && pass "Ollama acessível" || warn "Ollama não acessível (servidor offline?)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}${BOLD}✅ Todos os testes passaram!${RESET}"
