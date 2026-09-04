import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { safeDetail } from "../cli.mjs"

const execFile = promisify(execFileCallback)
const CLI_PATH = fileURLToPath(new URL("../cli.mjs", import.meta.url))
const ROOT = path.resolve(path.dirname(CLI_PATH), "..", "..")

test("safeDetail reports a plain Error message", () => {
  assert.equal(
    safeDetail(new Error("GitHub draft creation did not return HTTP 201")),
    "GitHub draft creation did not return HTTP 201",
  )
})

test("safeDetail reports the message of a coded error without the code", () => {
  const error = Object.assign(new Error("Attestation bundle verification failed"), {
    code: "ATTESTATION_INVALID",
  })
  assert.equal(safeDetail(error), "Attestation bundle verification failed")
})

test("safeDetail joins up to three nested causes and ignores deeper ones", () => {
  const error = new Error("escrow failed", {
    cause: new Error("npm view failed", {
      cause: new Error("socket hang up", {
        cause: new Error("third cause", { cause: new Error("fourth cause is dropped") }),
      }),
    }),
  })
  assert.equal(
    safeDetail(error),
    "escrow failed <- npm view failed <- socket hang up <- third cause",
  )
})

test("safeDetail substitutes a placeholder for non-string and empty messages", () => {
  assert.equal(safeDetail(undefined), "(no message)")
  assert.equal(safeDetail(null), "(no message)")
  assert.equal(safeDetail("a thrown string"), "(no message)")
  assert.equal(safeDetail({ message: 42 }), "(no message)")
  assert.equal(safeDetail(new Error("")), "(no message)")
  assert.equal(
    safeDetail({ message: "outer", cause: { message: ["not", "a", "string"] } }),
    "outer <- (no message)",
  )
})

test("safeDetail strips newlines and control characters and collapses whitespace", () => {
  const error = new Error(
    "line one\r\nline two\ttabbed nul\u0000\u001b[31mansi\u0085nel\u2028ls   spaced ",
  )
  const detail = safeDetail(error)
  assert.equal(detail, "line one line two tabbed nul [31mansi nel ls spaced")
  for (const character of detail) {
    const codePoint = character.codePointAt(0)
    assert.ok(codePoint >= 0x20 && codePoint !== 0x7f && codePoint !== 0x85, `control ${codePoint}`)
  }
})

test("safeDetail truncates to 512 characters", () => {
  const detail = safeDetail(new Error("x".repeat(2000)))
  assert.equal(detail.length, 512)
  assert.equal(detail.at(-1), "…")
  assert.equal(safeDetail(new Error("y".repeat(512))).length, 512)
})

test("safeDetail never includes a stack trace", () => {
  const error = new Error("boom")
  assert.ok(typeof error.stack === "string" && error.stack.includes("cli-failure-detail.test.mjs"))
  assert.doesNotMatch(safeDetail(error), /cli-failure-detail\.test\.mjs|\bat\s/u)
})

test("safeDetail strips query strings from URLs", () => {
  const detail = safeDetail(
    new Error(
      "GET https://api.github.com/repos/o/r/releases?per_page=100&token=secretvalue failed; see https://example.test/path#frag?not-a-query",
    ),
  )
  assert.doesNotMatch(detail, /secretvalue|per_page/u)
  assert.ok(detail.includes("https://api.github.com/repos/o/r/releases failed"))
  assert.ok(detail.includes("https://example.test/path#frag?not-a-query"))
})

const CREDENTIAL_CASES = [
  ["ghp token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["gho token", "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"],
  ["ghu token", "ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"],
  ["ghs token", "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"],
  ["fine-grained PAT", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"],
  ["npm token", "npm_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["bearer scheme", "Bearer sk-live-topsecretvalue", "sk-live-topsecretvalue"],
  ["authorization header", "authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
  ["Authorization header, mixed case", "AUTHORIZATION:token123456", "token123456"],
  [
    "JWT",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ",
  ],
]

for (const [label, secret, mustBeAbsent = secret] of CREDENTIAL_CASES) {
  test(`safeDetail redacts a ${label}`, () => {
    const detail = safeDetail(new Error(`request failed with ${secret} in the header`))
    assert.ok(!detail.includes(mustBeAbsent), `${label} leaked: ${detail}`)
    assert.ok(detail.includes("[redacted]"), `${label} not marked redacted: ${detail}`)
    assert.ok(detail.startsWith("request failed with "))
  })
}

test("safeDetail redacts credentials inside nested causes", () => {
  const error = new Error("escrow failed", {
    cause: new Error("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected"),
  })
  const detail = safeDetail(error)
  assert.ok(!detail.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"))
  assert.equal(detail, "escrow failed <- token [redacted] rejected")
})

test("safeDetail redacts credentials that straddle a stripped newline", () => {
  const detail = safeDetail(new Error("Bearer\nghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected"))
  assert.ok(!detail.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"))
})

test("the CLI entrypoint prints the code line first and a sanitized detail line second", async () => {
  const token = "ghp_notarealtoken_000000000000000000000000"
  const result = await execFile(
    process.execPath,
    [CLI_PATH, "escrow", "--candidate", path.join(ROOT, "does-not-exist", "candidate.json")],
    { cwd: ROOT, env: { ...process.env, GITHUB_TOKEN: token }, encoding: "utf8" },
  ).then(
    () => assert.fail("the CLI must exit non-zero"),
    (error) => error,
  )
  assert.equal(result.code, 1)
  const lines = result.stderr.split("\n").filter((line) => line.length > 0)
  assert.equal(lines.length, 2, result.stderr)
  assert.match(lines[0], /^release CLI failed: [A-Z0-9_]{1,128}$/u)
  assert.match(lines[1], /^release CLI failure detail: \S.*$/u)
  assert.ok(lines[1].length <= "release CLI failure detail: ".length + 512)
  assert.ok(!result.stderr.includes(token))
  assert.ok(!result.stderr.includes("notarealtoken"))
  assert.doesNotMatch(result.stderr, /\n\s+at /u)
})
