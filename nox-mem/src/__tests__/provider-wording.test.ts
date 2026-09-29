// consolidate no longer uses Ollama (Gemini, then Groq, then Claude — see
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
