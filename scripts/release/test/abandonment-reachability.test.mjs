import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { parse, stringify } from "yaml"

import * as classifierExports from "../abandonment-reachability.mjs"
import {
  aggregateReleaseWorkflowAbandonment,
  classifyReleaseWorkflowAbandonment,
} from "../abandonment-reachability.mjs"
import {
  loadAbandonmentWorkflowPolicy,
  parseAbandonmentWorkflowPolicy,
  parseCanonicalReleaseWorkflow,
  parseReleaseWorkflow,
  validateAbandonmentWorkflowPolicy,
} from "../abandonment-workflow-policy.mjs"

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const FIXTURE_ROOT = ROOT + "/scripts/release/test/fixtures"
const ABANDONMENT_ENVIRONMENT = "release-abandonment"
const OPTIONS = Object.freeze({ abandonmentEnvironment: ABANDONMENT_ENVIRONMENT })
const LIVE_BYTES = await readFile(ROOT + "/.github/workflows/release.yml")
const PROTECTED_BYTES = await readFile(FIXTURE_ROOT + "/release-workflow-protected.yml")
const DISABLED_BYTES = await readFile(FIXTURE_ROOT + "/release-workflow-disabled.yml")
const POLICY_BYTES = await readFile(ROOT + "/scripts/release/abandonment-workflow-policy.json")
const POLICY_SOURCE = JSON.parse(POLICY_BYTES.toString("utf8"))

test("the classifier exports exactly the approved public API", () => {
  assert.deepEqual(Object.keys(classifierExports).sort(), [
    "aggregateReleaseWorkflowAbandonment",
    "classifyReleaseWorkflowAbandonment",
  ])
})

test("the live workflow is the immutable protected fixture and both reviewed modes classify", () => {
  assert.deepEqual(LIVE_BYTES, PROTECTED_BYTES)
  assert.equal(classifyReleaseWorkflowAbandonment(LIVE_BYTES, OPTIONS), "protected")
  assert.equal(classifyReleaseWorkflowAbandonment(PROTECTED_BYTES, OPTIONS), "protected")
  assert.equal(classifyReleaseWorkflowAbandonment(DISABLED_BYTES, OPTIONS), "disabled")
  assert.equal(
    classifyReleaseWorkflowAbandonment(new Uint8Array(PROTECTED_BYTES), OPTIONS),
    "protected",
  )
})

test("policy entries are bound to production-canonicalized immutable fixtures", () => {
  const loaded = loadAbandonmentWorkflowPolicy()
  assert.deepEqual(loaded, POLICY_SOURCE)
  const expected = [
    ["disabled-2026-08-28", "disabled", DISABLED_BYTES],
    ["protected-2026-08-28", "protected", PROTECTED_BYTES],
  ]
  assert.equal(loaded.variants.length, expected.length)
  for (const [index, [id, mode, bytes]] of expected.entries()) {
    const canonical = parseCanonicalReleaseWorkflow(bytes)
    assert.equal(loaded.variants[index].id, id)
    assert.equal(loaded.variants[index].mode, mode)
    assert.equal(loaded.variants[index].canonicalSha256, canonical.canonicalSha256)
    assert.match(canonical.canonicalSha256, /^[0-9a-f]{64}$/u)
  }
})

test("the disabled fixture contains exactly the approved Task 6 removals", () => {
  assert.deepEqual(deriveDisabledFixture(PROTECTED_BYTES), DISABLED_BYTES)
  const protectedWorkflow = parseFixture(PROTECTED_BYTES)
  const disabledWorkflow = parseFixture(DISABLED_BYTES)
  assert.deepEqual(Object.keys(disabledWorkflow.on.workflow_dispatch.inputs), [
    "version",
    "commitSha",
    "operation",
  ])
  assert.deepEqual(disabledWorkflow.on.workflow_dispatch.inputs.operation.options, ["reconcile"])
  assert.equal(disabledWorkflow.on.workflow_dispatch.inputs.reason, undefined)
  assert.equal(disabledWorkflow.jobs.abandon, undefined)
  assert.equal(findStep(disabledWorkflow.jobs.tag, "Validate manual intent"), undefined)
  assert.equal(routeStep(disabledWorkflow).env.OPERATION, undefined)
  assert.equal(routeStep(disabledWorkflow).run.includes('"$OPERATION" == "abandon"'), false)
  assert.ok(protectedWorkflow.jobs.abandon)
})

