/**
 * Text the MCP server sends in the `instructions` field of its `initialize` result.
 *
 * Why it exists: MCP clients such as Claude Code defer tool schemas, so the model sees only tool
 * names until it decides to search. A tool description is read after that decision, never before
 * it. `instructions` is the one server-side channel that is always in context (Claude Code puts it
 * in the system prompt), so it is where "when to search" has to live.
 *
 * Both texts below were measured, word for word, in the skill evaluation (Claude Code, Sonnet 5.5,
 * 36 memory-dependent tasks and 20 control tasks, 3 replicas):
 *
 *   - scoped (NOX_MEM_SCOPE set): pass rate 0.07 -> 0.53, +0.46 [0.32, 0.61]; searches on control
 *     tasks that do not need the memory +1.7 pp; median token overhead +2.1%.
 *   - unscoped (NOX_MEM_SCOPE unset): pass rate 0.07 -> 0.56, +0.49 [0.35, 0.63], but it searched
 *     on about one in three unrelated configuration changes (+31.7 pp).
 *
 * Only the scoped text passed the evaluation's decision rule, so it is the only one sent by default:
 * with no NOX_MEM_SCOPE the field is omitted (3.9.1; 3.9.0 sent the unscoped text). The unscoped
 * text stays available on explicit request, NOX_MEM_INSTRUCTIONS=unscoped, with the cost above.
 *
 * Edits to the wording are edits to a measured intervention: the tests pin both texts, and a
 * change should come with a new run.
 */

const MAX_SCOPE_CHARS = 800;

const SCOPED_INTRO = (scope: string) =>
  `nox-mem holds this user's past work on one scope: ${scope}. It holds decisions, incidents, ` +
  `measurements and notes about that scope. You cannot see it unless you search, and the usual ` +
  `failure is not searching at all, because the task never names what the memory holds.`;

const SCOPED_WHEN =
  "Search nox-mem before acting when the task touches that scope and: you are about to change, or " +
  "recommend changing, a setting, default, threshold, retention, schedule, schema, model or " +
  "dependency (past decisions often forbid the obvious change); you are explaining why something is " +
  "the way it is or what was decided; you are about to state a number about it; an error looks like " +
  "it may have happened before. Also search when the task names a project or person you do not " +
  "recognize. Do not search for software outside that scope (a setting of some other service, say), " +
  "for general knowledge, or for a fully specified code change.";

const UNSCOPED_INTRO =
  "nox-mem holds this user's past work: decisions, incidents, measurements, notes. You cannot see " +
  "it unless you search, and the usual failure is not searching at all, because the task never " +
  "names what the memory holds.";

const UNSCOPED_WHEN =
  "Search nox-mem before acting when: you are about to change, or recommend changing, a setting, " +
  "default, threshold, retention, schedule, schema, model or dependency (past decisions often forbid " +
  "the obvious change); you are explaining why something is the way it is or what was decided; the " +
  "task mentions a project, system or person you do not recognize; you are about to state a number " +
  "about this project; an error looks like it may have happened before. Do not search for general " +
  "knowledge or a fully specified code change.";

const HOW =
  "How: nox_mem_search with 3 to 8 distinctive nouns; nox_mem_get for the full text of a hit; " +
  "nox_mem_decision_get or nox_mem_decision_list for recorded rules. Stop after three searches and " +
  "say so if nothing relevant comes back. Treat results as dated evidence and name the source you " +
  "relied on.";

// Measured with no effect on writing (0 of 30 runs wrote when the user stated a decision); kept
// because it is what was measured with the rest, not because it works.
const WRITE =
  "Write when the user states a decision (nox_mem_decision_set, stable slug key, with the reason) or " +
  "a root cause is confirmed. Do not write what git already records.";

/** Normalise a user-supplied scope: one line, no trailing period, bounded length. */
export function normaliseScope(raw: string | undefined): string {
  if (!raw) return "";
  let s = raw.replace(/\s+/g, " ").trim().replace(/\.+$/, "").trim();
  if (s.length > MAX_SCOPE_CHARS) s = s.slice(0, MAX_SCOPE_CHARS).replace(/\s+\S*$/, "");
  return s;
}

/**
 * Build the `instructions` text, or undefined so the caller omits the field:
 *   NOX_MEM_INSTRUCTIONS=off|0|false  -> undefined, even with a scope
 *   NOX_MEM_SCOPE set                 -> scoped text (the one that passed)
 *   NOX_MEM_INSTRUCTIONS=unscoped     -> unscoped text (searched on ~1 in 3 unrelated config changes)
 *   otherwise                         -> undefined
 */
export function serverInstructions(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const mode = (env.NOX_MEM_INSTRUCTIONS || "").trim().toLowerCase();
  if (mode === "off" || mode === "0" || mode === "false") return undefined;
  const scope = normaliseScope(env.NOX_MEM_SCOPE);
  if (scope) return [SCOPED_INTRO(scope), SCOPED_WHEN, HOW, WRITE].join("\n\n");
  if (mode === "unscoped") return [UNSCOPED_INTRO, UNSCOPED_WHEN, HOW, WRITE].join("\n\n");
  return undefined;
}
