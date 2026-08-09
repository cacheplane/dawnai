import { execFile } from "node:child_process"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

const COMMAND_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const IDENTITY = Object.freeze({ name: "Release Fault Fixture", email: "fault@example.invalid" })
const FIRST_DATE = "2024-01-01T00:00:00Z"
const SECOND_DATE = "2024-01-02T00:00:00Z"
const INHERITED_GIT_CONTROLS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_AUTHOR_DATE",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMITTER_DATE",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]

export async function createGitFixture({ sourceDirectory }) {
  if (typeof sourceDirectory !== "string" || !isAbsolute(sourceDirectory)) {
    throw new TypeError("Git fixture source must be an absolute path")
  }
  await readFile(join(sourceDirectory, "package.json"))
  const directory = await mkdtemp(join(tmpdir(), "dawn-release-git-"))
  const workingDirectory = join(directory, "working")
  const bareRemoteDirectory = join(directory, "remote.git")
  try {
    await cp(sourceDirectory, workingDirectory, { recursive: true, errorOnExist: true })
    await git(directory, ["init", "--bare", bareRemoteDirectory])
    await git(workingDirectory, ["init", "-b", "main"])
    await git(workingDirectory, ["config", "--local", "user.name", IDENTITY.name])
    await git(workingDirectory, ["config", "--local", "user.email", IDENTITY.email])
    await git(workingDirectory, ["add", "--all"])
    await git(workingDirectory, ["commit", "-m", "fixture base"], FIRST_DATE)
    const oldCommitSha = await revParse(workingDirectory, "HEAD")
    await git(
      workingDirectory,
      ["tag", "-a", "v1.2.3", "-m", "fixture release 1.2.3", oldCommitSha],
      FIRST_DATE,
    )
    await writeFile(join(workingDirectory, "REVISION"), "main advanced\n", "utf8")
    await git(workingDirectory, ["add", "REVISION"])
    await git(workingDirectory, ["commit", "-m", "advance main"], SECOND_DATE)
    const mainCommitSha = await revParse(workingDirectory, "HEAD")
    await git(workingDirectory, ["remote", "add", "origin", bareRemoteDirectory])
    await git(workingDirectory, ["push", "--set-upstream", "origin", "main"])
    await git(workingDirectory, ["push", "origin", "refs/tags/v1.2.3"])
    let closed = false
    return Object.freeze({
      directory,
      workingDirectory,
      bareRemoteDirectory,
      oldCommitSha,
      mainCommitSha,
      async close() {
        if (closed) return
        closed = true
        await rm(directory, { recursive: true, force: true })
      },
    })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function revParse(directory, ref) {
  return (await git(directory, ["rev-parse", "--verify", ref])).trim()
}

function git(directory, args, date) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: directory,
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
        windowsHide: true,
        env: gitEnvironment(date),
      },
      (error, stdout) => {
        if (error !== null) {
          reject(
            Object.assign(new Error("Temporary Git fixture command failed"), {
              code: "GIT_FIXTURE_FAILED",
            }),
          )
          return
        }
        resolve(stdout)
      },
    )
  })
}

function gitEnvironment(date) {
  const environment = { ...process.env }
  for (const name of INHERITED_GIT_CONTROLS) delete environment[name]
  environment.GIT_CONFIG_GLOBAL = "/dev/null"
  environment.GIT_CONFIG_NOSYSTEM = "1"
  environment.GIT_CONFIG_COUNT = "0"
  if (date !== undefined) {
    environment.GIT_AUTHOR_DATE = date
    environment.GIT_COMMITTER_DATE = date
  }
  return environment
}
