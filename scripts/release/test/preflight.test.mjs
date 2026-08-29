import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const PREFLIGHT_MODULE_URL = new URL("../preflight.mjs", import.meta.url).href
const PREFLIGHT_ENTRYPOINT = fileURLToPath(PREFLIGHT_MODULE_URL)
const SPAWN_ENVIRONMENT_KEYS = new Set(["SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "WINDIR"])
const SPAWN_ENVIRONMENT = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => typeof value === "string" && SPAWN_ENVIRONMENT_KEYS.has(key.toUpperCase()),
  ),
)
const IMPORT_SOURCE = [
  `const preflight = await import(${JSON.stringify(PREFLIGHT_MODULE_URL)})`,
  `process.stdout.write(JSON.stringify(Object.keys(preflight)) + ${JSON.stringify("\n")})`,
].join("\n")

test("preflight rejects legacy flag-only input through the owner parser", () => {
  const result = spawnSync(process.execPath, [PREFLIGHT_ENTRYPOINT, "--repository", "invalid"], {
    cwd: ROOT,
    encoding: "utf8",
    env: SPAWN_ENVIRONMENT,
  })

  assert.equal(result.status, 2)
  assert.equal(result.signal, null)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "Invalid owner preflight input.\n")
})

test("preflight routes symlinked direct invocations through the owner parser", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "dawn-preflight-entrypoint-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const linkedReleaseDirectory = path.join(fixture, "release")
  await symlink(
    path.dirname(PREFLIGHT_ENTRYPOINT),
    linkedReleaseDirectory,
    process.platform === "win32" ? "junction" : "dir",
  )

  const linkedEntrypoint = path.join(linkedReleaseDirectory, "preflight.mjs")
  for (const [name, nodeArguments] of [
    ["canonical main symlink", []],
    ["preserved main symlink", ["--preserve-symlinks-main"]],
  ]) {
    const result = spawnSync(
      process.execPath,
      [...nodeArguments, linkedEntrypoint, "--repository", "invalid"],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: SPAWN_ENVIRONMENT,
      },
    )

    assert.equal(result.status, 2, name)
    assert.equal(result.signal, null, name)
    assert.equal(result.stdout, "", name)
    assert.equal(result.stderr, "Invalid owner preflight input.\n", name)
  }
})

test("preflight stdin import executes the wrapper with an empty namespace", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: ROOT,
    encoding: "utf8",
    env: SPAWN_ENVIRONMENT,
    input: IMPORT_SOURCE,
  })

  assertImportedWrapperFailure(result)
})

test("preflight eval import executes the wrapper with harmless argv", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", IMPORT_SOURCE, "harmless"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: SPAWN_ENVIRONMENT,
    },
  )

  assertImportedWrapperFailure(result)
})

test("preflight eval import executes the wrapper with entrypoint-shaped argv", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", IMPORT_SOURCE, PREFLIGHT_ENTRYPOINT],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: SPAWN_ENVIRONMENT,
    },
  )

  assertImportedWrapperFailure(result)
})

function assertImportedWrapperFailure(result) {
  assert.equal(result.status, 2)
  assert.equal(result.signal, null)
  assert.equal(result.stdout, "[]\n")
  assert.equal(result.stderr, "Invalid owner preflight input.\n")
}