test("every partial or mixed abandonment topology fails closed", () => {
  const protectedCases = [
    ["missing reason", (workflow) => delete workflow.on.workflow_dispatch.inputs.reason],
    [
      "missing abandon option",
      (workflow) => workflow.on.workflow_dispatch.inputs.operation.options.pop(),
    ],
    ["missing intent", (workflow) => removeStep(workflow.jobs.tag, "Validate manual intent")],
    [
      "missing tag operation",
      (workflow) => {
        delete routeStep(workflow).env.OPERATION
      },
    ],
    [
      "missing abandon-only branch",
      (workflow) => {
        routeStep(workflow).run = removeAbandonBranch(routeStep(workflow).run)
      },
    ],
    ["missing abandon job", (workflow) => delete workflow.jobs.abandon],
    [
      "missing context executable",
      (workflow) => removeStep(workflow.jobs.abandon, "Derive fresh protected abandonment context"),
    ],
    [
      "missing abandon executable",
      (workflow) =>
        removeStep(workflow.jobs.abandon, "Permanently abandon pre-publication candidate"),
    ],
  ]
  for (const [name, mutate] of protectedCases) {
    assert.throws(
      () => classifyReleaseWorkflowAbandonment(mutateWorkflow(PROTECTED_BYTES, mutate), OPTIONS),
      /topology/u,
      name,
    )
  }

  const protectedWorkflow = parseFixture(PROTECTED_BYTES)
  const disabledCases = [
    [
      "reason restored",
      (workflow) => {
        workflow.on.workflow_dispatch.inputs.reason = structuredClone(
          protectedWorkflow.on.workflow_dispatch.inputs.reason,
        )
      },
    ],
    [
      "abandon option restored",
      (workflow) => workflow.on.workflow_dispatch.inputs.operation.options.push("abandon"),
    ],
    [
      "intent restored",
      (workflow) => {
        workflow.jobs.tag.steps.splice(
          2,
          0,
          structuredClone(requiredStep(protectedWorkflow.jobs.tag, "Validate manual intent")),
        )
      },
    ],
    [
      "protected route restored",
      (workflow) => {
        workflow.jobs.tag.steps[4] = structuredClone(routeStep(protectedWorkflow))
      },
    ],
    [
      "abandon job restored",
      (workflow) => {
        workflow.jobs.abandon = structuredClone(protectedWorkflow.jobs.abandon)
      },
    ],
  ]
  for (const [name, mutate] of disabledCases) {
    assert.throws(
      () => classifyReleaseWorkflowAbandonment(mutateWorkflow(DISABLED_BYTES, mutate), OPTIONS),
      /topology/u,
      name,
    )
  }
})

