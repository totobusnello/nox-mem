// Guards for the two things a VPS migration moved at once: WHERE agent session
// transcripts live, and WHAT SHAPE they have. Both failures are silent — the
// old path simply reports "No unprocessed sessions found" with exit 0, and the
// old schema check drops every line of a Claude CLI transcript without an
// error. One deployment ran 28 days that way with its cron marked "ok".
//
// Run: npx tsc && node --test dist/__tests__/session-distill-sources.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  claudeProjectSlug,
  claudeProjectsDirs,
  sessionDirsFor,
  extractMessages,
} from "../session-distill.js";

function writeTranscript(lines: unknown[]): string {
  const dir = mkdtempSync(resolve(tmpdir(), "nox-distill-"));
  const file = resolve(dir, "session.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
  return file;
}

const CLI_LINES = [
  { type: "queue-operation", op: "enqueue" },
  { type: "attachment", path: "/tmp/x.png" },
  { type: "user", message: { role: "user", content: "por que o distill parou de rodar" } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "porque as sessoes mudaram de endereco" },
        { type: "tool_use", name: "Bash", input: {} },
      ],
    },
  },
];

test("Claude CLI transcripts (type user/assistant) are read", () => {
  const msgs = extractMessages(writeTranscript(CLI_LINES));
  assert.equal(msgs.length, 2, "both turns must survive");
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"]);
  // Only the text part is kept; tool_use carries no prose to distill.
  assert.equal(msgs[1].text, "porque as sessoes mudaram de endereco");
});

test("legacy OpenClaw transcripts (type message) still are read", () => {
  const msgs = extractMessages(
    writeTranscript([
      { type: "message", message: { role: "user", content: "pergunta legada" } },
      { type: "message", message: { role: "assistant", content: "resposta legada" } },
    ])
  );
  assert.equal(msgs.length, 2);
});

test("unknown event types and heartbeat noise stay out", () => {
  const msgs = extractMessages(
    writeTranscript([
      { type: "summary", message: { role: "user", content: "nao e um turno de conversa" } },
      { type: "user", message: { role: "user", content: "HEARTBEAT_OK" } },
      { type: "user", message: { role: "user", content: "[cron:eod] disparo" } },
      { type: "user", message: { role: "user", content: "ok" } },
      { type: "user", content: "sem o campo message" },
    ])
  );
  assert.equal(msgs.length, 0);
});

test("slug derivation matches the Claude CLI layout", () => {
  // The CLI replaces both "/" and "." with "-", so the leading slash and the
  // dotted dir collapse into the doubled dash seen on disk.
  assert.equal(claudeProjectSlug("/root/.openclaw/workspace"), "-root--openclaw-workspace");
  assert.equal(
    claudeProjectSlug("/root/.openclaw/workspace/agents/forge"),
    "-root--openclaw-workspace-agents-forge"
  );
});

test("an explicit NOX_CLAUDE_PROJECTS_DIR wins over discovery", () => {
  const prev = process.env.NOX_CLAUDE_PROJECTS_DIR;
  process.env.NOX_CLAUDE_PROJECTS_DIR = "/somewhere/projects";
  try {
    assert.deepEqual(claudeProjectsDirs(), ["/somewhere/projects"]);
    const dirs = sessionDirsFor("forge");
    // Legacy dir first, then the CLI one — the legacy dir still holds sessions
    // predating the switch, so neither may be dropped.
    assert.equal(dirs.length, 2);
    assert.match(dirs[0], /agents\/forge\/sessions$/);
    assert.equal(dirs[1], "/somewhere/projects/-root--openclaw-workspace-agents-forge");
  } finally {
    if (prev === undefined) delete process.env.NOX_CLAUDE_PROJECTS_DIR;
    else process.env.NOX_CLAUDE_PROJECTS_DIR = prev;
  }
});

test("the main agent maps to the workspace root, not to agents/main", () => {
  const prev = process.env.NOX_CLAUDE_PROJECTS_DIR;
  process.env.NOX_CLAUDE_PROJECTS_DIR = "/p";
  try {
    const cli = sessionDirsFor("main")[1];
    assert.equal(cli, "/p/-root--openclaw-workspace");
    assert.doesNotMatch(cli, /agents-main/);
  } finally {
    if (prev === undefined) delete process.env.NOX_CLAUDE_PROJECTS_DIR;
    else process.env.NOX_CLAUDE_PROJECTS_DIR = prev;
  }
});
