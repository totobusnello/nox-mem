import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseQuery } from "../lib/query-params.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

test("a '+' is a space, as URLSearchParams clients send it", () => {
  const q = new URLSearchParams({ q: "salience formula" }).toString();
  assert.equal(q, "q=salience+formula");
  assert.equal(parseQuery(`/api/search?${q}`).q, "salience formula");
  assert.equal(parseQuery("/api/search?q=salience%20formula").q, "salience formula");
});

test("a value containing '=' is kept whole", () => {
  assert.equal(parseQuery("/api/search?q=a=b&limit=5").q, "a=b");
  assert.equal(parseQuery("/api/search?q=a=b&limit=5").limit, "5");
});

test("a malformed escape does not throw", () => {
  assert.doesNotThrow(() => parseQuery("/api/search?q=%E0%A4%A"));
  assert.equal(typeof parseQuery("/api/search?q=%E0%A4%A").q, "string");
});

test("keys cannot reach Object.prototype", () => {
  const p = parseQuery("/api/search?__proto__=x&hasOwnProperty=y&constructor=z&q=ok");
  assert.equal(Object.getPrototypeOf(p), null);
  assert.equal(p.__proto__, "x");
  assert.equal(p.hasOwnProperty, "y");
  assert.equal(p.q, "ok");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("no query string and empty keys", () => {
  assert.deepEqual({ ...parseQuery("/api/health") }, {});
  assert.deepEqual({ ...parseQuery("/api/search?=x&q=1") }, { q: "1" });
});

test("api-server.ts uses the shared parser, not a local copy", () => {
  const server = readFileSync(join(SRC, "api-server.ts"), "utf8");
  assert.match(server, /import \{ parseQuery \} from "\.\/lib\/query-params\.js"/);
  assert.doesNotMatch(server, /function parseQuery/);
  assert.doesNotMatch(server, /decodeURIComponent\(k\)/);
});