test("input and operation projections are exact", () => {
  const cases = [
    ["missing version", (workflow) => delete workflow.on.workflow_dispatch.inputs.version],
    [
      "renamed commit",
      (workflow) => {
        const inputs = workflow.on.workflow_dispatch.inputs
        inputs.commit_sha = inputs.commitSha
        delete inputs.commitSha
      },
    ],
    [
      "extra input",
      (workflow) => {
        workflow.on.workflow_dispatch.inputs.approval = { required: false, type: "string" }
      },
    ],
    [
      "wrong identity descriptor",
      (workflow) => {
        workflow.on.workflow_dispatch.inputs.version.required = false
      },
    ],
    [
      "missing operation option",
      (workflow) => {
        workflow.on.workflow_dispatch.inputs.operation.options = []
      },
    ],
    [
      "wrong operation option",
      (workflow) => {
        workflow.on.workflow_dispatch.inputs.operation.options = ["abandon"]
      },
    ],
    [
      "extra operation option",
      (workflow) => workflow.on.workflow_dispatch.inputs.operation.options.push("force"),
    ],
    [
      "reordered protected options",
      (workflow) => workflow.on.workflow_dispatch.inputs.operation.options.reverse(),
    ],
    [
      "extra descriptor member",
      (workflow) => {
        workflow.on.workflow_dispatch.inputs.operation.deprecationMessage = "unexpected"
      },
    ],
  ]
  for (const [name, mutate] of cases) {
    assert.throws(
      () => classifyReleaseWorkflowAbandonment(mutateWorkflow(PROTECTED_BYTES, mutate), OPTIONS),
      /topology/u,
      name,
    )
  }
})

test("the protected job, gates, permissions, intent, route, and executables are exact", () => {
  const cases = [
    ["missing environment", (workflow) => delete workflow.jobs.abandon.environment],
    ["wrong environment", (workflow) => (workflow.jobs.abandon.environment = "production")],
    [
      "extra environment structure",
      (workflow) =>
        (workflow.jobs.abandon.environment = {
          name: ABANDONMENT_ENVIRONMENT,
          url: "https://example.invalid",
        }),
    ],
    ["missing permissions", (workflow) => delete workflow.jobs.abandon.permissions],
    [
      "wrong permission",
      (workflow) => {
        workflow.jobs.abandon.permissions.contents = "read"
      },
    ],
    [
      "extra permission",
      (workflow) => {
        workflow.jobs.abandon.permissions.issues = "write"
      },
    ],
    [
      "missing identity gate",
      (workflow) => {
        workflow.jobs.abandon.if = workflow.jobs.abandon.if.replace(
          "github.sha == needs.detect.outputs.candidate_sha &&",
          "",
        )
      },
    ],
    [
      "wrong state gate",
      (workflow) => {
        workflow.jobs.abandon.if = workflow.jobs.abandon.if.replace(
          "CANDIDATE_ESCROWED",
          "NPM_STARTED",
        )
      },
    ],
    [
      "extra gate",
      (workflow) => {
        workflow.jobs.abandon.if += " && github.actor == 'owner'"
      },
    ],
    [
      "intent validation",
      (workflow) => {
        requiredStep(workflow.jobs.tag, "Validate manual intent").run += "true\n"
      },
    ],
    [
      "tag branch",
      (workflow) => {
        routeStep(workflow).run = routeStep(workflow).run.replace("exit 2", "exit 1")
      },
    ],
    [
      "checkout descriptor",
      (workflow) => {
        workflow.jobs.abandon.steps[0].with["persist-credentials"] = true
      },
    ],
    [
      "setup descriptor",
      (workflow) => {
        workflow.jobs.abandon.steps[1].with["node-version"] = "24"
      },
    ],
    [
      "context descriptor",
      (workflow) => {
        requiredStep(workflow.jobs.abandon, "Derive fresh protected abandonment context").run =
          "node scripts/release/cli.mjs abandonment-context"
      },
    ],
    [
      "abandon descriptor",
      (workflow) => {
        requiredStep(workflow.jobs.abandon, "Permanently abandon pre-publication candidate").run =
          "node scripts/release/cli.mjs abandon"
      },
    ],
    [
      "extra protected member",
      (workflow) => {
        workflow.jobs.abandon["continue-on-error"] = false
      },
    ],
  ]
  for (const [name, mutate] of cases) {
    assert.throws(
      () => classifyReleaseWorkflowAbandonment(mutateWorkflow(PROTECTED_BYTES, mutate), OPTIONS),
      /topology/u,
      name,
    )
  }
})

