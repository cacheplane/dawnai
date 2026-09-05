import path from "node:path"
import { parseRecovery, RECOVERY_LANES, snapshotRecoveryData } from "./schema.mjs"

export const RECOVERY_COMMANDS = Object.freeze([
  "inspect",
  "adopt",
  "smoke",
  "reconcile-verification",
  "dispatch-audit",
  "audit",
  "reconcile-audit",
  "finalize",
  "publish",
  "report",
])
const common = ["candidate", "expectedControllerSha", "intentPath"]
export function canonicalRequestBytes(value) {
  const stable = (v) =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, stable(v[k])]),
          )
        : v
  return Buffer.from(`${JSON.stringify(stable(snapshotRecoveryData(value, 16 * 1024 * 1024)))}\n`)
}
export function boundedRecoveryPath(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    Buffer.byteLength(value) > 4096 ||
    Array.from(value).some(
      (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
    )
  )
    throw new TypeError("Bounded absolute recovery path required")
  return value
}
export function parseRecoveryRequest(command, bytes) {
  if (!RECOVERY_COMMANDS.includes(command) || !Buffer.isBuffer(bytes) || bytes.length > 16384)
    throw new TypeError("Bounded recovery request required")
  const value = snapshotRecoveryData(JSON.parse(bytes.toString("utf8")), 16384)
  if (!canonicalRequestBytes(value).equals(bytes))
    throw new TypeError("Canonical recovery request required")
  let keys = common
  if (command === "inspect" && !Object.hasOwn(value, "intentPath")) keys = common.slice(0, 2)
  if (["dispatch-audit", "reconcile-audit", "audit"].includes(command))
    keys = [...common, "requestId"]
  if (command === "smoke") keys = [...common, "lane"]
  if (Object.keys(value).sort().join(" ") !== [...keys].sort().join(" "))
    throw new TypeError("Exact recovery request fields required")
  if (!/^[a-f0-9]{40}$/u.test(value.expectedControllerSha))
    throw new TypeError("Exact controller SHA required")
  if (
    keys.includes("intentPath") &&
    !/^scripts\/release\/recovery-adoptions\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(
      value.intentPath,
    )
  )
    throw new TypeError("Committed adoption intent path required")
  if (keys.includes("requestId") && !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value.requestId))
    throw new TypeError("Exact audit request ID required")
  if (keys.includes("lane") && !RECOVERY_LANES.includes(value.lane))
    throw new TypeError("Exact recovery lane required")
  parseRecovery({
    schemaVersion: 2,
    kind: "recovery-adoption-intent",
    candidate: value.candidate,
    policySha256: "0".repeat(64),
    legacyBodySha256: "0".repeat(64),
    legacyPhase: "NPM_COMPLETE",
    operations: ["adopt"],
  })
  return value
}
export function recoveryChildEnvironment(environment) {
  const result = {}
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "ImageOS", "ImageVersion"])
    if (
      typeof environment[key] === "string" &&
      environment[key].length <= 8192 &&
      !environment[key].includes("\0")
    )
      result[key] = environment[key]
  return result
}
