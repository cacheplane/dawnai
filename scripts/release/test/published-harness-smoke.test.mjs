import assert from "node:assert/strict"
import test from "node:test"

import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import {
  runPublishedHarnessSmoke,
  validateNpmAuditSignatures,
} from "../smoke/published-harness.mjs"
import { parseSmokeResult } from "../smoke-result.mjs"

const options = Object.freeze({
  version: "0.8.22",
  commitSha: "a".repeat(40),
  manifestSha256: "b".repeat(64),
  result: "/results/published-harness.json",
})

test("installs the exact public fixed group, verifies npm signatures, and runs clean harness lanes", async () => {
  const commands = []
  const lanes = []
  let cleaned = false
  let receipt
  await runPublishedHarnessSmoke(options, {
    env: { GITHUB_RUN_ID: "801", GITHUB_RUN_ATTEMPT: "1" },
    now: clock(),
    async makeTempDir() {
      return "/tmp/published-harness"
    },
    async removeDir() {
      cleaned = true
    },
    async runCommand(command, args, runOptions) {
      commands.push({ command, args, cwd: runOptions.cwd })
      if (args[0] === "audit") return { stdout: auditOutput(options.version), stderr: "" }
      return { stdout: "", stderr: "" }
    },
    async runHarnessAssertion(_root, lane, version) {
      lanes.push({ lane, version })
    },
    async runAgUiProbe() {
      lanes.push({ lane: "ag-ui", version: options.version })
    },
    async runTypeScriptProbe() {
      lanes.push({ lane: "typescript-tooling", version: options.version })
    },
    async runDockerProbe() {
      lanes.push({ lane: "docker-pid-recovery", version: options.version })
    },
    async writeFile(_path, bytes) {
      receipt = parseSmokeResult(bytes)
    },
    async mkdir() {},
  })

  const install = commands.find(({ command, args }) => command === "npm" && args[0] === "install")
  assert.deepEqual(
    install.args.filter((argument) => argument.includes("@0.8.22")).sort(),
    CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => `${name}@0.8.22`).sort(),
  )
  assert.equal(
    commands.some(
      ({ command, args }) =>
        command === "npm" && args.join(" ") === "audit signatures --json --include-attestations",
    ),
    true,
  )
  assert.equal(
    commands.some(({ args }) => /verdaccio|workspace:|file:|publish/u.test(args.join(" "))),
    false,
  )
  assert.deepEqual(lanes, [
    { lane: "ag-ui", version: "0.8.22" },
    { lane: "typescript-tooling", version: "0.8.22" },
    { lane: "docker-pid-recovery", version: "0.8.22" },
    { lane: "framework", version: "0.8.22" },
    { lane: "runtime", version: "0.8.22" },
    { lane: "smoke", version: "0.8.22" },
  ])
  assert.equal(cleaned, true)
  assert.equal(receipt.conclusion, "success")
  assert.equal(receipt.lane, "published-harness")
})

test("fails closed on malformed, missing, duplicate, or wrong-version npm audit evidence", () => {
  assert.throws(
    () =>
      validateNpmAuditSignatures("{}", {
        version: options.version,
        requiredPackages: ["@dawn-ai/sdk"],
      }),
    /malformed/i,
  )
  assert.throws(
    () =>
      validateNpmAuditSignatures(
        JSON.stringify({
          invalid: [],
          missing: [{ name: "@dawn-ai/sdk", version: options.version }],
          verified: [],
        }),
        { version: options.version, requiredPackages: ["@dawn-ai/sdk"] },
      ),
    /missing.*signature/i,
  )
  const duplicate = JSON.parse(auditOutput(options.version, ["@dawn-ai/sdk"]))
  duplicate.verified.push(duplicate.verified[0])
  assert.throws(
    () =>
      validateNpmAuditSignatures(JSON.stringify(duplicate), {
        version: options.version,
        requiredPackages: ["@dawn-ai/sdk"],
      }),
    /duplicate/i,
  )
  assert.throws(
    () =>
      validateNpmAuditSignatures(auditOutput("0.8.21", ["@dawn-ai/sdk"]), {
        version: options.version,
        requiredPackages: ["@dawn-ai/sdk"],
      }),
    /exact.*0\.8\.22/i,
  )
})

test("accepts the exact npm 11 production shape and rejects verified-entry shape drift", () => {
  const production = auditOutput(options.version, ["@dawn-ai/sdk"])
  assert.deepEqual(
    validateNpmAuditSignatures(production, {
      version: options.version,
      requiredPackages: ["@dawn-ai/sdk"],
    }),
    ["@dawn-ai/sdk"],
  )

  const unexpected = JSON.parse(production)
  unexpected.verified[0].summary = "caller-provided verification summary"
  assert.throws(
    () =>
      validateNpmAuditSignatures(JSON.stringify(unexpected), {
        version: options.version,
        requiredPackages: ["@dawn-ai/sdk"],
      }),
    /verified entry is malformed/i,
  )

  const missingLocation = JSON.parse(production)
  delete missingLocation.verified[0].location
  assert.throws(
    () =>
      validateNpmAuditSignatures(JSON.stringify(missingLocation), {
        version: options.version,
        requiredPackages: ["@dawn-ai/sdk"],
      }),
    /verified entry is malformed/i,
  )
})

test("writes a receipt and cleans when an installed-package harness assertion fails", async () => {
  const events = []
  let receipt
  await assert.rejects(
    runPublishedHarnessSmoke(options, {
      env: { GITHUB_RUN_ID: "802", GITHUB_RUN_ATTEMPT: "2" },
      now: clock(),
      async makeTempDir() {
        return "/tmp/published-harness-failure"
      },
      async removeDir() {
        events.push("cleanup")
      },
      async runCommand(_command, args) {
        return {
          stdout: args[0] === "audit" ? auditOutput(options.version) : "",
          stderr: "",
        }
      },
      async runHarnessAssertion(_root, lane) {
        if (lane === "runtime") throw new Error("runtime assertion failed")
      },
      async runAgUiProbe() {},
      async runTypeScriptProbe() {},
      async runDockerProbe() {},
      async writeFile(_path, bytes) {
        events.push("receipt")
        receipt = parseSmokeResult(bytes)
      },
      async mkdir() {},
    }),
    /runtime assertion failed/,
  )

  assert.deepEqual(events, ["cleanup", "receipt"])
  assert.equal(receipt.conclusion, "failure")
})

function auditOutput(version, packages = CANONICAL_RELEASE_PACKAGE_ORDER) {
  return JSON.stringify({
    invalid: [],
    missing: [],
    verified: packages.map((name) => ({
      name,
      version,
      location: `node_modules/${name}`,
      registry: "https://registry.npmjs.org/",
      attestations: {
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
      attestationBundles: [{ mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2" }],
    })),
  })
}

function clock() {
  const values = [new Date("2026-08-25T12:00:00.000Z"), new Date("2026-08-25T12:00:01.000Z")]
  return () => values.shift() ?? new Date("2026-08-25T12:00:01.000Z")
}
