// Distilled memory never decays BY CHOICE (DECISIONS 2026-10-27 #3). Before this test the distiller's
// INSERT simply did not list retention_days, so never-decay was an accident that any default or
// backfill could have turned into 90 days. These assertions make the absence of decay deliberate:
// the INSERT must name the column and write NULL, and the typed table must say null.
//
// Run: npx tsc && node --test dist/__tests__/distilled-retention.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RETENTION_BY_TYPE, getRetentionForType } from "../retention.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../../src/session-distill.ts"), "utf-8");

test("the distiller INSERT names retention_days and writes NULL", () => {
  const m = src.match(/INSERT INTO chunks \(([^)]*)\)\s*VALUES \(([^)]*)\)/);
  assert.ok(m, "distiller INSERT not found");
  const cols = m[1].split(",").map((s) => s.trim());
  const vals = m[2].split(",").map((s) => s.trim());
  const i = cols.indexOf("retention_days");
  assert.notEqual(i, -1, "retention_days missing from the distiller INSERT");
  assert.equal(vals[i], "NULL", "distilled chunks must be written with retention_days = NULL");
});

test("the typed retention table says distilled never decays", () => {
  assert.equal(RETENTION_BY_TYPE.distilled, null);
  assert.equal(getRetentionForType("distilled"), null);
});
