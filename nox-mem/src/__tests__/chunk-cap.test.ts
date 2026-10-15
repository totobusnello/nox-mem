// No chunk may exceed MAX_CHUNK_CHARS (2026-10-15).
//
// chunkMarkdown split long sections by WORD count, so text with few spaces or no blank lines never split:
// a CSV block (",,,,") counts as one word per row, OCR output has no paragraph breaks. Production held
// 1,107 chunks over 8 KB, the largest 1 MB; the embedding model reads ~2,048 tokens, so the rest of each
// was invisible to semantic search. Measured density on production text: 1.6 to 3.9 chars/token.
//
// Run: npx tsc -p tsconfig.test.json && node --test dist/__tests__/chunk-cap.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, chunkJson, MAX_CHUNK_CHARS } from "../ingest.js";

const allUnder = (cs: string[]) => cs.every((c) => c.length <= MAX_CHUNK_CHARS);
const squash = (s: string) => s.replace(/\s+/g, "");

test("a CSV block with no spaces and no blank lines is split under the cap, losing nothing", () => {
  const rows = Array.from({ length: 600 }, (_, i) => `,,NUVINI S.A.,${i},01/01/2021,${i * 7},,,,,,,,`);
  const doc = "## Financials\n```csv\n" + rows.join("\n") + "\n```\n";
  const cs = chunkMarkdown(doc);
  assert.ok(cs.length > 1, "not split");
  assert.ok(allUnder(cs), cs.map((c) => c.length).join(","));
  assert.equal(squash(cs.join("")), squash(doc.trim()));
});

test("a single line longer than the cap is cut, at a space when there is one", () => {
  const line = Array.from({ length: 2500 }, (_, i) => `w${i}`).join(" "); // ~13 KB, one line
  const cs = chunkMarkdown("## OCR\n" + line);
  assert.ok(allUnder(cs), cs.map((c) => c.length).join(","));
  assert.equal(squash(cs.join("")), squash("## OCR\n" + line));
  const words = new Set(line.split(" "));
  for (const [i, c] of cs.entries()) {
    const ts = c.split(/\s+/);
    assert.ok(words.has(ts[ts.length - 1]!), `piece ${i} ends mid-word: …${c.slice(-15)}`);
    if (i > 0) assert.ok(words.has(ts[0]!), `piece ${i} starts mid-word: ${c.slice(0, 15)}…`);
  }
});

test("a line with no spaces at all is hard-cut under the cap", () => {
  const blob = "x".repeat(MAX_CHUNK_CHARS * 2 + 17);
  const cs = chunkMarkdown(blob);
  assert.ok(allUnder(cs));
  assert.equal(cs.join(""), blob);
});

test("a JSON item over the cap is split under the cap", () => {
  const cs = chunkJson(JSON.stringify([{ text: "y ".repeat(MAX_CHUNK_CHARS) }, { ok: 1 }]));
  assert.ok(allUnder(cs), cs.map((c) => c.length).join(","));
});

test("an ordinary document chunks exactly as before", () => {
  const sec = (k: number) => `## Section ${k}\nparagraph ${k} has enough words in it to be a chunk of its own and not get merged away.`;
  const doc = [sec(1), sec(2), sec(3)].join("\n\n");
  assert.deepEqual(chunkMarkdown(doc), [sec(1), sec(2), sec(3)]);
});

test("the cap keeps a chunk within ~2,048 tokens at the densest measured text", () => {
  assert.ok(MAX_CHUNK_CHARS <= 2048 * 2, `${MAX_CHUNK_CHARS} chars could exceed 2,048 tokens at 1.6-2 chars/token`);
  assert.ok(MAX_CHUNK_CHARS >= 3000, "500-word prose chunks (~3-3.5 KB) must not be split");
});

test("property: 300 random documents — every chunk under the cap, no non-space character lost", () => {
  let seed = 20261015;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const word = () => "abcdefghij".slice(0, 1 + Math.floor(rnd() * 10)) + Math.floor(rnd() * 1000);
  for (let d = 0; d < 300; d++) {
    const lines: string[] = [];
    const n = 1 + Math.floor(rnd() * 40);
    for (let i = 0; i < n; i++) {
      const r = rnd();
      if (r < 0.1) lines.push(`## H${i}`);
      else if (r < 0.2) lines.push("");
      else if (r < 0.3) lines.push(",".repeat(Math.floor(rnd() * 9000)));
      else if (r < 0.4) lines.push("z".repeat(Math.floor(rnd() * 12000)));
      else lines.push(Array.from({ length: Math.floor(rnd() * 2500) }, word).join(" "));
    }
    const doc = lines.join("\n");
    const cs = chunkMarkdown(doc);
    assert.ok(allUnder(cs), `doc ${d}: ${cs.map((c) => c.length).filter((l) => l > MAX_CHUNK_CHARS)}`);
    assert.equal(squash(cs.join("")), squash(doc), `doc ${d}: text lost`);
  }
});
