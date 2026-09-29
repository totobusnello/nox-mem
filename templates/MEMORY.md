# MEMORY.md — Índice de Memória

## Ciclo de Memória (SuperMem)

```
Sessão com agente
      ↓
Nota diária (memory/YYYY-MM-DD.md)
      ↓
Consolidação automática às 23h (Gemini extrai fatos; Groq e Claude como fallback)
      ↓
Arquivos de tópico (decisions, lessons, people, projects, pending)
      ↓
FTS5 search (nox-mem search "palavra")
      ↓
Primer recovery (nox-mem primer → contexto pós-compactação)
```

## Arquivos de Memória

| Arquivo | Conteúdo |
|---|---|
| `memory/decisions.md` | Decisões permanentes e estratégicas |
| `memory/lessons.md` | Lições aprendidas (estratégicas e táticas) |
| `memory/people.md` | Equipe, contatos e contexto de pessoas |
| `memory/projects.md` | Projetos e atualizações de progresso |
| `memory/pending.md` | Pendências e itens a fazer |
| `memory/digests/` | Resumos semanais automáticos |

## Comandos Rápidos

| Comando | O que faz |
|---|---|
| `nox-mem search "termo"` | Busca em toda a memória indexada |
| `nox-mem primer` | Gera resumo de contexto (~500 tokens) |
| `nox-mem stats` | Mostra estatísticas do índice |
| `nox-mem consolidate` | Extrai fatos das notas diárias com IA |
| `nox-mem digest` | Gera resumo semanal (Gemini ou Groq; Ollama local como último recurso) |
| `nox-mem reindex` | Reindexa toda a memória |
| `nox-mem doctor` | Verifica saúde do sistema |
