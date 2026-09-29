// The HTTP API default port is 18802 (every doc says so; 18800 collides with
// Chrome). NOX_API_PORT still overrides. Nothing in src/ may hardcode 18800.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_API_PORT, resolveApiPort } from "../lib/api-port.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

test("default is 18802", () => {
  assert.equal(DEFAULT_API_PORT, 18802);
  assert.equal(resolveApiPort({}), 18802);
});

test("NOX_API_PORT overrides; junk falls back to the default", () => {
  assert.equal(resolveApiPort({ NOX_API_PORT: "19999" }), 19999);
  assert.equal(resolveApiPort({ NOX_API_PORT: " 20001 " }), 20001);
  assert.equal(resolveApiPort({ NOX_API_PORT: "" }), 18802);
  assert.equal(resolveApiPort({ NOX_API_PORT: "abc" }), 18802);
  assert.equal(resolveApiPort({ NOX_API_PORT: "70000" }), 18802);
});

test("api-server.ts takes its port from resolveApiPort and no source file hardcodes 18800", () => {
  const server = readFileSync(join(SRC, "api-server.ts"), "utf8");
  assert.match(server, /const PORT = resolveApiPort\(\)/);
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.includes("__tests__") && readFileSync(p, "utf8").includes("18800")) offenders.push(p);
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, []);
});