test("unknown shell constructions fail by complete-workflow policy, not interpretation", () => {
  const commands = [
    "node scripts/release/cli.mjs abandon",
    "node scripts/release/cli.mjs aban''don",
    "node scripts/release/cli.mjs aban\\don",
    "node scripts/release/cli'.'mjs abandon",
    "node scripts/release/cli\\.mjs abandon",
    'CLI=scripts/release/cli.mjs; node "$CLI" abandon',
    'BASE=scripts/release; node "$BASE/cli.mjs" abandon',
    'node "$PWD/scripts/release/cli.mjs" abandon',
    'result="$(node scripts/release/cli.mjs abandon)"',
    "bash -lc 'node scripts/release/cli.mjs abandon'",
    "bash --noprofile -c 'node scripts/release/cli.mjs abandon'",
    "bash -c -- 'node scripts/release/cli.mjs abandon'",
    "eval 'node scripts/release/cli.mjs abandon'",
    [
      "printf '%s\\n' 'node scripts/release/cli.mjs abandon' > \"$RUNNER_TEMP/generated.sh\"",
      'source "$RUNNER_TEMP/generated.sh"',
    ].join("\n"),
    [
      "cat > \"$RUNNER_TEMP/generated.sh\" <<'SCRIPT'",
      "node scripts/release/cli.mjs abandon",
      "SCRIPT",
      'bash "$RUNNER_TEMP/generated.sh"',
    ].join("\n"),
    "printf bm9kZSBzY3JpcHRzL3JlbGVhc2UvY2xpLm1qcyBhYmFuZG9uCg== | base64 -d | bash",
    'node -e \'require("node:child_process").execFileSync("node", ["scripts/release/cli.mjs", "abandon"])\'',
    'python -c \'import subprocess; subprocess.run(["node","scripts/release/cli.mjs","abandon"])\'',
    [
      "printf '%s\\n' 'node scripts/release/cli.mjs abandon' > \"$RUNNER_TEMP/bash-env\"",
      'BASH_ENV="$RUNNER_TEMP/bash-env" bash -c true',
    ].join("\n"),
  ]
  for (const [index, run] of commands.entries()) {
    assert.throws(
      () =>
        classifyReleaseWorkflowAbandonment(
          mutateWorkflow(DISABLED_BYTES, (workflow) => {
            workflow.jobs.detect.steps.push({ name: "Unknown shell " + index, run })
          }),
          OPTIONS,
        ),
      /not a reviewed variant/u,
      run,
    )
  }
})

test("every execution-affecting workflow surface is bound by the full digest", () => {
  const cases = [
    [
      "run",
      (workflow) => {
        workflow.jobs.detect.steps[2].run += "\ntrue"
      },
    ],
    [
      "uses",
      (workflow) => {
        workflow.jobs.detect.steps[0].uses =
          "actions/checkout@0000000000000000000000000000000000000000"
      },
    ],
    [
      "reusable workflow",
      (workflow) => {
        workflow.jobs.reusable = {
          uses: "cacheplane/dawnai/.github/workflows/ci.yml@main",
        }
      },
    ],
    [
      "with",
      (workflow) => {
        workflow.jobs.detect.steps[0].with.clean = false
      },
    ],
    [
      "environment variables",
      (workflow) => {
        workflow.env = { NODE_OPTIONS: "--require ./bootstrap.cjs" }
      },
    ],
    [
      "condition",
      (workflow) => {
        workflow.jobs.detect.if = "always()"
      },
    ],
    [
      "shell",
      (workflow) => {
        workflow.jobs.detect.steps[2].shell = "python"
      },
    ],
    [
      "working directory",
      (workflow) => {
        workflow.jobs.detect.steps[2]["working-directory"] = "/tmp"
      },
    ],
    [
      "workflow defaults",
      (workflow) => {
        workflow.defaults = { run: { shell: "bash -e {0}" } }
      },
    ],
    [
      "job defaults",
      (workflow) => {
        workflow.jobs.detect.defaults = { run: { "working-directory": "scripts" } }
      },
    ],
    [
      "container",
      (workflow) => {
        workflow.jobs.detect.container = "node:24"
      },
    ],
    [
      "service",
      (workflow) => {
        workflow.jobs.detect.services = { helper: { image: "node:24" } }
      },
    ],
    [
      "permissions",
      (workflow) => {
        workflow.permissions.actions = "write"
      },
    ],
    [
      "gate",
      (workflow) => {
        workflow.jobs.prepare.if += " && github.actor == 'owner'"
      },
    ],
    [
      "trigger",
      (workflow) => {
        workflow.on.pull_request = {}
      },
    ],
  ]
  for (const [name, mutate] of cases) {
    assert.throws(
      () => classifyReleaseWorkflowAbandonment(mutateWorkflow(DISABLED_BYTES, mutate), OPTIONS),
      /not a reviewed variant/u,
      name,
    )
  }
})

