// consolidate no longer uses Ollama (Gemini, then Claude — see
// src/consolidate.ts). The CLI description, the doctor's Ollama hint and the
// templates must not say otherwise. digest DOES still fall back to Ollama, so
// that statement must stay.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, tmpRoot } from "./cli-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "..", "src");
const TEMPLATES = resolve(HERE, "..", "..", "..", "templates");

test("consolidate --help does not claim Ollama", () => {
  const home = tmpRoot("wording");
  const r = runCli(["consolidate", "--help"], { NOX_DB_PATH: join(home, "n.db") }, home);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /ollama/i);
  assert.match(r.stdout, /Gemini/);
});

test("doctor's Ollama hint ties Ollama to digest, not consolidate", () => {
  const src = readFileSync(join(SRC, "doctor.ts"), "utf8");
  assert.doesNotMatch(src, /used by consolidate/);
  assert.match(src, /only `digest` falls back to it/);
});

test("templates: no line ties consolidate to Ollama; digest keeps its Ollama mention", { skip: !existsSync(TEMPLATES) }, () => {
  for (const f of ["TOOLS.md", "MEMORY.md", "IDENTITY.md"]) {
    const lines = readFileSync(join(TEMPLATES, f), "utf8").split("\n");
    for (const l of lines) {
      if (/consolida/i.test(l)) assert.doesNotMatch(l, /ollama/i, `${f}: ${l}`);
    }
  }
  const tools = readFileSync(join(TEMPLATES, "TOOLS.md"), "utf8");
  assert.ok(tools.split("\n").some((l) => l.includes("nox-mem digest") && /ollama/i.test(l)));
});

// Groq left the package on 2026-11-14: one deployment measured its fallback at 21 failures in 21
// calls, and the operator does not use it. A comment may still name it as history; what must not
// come back is a call to its API, a read of its key, or a user-facing line that promises it.
test("no module calls Groq or reads its key", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) { if (n !== "__tests__") walk(f); }
      else if (f.endsWith(".ts")) files.push(f);
    }
  };
  walk(SRC);
  const hits = files.filter((f) => /api\.groq\.com|GROQ_API_KEY/.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, []);
});

test("CLI help and templates do not offer Groq", () => {
  const home = tmpRoot("wording-groq");
  const r = runCli(["consolidate", "--help"], { NOX_DB_PATH: join(home, "n.db") }, home);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /groq/i);
  for (const t of ["IDENTITY.md", "TOOLS.md", "MEMORY.md"]) {
    const f = join(TEMPLATES, t);
    if (existsSync(f)) assert.doesNotMatch(readFileSync(f, "utf8"), /groq/i, t);
  }
});
