# Reproducing the numbers

This document explains **exactly what each headline number in the [README](./README.md) means, how it was measured, and how you can check it yourself.** We'd rather you find a caveat here than feel misled later.

> **TL;DR on reproducibility.** The benchmark *harness* (adapters, datasets wiring, batch runner) lives in the public research repo [`memoria-nox`](https://github.com/totobusnello/memoria-nox), not in this package. What this repo ships is the **engine** the harness measures. You can reproduce the *engine-side* claims (latency, cost, footprint, retrieval behaviour) directly from this package; the *competitive* numbers (vs MemOS/Mem0/Zep) require the harness + the public datasets listed below. Where a number is a ceiling, a different metric than a competitor's, or measured under specific conditions, it is flagged — both here and in the README footnotes.

---

## What you can reproduce from THIS package

These need only `nox-mem` + your own corpus (and a `GEMINI_API_KEY` for embedding):

| Claim | How to check |
|---|---|
| **KG-path latency ~2.5ms p50** | `nox-mem kg-query` / `GET /api/kg/path` over a populated graph; it's a pure SQLite + regex traversal, no network call. Time it locally. |
| **KG-path cost $0/query** | Same path issues **no LLM/embedding API call** — inspect the code (`src/knowledge-graph.ts`, `src/impact.ts`). Cost is literally an SQLite read. |
| **Single-process footprint (~400MB RSS)** | Run `nox-mem-api` against a 100k-chunk DB and read the process RSS. One process, one SQLite file — no sidecar services. |
| **Hybrid retrieval behaviour** | `nox-mem search "<q>"` returns the BM25 ∥ semantic ∥ RRF merge; `--no-hybrid` isolates BM25. Inspect `src/search.ts`. |
| **Tests** | `cd nox-mem && npm ci && npm test` → 0 fail, 4 skips (key-gated E2E). The suite runs from source; no hidden gates. The pass count grows with every release, so read it off your own run: the number that was in this table (586) is out of date. |

## What needs the research harness + public datasets

The competitive numbers (EverMemBench, LoCoMo, LongMemEval, MuSiQue, HotPotQA) were produced by the `memoria-nox` harness, which adapts each public dataset, runs nox-mem and the baselines under the same protocol, and aggregates 5 batches with 95% CIs. The datasets themselves are public:

| Benchmark | Dataset source |
|---|---|
| LoCoMo | Maharana et al., 2024 — <https://github.com/snap-research/locomo> |
| LongMemEval | Wu et al., 2024 — <https://github.com/xiaowu0162/LongMemEval> |
| MuSiQue | Trivedi et al., 2022 — <https://github.com/StonyBrookNLP/musique> |
| HotPotQA | Yang et al., 2018 — <https://hotpotqa.github.io> |
| EverMemBench | EverMind-AI — see the MemOS paper (arXiv:2602.01313) for the protocol |

**Protocol:** 5 batches per configuration, 95% confidence intervals, backbone noted per result (EverMemBench / MA / backbone-portability on Gemini-3-flash). Single-batch gates are treated as unreliable (they overstate by 3–6×); only 5-batch results with CIs are reported.

If you want to run the full competitive suite, open an issue — we'll point you at the harness and the exact adapter config.

---

## Reading the headline numbers honestly

- **LoCoMo retrieval@10 strict (74.52%)** is a **retrieval** metric, shown next to Mem0's reported **F1**. They are different metrics — it's there for scale, not as a like-for-like win.
- **LongMemEval 1.0** is the **oracle retrieval ceiling**: with gold answers present in the corpus, nDCG@10 saturates at 1.0. It is **not** an end-to-end inference score. Standalone task accuracy is ~68%.
- **769× cheaper / $0 per query** compares nox-mem's **KG path** (pure SQL, no LLM call) to **Mem0 Cloud's** per-query price, which **includes inference**. It's apples-to-oranges by design and true **only for that path** — a normal hybrid search that embeds the query does cost an embedding call.
- **< $11/mo all-in** assumes the cheapest Hostinger VPS + Google AI Studio's free tier. Your bill depends on your provider and volume.
- **+78.8% nDCG@10** is measured against an **internal local-embedding baseline**, not against a competitor.
- **−10.54pp on backbone swap (1.6× more portable)** measures the drop when swapping the LLM backbone, vs MemOS's −16.72pp under the same swap.

---

## Methodology, paper & full competitive analysis

The technical paper and the complete competitive write-up live in [`memoria-nox`](https://github.com/totobusnello/memoria-nox).

References: MemOS (arXiv:2602.01313) · MuSiQue (Trivedi 2022) · HotPotQA (Yang 2018) · LoCoMo (Maharana 2024) · LongMemEval (Wu 2024).
