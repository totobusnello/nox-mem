// Shared by the CLI-level install-path tests: run the compiled CLI (dist/index.js)
// in a child process with a fully isolated environment. This file has no tests of
// its own; node --test only runs *.test.js.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** dist/index.js: this file compiles to dist/__tests__/cli-helpers.js. */
export const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

export function tmpRoot(label: string): string {
  return mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), `nox-mem-${label}-`));
}

export function runCli(args: string[], env: Record<string, string>, home: string) {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    "OPENCLAW_WORKSPACE", "NOX_DB_PATH", "NOX_MEM_DIR", "NOX_ALLOW_PROD_INGEST", "NOX_API_PORT",
    "GEMINI_API_KEY", "OPENAI_API_KEY", "NOX_EMBEDDING_API_KEY", "NOX_EMBED_API_KEY",
  ]) delete clean[k];
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...clean, HOME: home, USERPROFILE: home, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