test("mapping order, comments, and equivalent scalar spelling canonicalize equally", () => {
  const original = parseCanonicalReleaseWorkflow(PROTECTED_BYTES)
  const reversed = reverseMappings(parseFixture(PROTECTED_BYTES))
  let alternative = stringify(reversed, { lineWidth: 0 })
  alternative = ("# non-executing review note\n" + alternative).replace(
    "name: Release",
    'name: "Release"',
  )
  const alternativeBytes = Buffer.from(alternative)
  const canonical = parseCanonicalReleaseWorkflow(alternativeBytes)
  assert.notDeepEqual(alternativeBytes, PROTECTED_BYTES)
  assert.equal(canonical.canonicalJson, original.canonicalJson)
  assert.equal(canonical.canonicalSha256, original.canonicalSha256)
  assert.equal(classifyReleaseWorkflowAbandonment(alternativeBytes, OPTIONS), "protected")
})

test("array order and decoded run whitespace remain policy-sensitive", () => {
  const original = parseCanonicalReleaseWorkflow(DISABLED_BYTES)
  const reordered = mutateWorkflow(DISABLED_BYTES, (workflow) => {
    ;[workflow.jobs.detect.steps[0], workflow.jobs.detect.steps[1]] = [
      workflow.jobs.detect.steps[1],
      workflow.jobs.detect.steps[0],
    ]
  })
  const whitespace = mutateWorkflow(DISABLED_BYTES, (workflow) => {
    workflow.jobs.detect.steps[2].run += " "
  })
  for (const bytes of [reordered, whitespace]) {
    assert.notEqual(parseCanonicalReleaseWorkflow(bytes).canonicalSha256, original.canonicalSha256)
    assert.throws(
      () => classifyReleaseWorkflowAbandonment(bytes, OPTIONS),
      /not a reviewed variant/u,
    )
  }
})

test("malformed and ambiguous workflow bytes fail closed", () => {
  const source = PROTECTED_BYTES.toString("utf8")
  const cases = [
    ["empty", Buffer.alloc(0)],
    ["malformed", Buffer.from("jobs: [\n")],
    ["null", Buffer.from("null\n")],
    ["scalar", Buffer.from("Release\n")],
    ["array", Buffer.from("- Release\n")],
    ["placeholder", Buffer.from("name: Release\non: {}\njobs: {}\n")],
    ["duplicate key", Buffer.from(source + "name: Duplicate\n")],
    ["anchor", Buffer.from(source.replace("name: Release", "name: &release-name Release"))],
    [
      "alias",
      Buffer.from(
        source.replace("name: Release", "name: &release-name Release\ncopied-name: *release-name"),
      ),
    ],
    ["explicit tag", Buffer.from(source.replace("name: Release", "name: !!str Release"))],
    ["custom tag", Buffer.from(source.replace("name: Release", "name: !reviewed Release"))],
    ["unused tag directive", Buffer.from("%TAG !e! tag:example.com,2020:\n---\n" + source)],
    ["YAML directive", Buffer.from("%YAML 1.2\n---\n" + source)],
    ["explicit document marker", Buffer.from("---\n" + source)],
    ["multiple documents", Buffer.from(source + "---\nname: Other\n")],
    ["invalid UTF-8", Buffer.from([0xff])],
  ]
  for (const [name, bytes] of cases) {
    assert.throws(
      () => classifyReleaseWorkflowAbandonment(bytes, OPTIONS),
      /workflow|topology/u,
      name,
    )
  }
})

