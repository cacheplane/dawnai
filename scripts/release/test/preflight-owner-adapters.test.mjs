import assert from "node:assert/strict"
import test from "node:test"

import { createOwnerPreflightAdapters } from "../preflight-owner-adapters.mjs"

const REPOSITORY = "cacheplane/dawnai"
const SHA = "0123456789abcdef0123456789abcdef01234567"

test("owner adapters execute only exact argv-based read commands", async () => {
  const calls = []
  const adapters = createOwnerPreflightAdapters({
    cwd: "/workspace",
    environment: {
      HOME: "/home/runner",
      PATH: "/tools",
      GITHUB_TOKEN: "secret-token",
    },
    readFile: async (path) => Buffer.from(path),
    run: fixtureRunner(calls),
  })

  assert.equal(await adapters.git.headSha(), SHA)
  assert.equal(await adapters.npm.version(), "11.17.0")
  assert.deepEqual(await adapters.npm.trustList("@dawn-ai/sdk"), {
    status: "present",
    value: {
      id: "trust-1",
      type: "github",
      file: "release.yml",
      repository: REPOSITORY,
      permissions: ["createPackage"],
    },
  })
  assert.equal(await adapters.github.version(), "2.95.0")
  assert.equal((await adapters.github.getRepository(REPOSITORY)).httpStatus, 200)
  assert.equal((await adapters.github.getWorkflow(".github/workflows/release.yml")).httpStatus, 200)
  assert.equal((await adapters.github.getEnvironment("release-abandonment")).httpStatus, 200)
  assert.deepEqual(await adapters.github.getImmutableReleases(REPOSITORY), {
    status: "absent",
    httpStatus: 404,
    value: null,
  })
  assert.equal(
    await adapters.files.read("scripts/release/controller-schema.json"),
    "scripts/release/controller-schema.json",
  )

  assert.deepEqual(
    calls.map(([command, args]) => [command, args]),
    [
      ["git", ["rev-parse", "--verify", "HEAD^{commit}"]],
      ["npm", ["--version"]],
      ["npm", ["trust", "list", "@dawn-ai/sdk", "--json"]],
      ["gh", ["--version"]],
      ["gh", apiArgs("repos/cacheplane/dawnai")],
      ["gh", apiArgs("repos/cacheplane/dawnai/actions/workflows/release.yml")],
      ["gh", apiArgs("repos/cacheplane/dawnai/environments/release-abandonment")],
      ["gh", apiArgs("repos/cacheplane/dawnai/immutable-releases")],
    ],
  )
  for (const [command, , options] of calls) {
    assert.equal(options.cwd, "/workspace")
    assert.equal(options.shell, undefined)
    if (command === "gh") {
      assert.equal(options.env.GH_TOKEN, "secret-token")
      assert.equal(options.env.GITHUB_TOKEN, undefined)
    }
  }
  assert.equal(JSON.stringify(calls).includes("secret-token"), true)
})

test("owner adapters normalize npm auth and GitHub auth/absence without leaking messages", async () => {
  const adapters = createOwnerPreflightAdapters({
    cwd: "/workspace",
    environment: { HOME: "/home/runner", PATH: "/tools" },
    readFile: async () => "fixture",
    run: async (command, args) => {
      if (command === "npm" && args[0] === "trust") {
        return {
          exitCode: 1,
          stdout: '{"error":{"code":"E401","summary":"token=secret"}}\n',
          stderr: "npm auth token=secret",
        }
      }
      if (command === "gh") {
        return {
          exitCode: 1,
          stdout: httpResponse(403, { message: "credential secret" }),
          stderr: "gh: credential secret (HTTP 403)",
        }
      }
      throw new Error("unexpected command")
    },
  })

  assert.deepEqual(await adapters.npm.trustList("@dawn-ai/sdk"), {
    status: "unavailable",
    code: "E401",
  })
  assert.deepEqual(await adapters.github.getRepository(REPOSITORY), {
    status: "unavailable",
    httpStatus: 403,
    value: null,
  })
  assert.equal(
    JSON.stringify(await adapters.github.getRepository(REPOSITORY)).includes("secret"),
    false,
  )
})

test("owner adapters reject malformed successful tool output", async () => {
  const adapters = createOwnerPreflightAdapters({
    cwd: "/workspace",
    environment: { HOME: "/home/runner", PATH: "/tools" },
    readFile: async () => "fixture",
    run: async (command, args) => {
      if (command === "npm" && args[0] === "trust") {
        return { exitCode: 0, stdout: "not-json", stderr: "" }
      }
      return { exitCode: 0, stdout: "not-an-http-response", stderr: "" }
    },
  })
  await assert.rejects(adapters.npm.trustList("@dawn-ai/sdk"), /npm trust|JSON/iu)
  await assert.rejects(adapters.github.getRepository(REPOSITORY), /GitHub|HTTP/iu)
})

function fixtureRunner(calls) {
  return async (command, args, options) => {
    calls.push([command, args, options])
    if (command === "git") return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" }
    if (command === "npm" && args[0] === "--version") {
      return { exitCode: 0, stdout: "11.17.0\n", stderr: "" }
    }
    if (command === "npm") {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          id: "trust-1",
          type: "github",
          file: "release.yml",
          repository: REPOSITORY,
          permissions: ["createPackage"],
        })}\n`,
        stderr: "",
      }
    }
    if (args[0] === "--version") {
      return { exitCode: 0, stdout: "gh version 2.95.0 (2026-06-17)\n", stderr: "" }
    }
    const endpoint = args.at(-1)
    if (endpoint.endsWith("immutable-releases")) {
      return { exitCode: 1, stdout: httpResponse(404, { message: "Not Found" }), stderr: "" }
    }
    if (endpoint.includes("actions/workflows")) {
      return {
        exitCode: 0,
        stdout: httpResponse(200, {
          id: 1,
          path: ".github/workflows/release.yml",
          state: "disabled_manually",
        }),
        stderr: "",
      }
    }
    if (endpoint.includes("environments")) {
      return {
        exitCode: 0,
        stdout: httpResponse(200, { name: "release-abandonment", protection_rules: [] }),
        stderr: "",
      }
    }
    return {
      exitCode: 0,
      stdout: httpResponse(200, {
        id: 123,
        full_name: REPOSITORY,
        default_branch: "main",
        permissions: { admin: true },
      }),
      stderr: "",
    }
  }
}

function apiArgs(endpoint) {
  return [
    "api",
    "--include",
    "--method",
    "GET",
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    "X-GitHub-Api-Version: 2026-03-10",
    endpoint,
  ]
}

function httpResponse(status, body) {
  return `HTTP/2.0 ${status} status\ncontent-type: application/json\n\n${JSON.stringify(body)}\n`
}
