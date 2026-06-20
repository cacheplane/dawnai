/**
 * Names of tools any built-in capability may contribute. Used by `dawn check`
 * to validate a route's tools scope against the universe of names it could
 * reference (route-local tools + these). Keep in sync with the built-in
 * capability markers under capabilities/built-in/.
 */
export const BUILT_IN_TOOL_NAMES: readonly string[] = [
  // workspace.ts — readFile, writeFile, listDir, runBash
  "readFile",
  "writeFile",
  "listDir",
  "runBash",
  // subagents.ts — task
  "task",
  // planning.ts — writeTodos
  "writeTodos",
  // skills.ts — readSkill
  "readSkill",
  // memory.ts — recall, remember
  "recall",
  "remember",
]
