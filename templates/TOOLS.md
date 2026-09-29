# TOOLS.md — Ferramentas e Comandos

## NOX-Supermem (nox-mem)

| Comando | Descrição |
|---|---|
| `nox-mem search "termo"` | Busca semântica por palavra-chave na memória indexada |
| `nox-mem ingest <arquivos...>` | Indexa um ou mais arquivos Markdown no banco de dados |
| `nox-mem reindex` | Reindexar toda a memória (preserva consolidações) |
| `nox-mem primer` | Gera resumo de contexto para recovery pós-compactação |
| `nox-mem stats` | Estatísticas: chunks, arquivos, última consolidação |
| `nox-mem consolidate` | Extrai fatos das notas diárias usando Gemini (com Groq e Claude como fallback) |
| `nox-mem retry-failed` | Reprocessar arquivos que falharam na consolidação |
| `nox-mem digest` | Resumo semanal via Gemini ou Groq, com Ollama local como último recurso (salvo em memory/digests/) |
| `nox-mem doctor` | Diagnóstico completo do sistema |

## Crons Automáticos

| Horário | Comando | Função |
|---|---|---|
| 23:00 diário | `nox-mem consolidate` | Extrai fatos das notas do dia |
| 21:00 domingo | `nox-mem digest` | Gera resumo da semana |

## Logs
- Instalação: `/tmp/nox-supermem-install.log`
- Crons: `~/.openclaw/workspace/logs/nox-mem.log`
- Watcher: `/tmp/nox-mem-watcher.log`