test("workflow parsing rejects complex mapping keys before JSON conversion", () => {
  const bytes = Buffer.from("? [release, policy]\n: ignored\nname: Release\n")
  assert.throws(() => parseReleaseWorkflow(bytes), /workflow/u)
})

test("policy validation rejects malformed, unordered, duplicate, cross-mode, and unknown entries", () => {
  const cases = [
    ["root field", (policy) => (policy.extra = true)],
    ["schema version", (policy) => (policy.schemaVersion = 2)],
    ["canonicalization", (policy) => (policy.canonicalization = "unknown")],
    ["missing variants", (policy) => delete policy.variants],
    ["non-array variants", (policy) => (policy.variants = {})],
    ["missing variant", (policy) => policy.variants.pop()],
    ["extra variant", (policy) => policy.variants.push(structuredClone(policy.variants[1]))],
    ["unordered variants", (policy) => policy.variants.reverse()],
    ["duplicate id", (policy) => (policy.variants[1].id = policy.variants[0].id)],
    [
      "cross-mode digest",
      (policy) => (policy.variants[1].canonicalSha256 = policy.variants[0].canonicalSha256),
    ],
    ["unknown id", (policy) => (policy.variants[0].id = "disabled-future")],
    ["unknown mode", (policy) => (policy.variants[0].mode = "unavailable")],
    ["crossed mode", (policy) => (policy.variants[0].mode = "protected")],
    ["uppercase digest", (policy) => (policy.variants[0].canonicalSha256 = "A".repeat(64))],
    [
      "non-string digest",
      (policy) => (policy.variants[0].canonicalSha256 = [policy.variants[0].canonicalSha256]),
    ],
    ["short digest", (policy) => (policy.variants[0].canonicalSha256 = "a".repeat(63))],
    ["variant field", (policy) => (policy.variants[0].extra = true)],
  ]
  for (const [name, mutate] of cases) {
    const policy = structuredClone(POLICY_SOURCE)
    mutate(policy)
    assert.throws(() => validateAbandonmentWorkflowPolicy(policy), /policy/u, name)
  }
})

test("policy validation snapshots data without invoking accessors", () => {
  const input = structuredClone(POLICY_SOURCE)
  const snapshot = validateAbandonmentWorkflowPolicy(input)
  input.variants[0].mode = "protected"
  assert.equal(snapshot.variants[0].mode, "disabled")
  assert.ok(Object.isFrozen(snapshot))
  assert.ok(Object.isFrozen(snapshot.variants))
  assert.ok(Object.isFrozen(snapshot.variants[0]))

  let accessed = false
  const accessor = {}
  Object.defineProperty(accessor, "schemaVersion", {
    enumerable: true,
    get() {
      accessed = true
      return 1
    },
  })
  assert.throws(() => validateAbandonmentWorkflowPolicy(accessor), /policy/u)
  assert.equal(accessed, false)
})

test("policy byte parsing is JSON-only and rejects duplicate keys before validation", () => {
  assert.deepEqual(parseAbandonmentWorkflowPolicy(POLICY_BYTES), POLICY_SOURCE)
  const source = POLICY_BYTES.toString("utf8")
  const cases = [
    source.replace('  "schemaVersion": 1,', '  "schemaVersion": 1,\n  "schemaVersion": 1,'),
    source.replace(
      '      "mode": "disabled",',
      '      "mode": "disabled",\n      "mode": "disabled",',
    ),
    stringify(POLICY_SOURCE),
    source.replace("{", "{\n  // comment"),
    source.replace("\n}", ",\n}"),
  ]
  for (const bytes of cases) {
    assert.throws(() => parseAbandonmentWorkflowPolicy(Buffer.from(bytes)), /policy/u)
  }
})

