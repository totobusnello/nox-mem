// The embedding request must carry the whole chunk, not its first 2,048 characters (2026-10-15).
//
// Gemini's limit for gemini-embedding-001 is 2,048 TOKENS and the API truncates longer input itself.
// The client cut every text at 2,048 CHARACTERS, so 46% of production chunks were embedded from their
// opening only and 44% of the corpus text never reached a vector. The client now sends up to
// EMBED_MAX_CHARS (a payload guard well above 2,048 tokens of any measured text) and lets the API cut.
//
// Run: npx tsc -p tsconfig.test.json && node --test dist/__tests__/embed-window.test.js

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

for (const k of ["OPENAI_API_KEY", "NOX_EMBEDDING_API_KEY", "NOX_EMBED_API_KEY", "NOX_EMBEDDING_PROVIDER", "NOX_EMBED_PROVIDER"]) delete process.env[k];
process.env.GEMINI_API_KEY = "test-not-a-real-key";

let embed: any;
const sent: string[] = [];
const realFetch = globalThis.fetch;

before(async () => {
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    const dim = embed.activeEmbeddingDim();
    if (Array.isArray(body.requests)) {
      for (const r of body.requests) sent.push(r.content.parts[0].text);
      return new Response(JSON.stringify({ embeddings: body.requests.map(() => ({ values: new Array(dim).fill(0.01) })) }), { status: 200 });
    }
    sent.push(body.content.parts[0].text);
    return new Response(JSON.stringify({ embedding: { values: new Array(dim).fill(0.01) } }), { status: 200 });
  }) as typeof fetch;
  embed = await import("../embed.js");
});
after(() => { globalThis.fetch = realFetch; });

const LONG = "palavra ".repeat(600); // 4,800 chars: over the old cut, under 2,048 tokens

test("document embedding sends the whole chunk", async () => {
  sent.length = 0;
  await embed.embedDocument(LONG);
  assert.equal(sent[0]!.length, LONG.length);
});

test("batch embedding sends the whole chunk", async () => {
  sent.length = 0;
  await embed.embedBatchAPI([LONG, "curto"], { pauseMs: 0 });
  assert.deepEqual(sent.map((s) => s.length), [LONG.length, 5]);
});

test("query embedding sends the whole query", async () => {
  sent.length = 0;
  await embed.embedText(LONG);
  assert.equal(sent[0]!.length, LONG.length);
});

test("a text beyond the payload guard is cut at EMBED_MAX_CHARS, on every path", async () => {
  const huge = "x".repeat(embed.EMBED_MAX_CHARS + 5000);
  sent.length = 0;
  await embed.embedDocument(huge);
  await embed.embedBatchAPI([huge], { pauseMs: 0 });
  await embed.embedText(huge);
  assert.deepEqual(sent.map((s) => s.length), [embed.EMBED_MAX_CHARS, embed.EMBED_MAX_CHARS, embed.EMBED_MAX_CHARS]);
  assert.ok(embed.EMBED_MAX_CHARS >= 8000, "guard must exceed 2,048 tokens of the densest measured text (3.9 chars/token)");
});
