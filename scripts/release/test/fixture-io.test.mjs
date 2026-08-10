import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, symlink, truncate, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { readBoundedFixture } from "../fixture-io.mjs"

test("bounded fixture reader accepts only regular no-follow files below its root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dawn-fixture-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "dawn-outside-"))
  t.after(async () => {
    const { rm } = await import("node:fs/promises")
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
  await writeFile(path.join(root, "ok.json"), "{}")
  await writeFile(path.join(outside, "secret.json"), '{"token":"secret"}')
  await symlink(path.join(outside, "secret.json"), path.join(root, "outside.json"))
  await symlink(path.join(root, "ok.json"), path.join(root, "inside.json"))
  await mkdir(path.join(root, "directory.json"))
  await writeFile(path.join(root, "huge.json"), "")
  await truncate(path.join(root, "huge.json"), 4 * 1024 * 1024 + 1)
  await symlink(outside, path.join(root, "linked-dir"))
  await promisify(execFile)("mkfifo", [path.join(root, "pipe.json")])

  assert.equal(await readBoundedFixture(path.join(root, "ok.json"), { root }), "{}")
  for (const target of [
    "outside.json",
    "inside.json",
    "directory.json",
    "huge.json",
    "linked-dir/secret.json",
    "pipe.json",
  ]) {
    await assert.rejects(readBoundedFixture(path.join(root, target), { root }), /fixture file/u)
  }
})