test("canonical workflow parsing returns an immutable JSON-safe snapshot", () => {
  const canonical = parseCanonicalReleaseWorkflow(PROTECTED_BYTES)
  assert.ok(Object.isFrozen(canonical))
  assert.ok(Object.isFrozen(canonical.workflow))
  assert.ok(Object.isFrozen(canonical.workflow.jobs))
  assert.throws(() => {
    canonical.workflow.name = "Changed"
  })
  assert.equal(canonical.workflow.name, "Release")
})

test("classifier arguments and environment options are strict", () => {
  for (const bytes of [
    null,
    undefined,
    "",
    PROTECTED_BYTES.toString("utf8"),
    1,
    true,
    {},
    [],
    new DataView(new ArrayBuffer(8)),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  ]) {
    assert.throws(() => classifyReleaseWorkflowAbandonment(bytes, OPTIONS))
  }
  for (const options of [
    null,
    undefined,
    {},
    { abandonmentEnvironment: "" },
    { abandonmentEnvironment: 1 },
    { abandonmentEnvironment: ABANDONMENT_ENVIRONMENT, extra: true },
    Object.create({ abandonmentEnvironment: ABANDONMENT_ENVIRONMENT }),
  ]) {
    assert.throws(() => classifyReleaseWorkflowAbandonment(PROTECTED_BYTES, options))
  }

  let accessed = false
  const accessor = {}
  Object.defineProperty(accessor, "abandonmentEnvironment", {
    enumerable: true,
    get() {
      accessed = true
      return ABANDONMENT_ENVIRONMENT
    },
  })
  assert.throws(() => classifyReleaseWorkflowAbandonment(PROTECTED_BYTES, accessor))
  assert.equal(accessed, false)
  assert.throws(() =>
    classifyReleaseWorkflowAbandonment(PROTECTED_BYTES, {
      abandonmentEnvironment: "release-abandonment-v2",
    }),
  )
  assert.equal(
    classifyReleaseWorkflowAbandonment(DISABLED_BYTES, {
      abandonmentEnvironment: "release-abandonment-v2",
    }),
    "disabled",
  )
})

test("aggregate mode is deterministic across absent, disabled, and protected refs", () => {
  for (const modes of [
    ["protected"],
    ["absent", "protected"],
    ["protected", "absent"],
    ["disabled", "protected"],
    ["protected", "disabled"],
    ["absent", "disabled", "protected"],
    ["protected", "protected"],
  ]) {
    assert.equal(aggregateReleaseWorkflowAbandonment(modes), "protected", modes.join(","))
  }
  for (const modes of [
    ["disabled"],
    ["absent", "disabled"],
    ["disabled", "absent"],
    ["disabled", "disabled"],
    ["absent", "disabled", "absent"],
  ]) {
    assert.equal(aggregateReleaseWorkflowAbandonment(modes), "disabled", modes.join(","))
  }
})

test("aggregate rejects empty, all-absent, unavailable, malformed, and unsafe input", () => {
  for (const modes of [
    [],
    ["absent"],
    ["absent", "absent"],
    ["unavailable"],
    ["error"],
    ["DISABLED"],
    ["disabled", null],
    ["disabled", undefined],
    ["disabled", { mode: "protected" }],
    null,
    undefined,
    "disabled",
    new Set(["disabled"]),
  ]) {
    assert.throws(() => aggregateReleaseWorkflowAbandonment(modes))
  }
  const sparse = Array(1)
  assert.throws(() => aggregateReleaseWorkflowAbandonment(sparse))
  const extended = ["disabled"]
  extended.extra = "protected"
  assert.throws(() => aggregateReleaseWorkflowAbandonment(extended))

  let accessed = false
  const accessor = ["disabled"]
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      accessed = true
      return "protected"
    },
  })
  assert.throws(() => aggregateReleaseWorkflowAbandonment(accessor))
  assert.equal(accessed, false)
})

function deriveDisabledFixture(bytes) {
  let source = bytes.toString("utf8")
  source = replaceOnce(
    source,
    "        description: Reconcile or permanently abandon this candidate\n",
    "        description: Reconcile this candidate\n",
  )
  source = replaceOnce(
    source,
    "          - reconcile\n          - abandon\n",
    "          - reconcile\n",
  )
  source = replaceOnce(
    source,
    [
      "      reason:",
      "        description: Required only for protected abandonment",
      "        required: false",
      "        type: string",
      "",
    ].join("\n"),
    "",
  )
  source = replaceOnce(
    source,
    [
      "      - name: Validate manual intent",
      "        env:",
      "          OPERATION: $" + "{{ inputs.operation }}",
      "          REASON: $" + "{{ inputs.reason }}",
      "        run: |",
      '          if [[ "$OPERATION" == "reconcile" && -n "$REASON" ]]; then',
      '            echo "reason is forbidden for reconcile" >&2',
      "            exit 2",
      "          fi",
      '          if [[ "$OPERATION" == "abandon" && -z "$REASON" ]]; then',
      '            echo "reason is required for abandon" >&2',
      "            exit 2",
      "          fi",
      "",
      "",
    ].join("\n"),
    "",
  )
  source = replaceOnce(source, "          OPERATION: $" + "{{ inputs.operation }}\n", "")
  source = replaceOnce(
    source,
    [
      '          if [[ "$OPERATION" == "abandon" ]]; then',
      '            echo "abandonment must be dispatched at refs/tags/v$' + '{VERSION}" >&2',
      "            exit 2",
      "          fi",
      "",
    ].join("\n"),
    "",
  )
  const abandonStart = "\n  abandon:\n"
  const index = source.indexOf(abandonStart)
  assert.notEqual(index, -1, "protected fixture abandon job is missing")
  assert.equal(source.indexOf(abandonStart, index + abandonStart.length), -1)
  return Buffer.from(source.slice(0, index))
}

function mutateWorkflow(bytes, mutate) {
  const workflow = parseFixture(bytes)
  mutate(workflow)
  return Buffer.from(stringify(workflow, { lineWidth: 0 }))
}

function parseFixture(bytes) {
  return parse(bytes.toString("utf8"), { maxAliasCount: 0, uniqueKeys: true })
}

function replaceOnce(source, before, after) {
  const index = source.indexOf(before)
  assert.notEqual(index, -1, "fixture text is missing " + before.slice(0, 60))
  assert.equal(source.indexOf(before, index + before.length), -1, "fixture text is ambiguous")
  return source.slice(0, index) + after + source.slice(index + before.length)
}

function findStep(job, name) {
  return job.steps.find((step) => step.name === name)
}

function requiredStep(job, name) {
  const matches = job.steps.filter((step) => step.name === name)
  assert.equal(matches.length, 1, name + " fixture must be unique")
  return matches[0]
}

function routeStep(workflow) {
  return requiredStep(workflow.jobs.tag, "Continue at the exact tag or relay once")
}

function removeStep(job, name) {
  const index = job.steps.findIndex((step) => step.name === name)
  assert.notEqual(index, -1, name + " fixture is missing")
  job.steps.splice(index, 1)
}

function removeAbandonBranch(source) {
  return replaceOnce(
    source,
    [
      'if [[ "$OPERATION" == "abandon" ]]; then',
      '  echo "abandonment must be dispatched at refs/tags/v$' + '{VERSION}" >&2',
      "  exit 2",
      "fi",
      "",
    ].join("\n"),
    "",
  )
}

function reverseMappings(value) {
  if (Array.isArray(value)) return value.map(reverseMappings)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, nested]) => [key, reverseMappings(nested)]),
  )
}
