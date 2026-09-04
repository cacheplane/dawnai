import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { parse, stringify } from "yaml"
import { classifyReleaseWorkflowAbandonment } from "../abandonment-reachability.mjs"
import { ARTIFACT_STORE_SPARSE_FILES } from "../artifact-store.mjs"
import { readBoundedFixture } from "../fixture-io.mjs"
import { PUBLISHER_SPARSE_FILES } from "../publisher.mjs"
import { REQUIRED_RELEASE_SMOKE_LANES } from "../smoke-result.mjs"

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const requireFromCore = createRequire(path.join(ROOT, "packages", "core", "package.json"))
const typescript = requireFromCore("typescript")
if (typescript.version !== "6.0.2" || typeof typescript.createSourceFile !== "function") {
  throw new Error("The packages/core TypeScript compiler parser is unavailable")
}
const WORKFLOWS = path.join(ROOT, ".github/workflows")
const CONTROLLER_SCHEMA_PATH = path.join(ROOT, "scripts/release/controller-schema.json")
const ENTRYPOINT_ALLOWLIST_PATH = path.join(
  ROOT,
  "scripts/release/test/fixtures/workflow-entrypoints.json",
)
const EXECUTABLE_ALLOWLIST_PATH = path.join(
  ROOT,
  "scripts/release/test/fixtures/workflow-safe-executables.json",
)
const EXECUTABLE_ALLOWLIST = JSON.parse(
  await readBoundedFixture(EXECUTABLE_ALLOWLIST_PATH, { root: ROOT }),
)
const SCRIPT_PIN_FIXTURE = "scripts/release/test/fixtures/release-script-hashes.json"
const SCRIPT_PIN_PATH = path.join(ROOT, SCRIPT_PIN_FIXTURE)
// Exact fixture bytes after exporting validateMarker for the terminal record store
// (v0.8.22 terminal recovery) on top of the reviewed artifact-download Accept fix
// (scripts/release/adapters/github.mjs; GitHub began answering HTTP 415 to
// application/octet-stream on the artifact zip endpoint on 2026-09-03).
// Previously pinned at Task 11's starting HEAD e5cf1986c0f2cb2f55b891a7c92fa7291289dfdb.
// Repinned for the required terminalRecordRef option on observeProductionCandidate /
// resolveProductionCandidate (scripts/release/cli.mjs, independent-audit.mjs, and
// post-publication-audit.mjs each now pass the ref their own job checks out).
// Repinned for getAuthenticatedUser on the GitHub reader (scripts/release/adapters/github.mjs):
// the v0.8.22 terminal recovery record names the operator login its token acts as.
const STARTING_SCRIPT_PIN_SHA256 =
  "23b0a9057c4f8051049e4ebd71f40c8844cca4ce9f562b6f40c5d82e066fbdb0"
const SHA256_HEX = /^[0-9a-f]{64}$/u
const workflowExpression = (value) => `\${{ ${value} }}`
const SCRIPT_REFERENCE = /(?:^|[\s;&|"'(])(scripts\/[\w.-]+(?:\/[\w.-]+)*)/gu
const PNPM_REFERENCE = /(?:^|[\s;&|"'(])pnpm\s+(?:run\s+)?(?!-)([\w:.-]+)/gu
const ACTIONS = Object.freeze({
  attest: "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8",
  changesets: "changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d",
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  download: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  node: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  pnpm: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
  upload: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
})
const FINAL_WORKFLOW_FILES = Object.freeze([
  "published-artifact-verify.yml",
  "release.yml",
  "version-pr.yml",
])
const LEGACY_RELEASE_FILES = Object.freeze([
  "scripts/backfill-release-tags.mjs",
  "scripts/backfill-release-tags.test.mjs",
  "scripts/release-publish.mjs",
  "scripts/release-publish.test.mjs",
  "scripts/upload-release-assets.mjs",
  "scripts/upload-release-assets.test.mjs",
])
const LEGACY_PACKAGE_COMMANDS = Object.freeze([
  "release:publish",
  "release:shadow",
  "test:backfill-release-tags",
  "test:release-publish",
  "test:upload-release-assets",
])
const SMOKE_JOB_BY_LANE = Object.freeze(
  Object.fromEntries(REQUIRED_RELEASE_SMOKE_LANES.map((lane) => [lane, `smoke-${lane}`])),
)
const NORMAL_EXACT_TAG_JOBS = Object.freeze([
  "prepare",
  "hydrate",
  "attest",
  "escrow",
  "publish-npm",
  "reconcile-npm",
  ...Object.values(SMOKE_JOB_BY_LANE),
  "reconcile-smokes",
  "dispatch-audit",
  "record-audit-dispatch",
  "correlate-audit",
  "publish-release",
])
const FINAL_RELEASE_JOB_IDS = Object.freeze(["detect", "tag", ...NORMAL_EXACT_TAG_JOBS])

test("final release ownership is switched atomically and legacy owners are absent", async () => {
  const sources = await readWorkflowSourcesFromRoot(ROOT)
  const packageJson = JSON.parse(
    await readBoundedFixture(path.join(ROOT, "package.json"), { root: ROOT }),
  )

  for (const file of FINAL_WORKFLOW_FILES) {
    assert.equal(typeof sources[file], "string", `${file} must exist in the atomic switch`)
    assert.doesNotThrow(() => parseWorkflowSource(sources[file], file))
  }
  assert.equal(sources["release-shadow.yml"], undefined, "release-shadow.yml must be deleted")
  for (const file of LEGACY_RELEASE_FILES) {
    await assert.rejects(lstat(path.join(ROOT, file)), { code: "ENOENT" })
  }
  for (const command of LEGACY_PACKAGE_COMMANDS) {
    assert.equal(packageJson.scripts?.[command], undefined, `${command} must be removed`)
  }
  assert.doesNotMatch(
    packageJson.scripts?.["ci:validate"] ?? "",
    /(?:release-publish|upload-release-assets|backfill-release-tags)/u,
  )

  const ci = parseWorkflowSource(sources["ci.yml"], "ci.yml")
  assert.ok(ci.jobs["vercel-native"], "the real Vercel deployment lane is required")
  assert.ok(ci.jobs["copilotkit-examples-e2e"], "the CopilotKit example e2e lane is required")
  assert.equal(typeof sources["publish-chart.yml"], "string", "chart publication remains owned")
})

test("duplicate-draft consolidation stays isolated from every workflow and preserves release pins", async () => {
  const sources = await readWorkflowSourcesFromRoot(ROOT)
  assert.ok(Object.keys(sources).length > FINAL_WORKFLOW_FILES.length)
  await assertNoDuplicateDraftWorkflowMutationFromRoot(ROOT)

  const pinBytes = await readFile(SCRIPT_PIN_PATH)
  assert.equal(createHash("sha256").update(pinBytes).digest("hex"), STARTING_SCRIPT_PIN_SHA256)
})

test("workflow isolation rejects Release DELETE bypasses in each execution context", async (t) => {
  const unsafe = [
    [
      "gh interpolated repository",
      runWorkflow(`gh api --method DELETE repos/\${{ github.repository }}/releases/379982100`),
    ],
    [
      "curl compact method",
      runWorkflow(
        "curl -XDELETE https://api.github.com/repos/cacheplane/dawnai/releases/379982100",
      ),
    ],
    [
      "curl spaced method",
      runWorkflow(
        "curl -x   DeLeTe https://api.github.com/repos/cacheplane/dawnai/releases/379982100",
      ),
    ],
    [
      "curl request method",
      runWorkflow(
        "curl --request DELETE https://api.github.com/repos/cacheplane/dawnai/releases/379982100",
      ),
    ],
    [
      "curl request equals method",
      runWorkflow(
        "curl --request=delete https://api.github.com/repos/cacheplane/dawnai/releases/379982100",
      ),
    ],
    [
      "interpolated owner and repository name",
      runWorkflow(
        `gh api --method DELETE repos/\${{ github.repository_owner }}/\${{ vars.repository_name }}/releases/\${{ inputs.release_id }}`,
      ),
    ],
    [
      "literal multiline api url",
      runWorkflow(`gh api \\
  --method
  DELETE \\
  "\${{ github.api_url }}/repos/\${{ github.repository }}/releases/379982100"`),
    ],
    [
      "folded multiline api url",
      runWorkflow(
        `gh api --method
DELETE
repos/\${{ github.repository }}/releases/379982100`,
        ">",
      ),
    ],
    [
      "action inputs",
      actionWorkflow({
        method: "DELETE",
        endpoint: `/repos/\${{ github.repository }}/releases/\${{ inputs.release_id }}`,
      }),
    ],
    [
      "step environment",
      runWorkflow('curl --request "$HTTP_METHOD" "$RELEASE_ENDPOINT"', "|", {
        HTTP_METHOD: "DELETE",
        RELEASE_ENDPOINT: `\${{ github.api_url }}/repos/\${{ github.repository }}/releases/379982100`,
      }),
    ],
    [
      "job environment",
      runWorkflow('curl -X "$HTTP_METHOD" "$RELEASE_ENDPOINT"', "|", undefined, {
        HTTP_METHOD: "DELETE",
        RELEASE_ENDPOINT: "/repos/cacheplane/dawnai/releases/379982100",
      }),
    ],
    [
      "reusable workflow inputs",
      reusableWorkflow({
        "http-method": "delete",
        url: `\${{ github.api_url }}/repos/\${{ github.repository }}/releases/379982100`,
      }),
    ],
    [
      "Octokit deleteRelease call",
      runWorkflow("await github.rest.repos.deleteRelease({ owner, repo, release_id })"),
    ],
    [
      "optional and spaced Octokit deleteRelease call",
      runWorkflow(
        "await github ?. rest ?. repos ?. deleteRelease ?. ({ owner, repo, release_id })",
      ),
    ],
    [
      "GitHub request route template",
      runWorkflow(
        "await github.request('DELETE /repos/{owner}/{repo}/releases/{release_id}', options)",
      ),
    ],
    [
      "optional GitHub request route template",
      runWorkflow(
        'await github?.request?.("delete   /repos/{owner}/{repo}/releases/{release_id}", options)',
      ),
    ],
    [
      "GitHub request object",
      runWorkflow(
        "await github.request({ method: 'DELETE', url: '/repos/{owner}/{repo}/releases/{release_id}' })",
      ),
    ],
    [
      "shell braced path variables",
      runWorkflow(`gh api --method DELETE "repos/\${GITHUB_REPOSITORY}/releases/\${RELEASE_ID}"`),
    ],
    [
      "shell unbraced path variables",
      runWorkflow('gh api --method DELETE "repos/$GITHUB_REPOSITORY/releases/$RELEASE_ID"'),
    ],
    [
      "matrix axes",
      matrixWorkflow(
        {
          method: ["DELETE"],
          endpoint: ["/repos/{owner}/{repo}/releases/{release_id}"],
        },
        `gh api --method "\${{ matrix.method }}" "\${{ matrix.endpoint }}"`,
      ),
    ],
    [
      "matrix include",
      matrixWorkflow(
        {
          include: [
            {
              method: "DELETE",
              endpoint: "/repos/cacheplane/dawnai/releases/379982100",
            },
          ],
        },
        `curl --request "\${{ matrix.method }}" "\${{ matrix.endpoint }}"`,
      ),
    ],
    [
      "generic matrix axes",
      matrixWorkflow(
        {
          a: ["GET", "DELETE"],
          b: ["/repos/cacheplane/dawnai/releases/379982100"],
        },
        `gh api --method "\${{ matrix.a }}" "\${{ matrix.b }}"`,
      ),
    ],
    [
      "generic matrix include object",
      matrixWorkflow(
        {
          include: [
            {
              x: "DELETE",
              y: "/repos/{owner}/{repo}/releases/{release_id}",
            },
          ],
        },
        `github.request("\${{ matrix.x }} \${{ matrix.y }}")`,
      ),
    ],
    [
      "generic matrix bracket notation",
      matrixWorkflow(
        {
          v: ["DELETE"],
          r: ["/repos/cacheplane/dawnai/releases/379982100"],
        },
        `curl --request "\${{ matrix['v'] }}" "\${{ matrix["r"] }}"`,
      ),
    ],
    [
      "mixed matrix interpolation",
      matrixWorkflow(
        {
          prefix: ["DEL"],
          suffix: ["ETE"],
          owner: ["cacheplane"],
          repository: ["dawnai"],
          release: ["379982100"],
        },
        `gh api --method "\${{ matrix.prefix }}\${{ matrix.suffix }}" "repos/\${{ matrix.owner }}/\${{ matrix.repository }}/releases/\${{ matrix.release }}"`,
      ),
    ],
    [
      "dynamic matrix references in method and endpoint positions",
      dynamicMatrixWorkflow(`gh api --method "\${{ matrix.a }}" "\${{ matrix.b }}"`),
    ],
    [
      "matrix keys with unresolved generated values",
      matrixWorkflow(
        {
          a: [`\${{ fromJSON(needs.scope.outputs.methods) }}`],
          b: [`\${{ fromJSON(needs.scope.outputs.endpoints) }}`],
        },
        `gh api --method "\${{ matrix.a }}" "\${{ matrix.b }}"`,
      ),
    ],
    ["gh release delete", runWorkflow("gh release delete opaque-tag --yes")],
    [
      "curl GitHub API shell variables",
      runWorkflow(
        `curl -X DELETE "\${GITHUB_API_URL}/repos/\${GITHUB_REPOSITORY}/releases/\${RELEASE_ID}"`,
      ),
    ],
    [
      "Octokit bracket deleteRelease call",
      runWorkflow(`await github?.rest?.repos?.["deleteRelease"]?.({ release_id })`),
    ],
    [
      "workflow dispatch input defaults",
      inputDefaultWorkflow(
        {
          method: "DELETE",
          endpoint: "/repos/{owner}/{repo}/releases/{release_id}",
        },
        `curl --request "\${{ inputs.method }}" "\${{ inputs.endpoint }}"`,
      ),
    ],
    [
      "generic environment indirection",
      runWorkflow('curl --request "$A" "$B"', "|", {
        A: "DELETE",
        B: "/repos/cacheplane/dawnai/releases/379982100",
      }),
    ],
    [
      "generated method and endpoint expressions",
      runWorkflow(
        `gh api --method "\${{ fromJSON(inputs.config).verb }}" "\${{ fromJSON(inputs.config).route }}"`,
      ),
    ],
  ]

  for (const [name, source] of unsafe) {
    await t.test(name, () => {
      assert.throws(
        () => assertNoDuplicateDraftWorkflowMutation({ "fixture.yml": source }),
        /Release DELETE/u,
      )
    })
  }
})

test("workflow isolation permits comments, documentation, GETs, and separate invocations", () => {
  const safe = `name: "Documentation: DELETE /repos/cacheplane/dawnai/releases/379982100"
on:
  workflow_dispatch: {}
jobs:
  safe:
    runs-on: ubuntu-latest
    steps:
      # curl -XDELETE https://api.github.com/repos/cacheplane/dawnai/releases/379982100
      - name: "DELETE /repos/cacheplane/dawnai/releases/379982100 is forbidden"
        run: gh api --method GET repos/\${{ github.repository }}/releases/379982100
      - run: echo --method DELETE
      - run: echo /repos/cacheplane/dawnai/releases/379982100
`
  assert.doesNotThrow(() => assertNoDuplicateDraftWorkflowMutation({ "safe.yml": safe }))

  const unrelatedMatrix = matrixWorkflow(
    {
      os: ["ubuntu-latest", "windows-latest"],
      method: ["GET"],
      endpoint: ["/repos/{owner}/{repo}/releases/{release_id}"],
    },
    `gh api --method "\${{ matrix.method }}" "\${{ matrix.endpoint }}"`,
  )
  assert.doesNotThrow(() =>
    assertNoDuplicateDraftWorkflowMutation({
      "unrelated-matrix.yml": unrelatedMatrix,
    }),
  )

  const unusedDangerousMatrix = matrixWorkflow(
    {
      a: ["DELETE"],
      b: ["/repos/cacheplane/dawnai/releases/379982100"],
      safeMethod: ["GET"],
      safeEndpoint: ["/repos/cacheplane/dawnai/releases/379982100"],
    },
    `gh api --method "\${{ matrix.safeMethod }}" "\${{ matrix.safeEndpoint }}"`,
  )
  assert.doesNotThrow(() =>
    assertNoDuplicateDraftWorkflowMutation({
      "unused-matrix.yml": unusedDangerousMatrix,
    }),
  )

  const separateJobs = `name: separate jobs
on:
  workflow_dispatch: {}
jobs:
  method:
    strategy:
      matrix:
        method: [DELETE]
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ matrix.method }}"
  endpoint:
    runs-on: ubuntu-latest
    steps:
      - run: echo /repos/cacheplane/dawnai/releases/379982100
`
  assert.doesNotThrow(() =>
    assertNoDuplicateDraftWorkflowMutation({
      "separate-jobs.yml": separateJobs,
    }),
  )

  const separateMatrixSteps = matrixWorkflow(
    {
      a: ["DELETE"],
      b: ["/repos/cacheplane/dawnai/releases/379982100"],
    },
    [`echo "\${{ matrix.a }}"`, `echo "\${{ matrix.b }}"`],
  )
  assert.doesNotThrow(() =>
    assertNoDuplicateDraftWorkflowMutation({
      "separate-matrix-steps.yml": separateMatrixSteps,
    }),
  )

  const coherentUnknownMatrix = dynamicMatrixWorkflow([
    `echo "\${{ matrix.a }}"`,
    `gh api --method "\${{ matrix.b }}" "\${{ matrix.b }}"`,
  ])
  assert.doesNotThrow(() =>
    assertNoDuplicateDraftWorkflowMutation({
      "coherent-unknown-matrix.yml": coherentUnknownMatrix,
    }),
  )

  const excludedDeleteRow = matrixWorkflow(
    {
      a: ["GET", "DELETE"],
      b: ["/repos/cacheplane/dawnai/releases/379982100"],
      exclude: [{ a: "DELETE" }],
    },
    `curl --request "\${{ matrix.a }}" "\${{ matrix.b }}"`,
  )
  assert.doesNotThrow(() =>
    assertNoDuplicateDraftWorkflowMutation({
      "excluded-delete-row.yml": excludedDeleteRow,
    }),
  )

  const nonComposingInclude = matrixWorkflow(
    {
      a: ["GET"],
      b: ["/repos/cacheplane/dawnai/releases/379982100"],
      include: [{ a: "DELETE", c: "https://example.invalid/not-a-release" }],
    },
    `curl --request "\${{ matrix.a }}" "\${{ matrix.b }}\${{ matrix.c }}"`,
  )
  assert.doesNotThrow(() =>
    assertNoDuplicateDraftWorkflowMutation({
      "non-composing-include.yml": nonComposingInclude,
    }),
  )

  const standaloneIncludesDoNotCompose = matrixWorkflow(
    {
      method: ["GET"],
      include: [{ method: "DELETE" }, { endpoint: "/repos/cacheplane/dawnai/releases/1" }],
    },
    `curl --request "\${{ matrix.method }}" "\${{ matrix.endpoint }}"`,
  )
  assert.doesNotThrow(() =>
    assertNoDuplicateDraftWorkflowMutation({
      "standalone-includes.yml": standaloneIncludesDoNotCompose,
    }),
  )
})

test("workflow isolation follows every repository-local executable transitively", async (t) => {
  const cases = [
    {
      name: "package script wrapper",
      workflow: "pnpm run hidden",
      packageScripts: { hidden: "bash scripts/hidden.sh" },
      files: { "scripts/hidden.sh": "gh release delete opaque-tag --yes\n" },
    },
    {
      name: "local composite action",
      uses: "./.github/actions/hidden",
      files: {
        ".github/actions/hidden/action.yml":
          'runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: curl -X DELETE "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/releases/$RELEASE_ID"\n',
      },
    },
    {
      name: "local JavaScript action entrypoint",
      uses: "./.github/actions/javascript",
      files: {
        ".github/actions/javascript/action.yml": "runs:\n  using: node24\n  main: index.mjs\n",
        ".github/actions/javascript/index.mjs":
          'await github.rest.repos["deleteRelease"]({ release_id: 1 })\n',
      },
    },
    {
      name: "local reusable workflow",
      jobUses: "./.github/workflows/reusable.yml",
      files: {
        ".github/workflows/reusable.yml":
          "on:\n  workflow_call: {}\njobs:\n  hidden:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release delete opaque-tag --yes\n",
      },
    },
    {
      name: "shell wrapper chain",
      workflow: "bash scripts/first.sh",
      files: {
        "scripts/first.sh": "bash scripts/second.sh\n",
        "scripts/second.sh":
          "curl --request DELETE https://api.github.com/repos/cacheplane/dawnai/releases/379982100\n",
      },
    },
    {
      name: "reachable banned identifier",
      workflow: "node --enable-source-maps scripts/hidden.mjs",
      files: { "scripts/hidden.mjs": "export const lane = 'duplicate-draft-consolidation'\n" },
    },
    {
      name: "static JavaScript import and spawn",
      workflow: "node scripts/first.mjs",
      files: {
        "scripts/first.mjs": "import './second.js'\n",
        "scripts/second.js": "spawn('bash', ['-eu', 'scripts/hidden.sh'])\n",
        "scripts/hidden.sh": "gh release delete opaque-tag --yes\n",
      },
    },
    {
      name: "comment-separated static import",
      workflow: "node scripts/first.mjs",
      files: {
        "scripts/first.mjs": "import/*comment*/'./hidden.mjs'\n",
        "scripts/hidden.mjs": "gh release delete opaque-tag --yes\n",
      },
    },
    {
      name: "comment-separated CommonJS require",
      workflow: "node scripts/first.cjs",
      files: {
        "scripts/first.cjs": "require/*comment*/('./hidden.cjs')\n",
        "scripts/hidden.cjs": "gh release delete opaque-tag --yes\n",
      },
    },
    {
      name: "comment-separated export and dynamic import",
      workflow: "node scripts/first.mjs",
      files: {
        "scripts/first.mjs": "export/*one*/{ value }/*two*/from/*three*/'./middle.mjs'\n",
        "scripts/middle.mjs": "import/*four*/('./hidden.mjs')\n",
        "scripts/hidden.mjs": "gh release delete opaque-tag --yes\n",
      },
    },
    {
      name: "TypeScript import equals",
      workflow: "pnpm exec tsx scripts/first.ts",
      files: {
        "scripts/first.ts": "import hidden = require('./hidden.cjs')\nvoid hidden\n",
        "scripts/hidden.cjs": "gh release delete opaque-tag --yes\n",
      },
    },
    {
      name: "dynamic import with options",
      workflow: "node scripts/first.mjs",
      files: {
        "scripts/first.mjs": "import('./hidden.mjs', {})\n",
        "scripts/hidden.mjs": "gh release delete opaque-tag --yes\n",
      },
    },
    {
      name: "CommonJS require with extra argument",
      workflow: "node scripts/first.cjs",
      files: {
        "scripts/first.cjs": "require('./hidden.cjs', undefined)\n",
        "scripts/hidden.cjs": "gh release delete opaque-tag --yes\n",
      },
    },
    {
      name: "pnpm exec tsx runner",
      workflow: "pnpm exec tsx scripts/hidden.ts",
      files: { "scripts/hidden.ts": "github.rest.repos.deleteRelease({ release_id: 1 })\n" },
    },
    {
      name: "bash option runner",
      workflow: "bash -eu scripts/hidden.sh",
      files: { "scripts/hidden.sh": "gh release delete opaque-tag --yes\n" },
    },
    {
      name: "filtered workspace package script",
      workflow: "pnpm --filter @fixture/worker run hidden",
      files: {
        "packages/worker/package.json": JSON.stringify({
          name: "@fixture/worker",
          scripts: { hidden: "node scripts/hidden.mjs" },
        }),
        "packages/worker/scripts/hidden.mjs": "gh release delete opaque-tag --yes\n",
      },
    },
  ]
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await createWorkflowReachabilityFixture(t, fixture)
      await assert.rejects(
        () => assertNoDuplicateDraftWorkflowMutationFromRoot(root),
        /Release DELETE|consolidation identifier/u,
      )
    })
  }

  await t.test("unreachable mutation and reachable GET remain safe", async () => {
    const root = await createWorkflowReachabilityFixture(t, {
      workflow: "bash scripts/safe.sh",
      files: {
        "scripts/safe.sh": "gh api --method GET repos/$GITHUB_REPOSITORY/releases/$RELEASE_ID\n",
        "scripts/unreachable.sh": "gh release delete opaque-tag --yes\n",
      },
    })
    await assert.doesNotReject(() => assertNoDuplicateDraftWorkflowMutationFromRoot(root))
  })

  await t.test("safe wrapper cycles terminate", async () => {
    const root = await createWorkflowReachabilityFixture(t, {
      workflow: "bash scripts/a.sh",
      files: {
        "scripts/a.sh": "bash scripts/b.sh\n",
        "scripts/b.sh": "bash scripts/a.sh\n",
      },
    })
    await assert.doesNotReject(() => assertNoDuplicateDraftWorkflowMutationFromRoot(root))
  })

  await t.test("reachable symlink escape fails closed", async () => {
    const root = await createWorkflowReachabilityFixture(t, {
      workflow: "bash scripts/escape.sh",
    })
    const outside = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-outside-"))
    t.after(() => rm(outside, { recursive: true, force: true }))
    await writeFile(path.join(outside, "escape.sh"), "echo safe\n")
    await mkdir(path.join(root, "scripts"), { recursive: true })
    await symlink(path.join(outside, "escape.sh"), path.join(root, "scripts", "escape.sh"))
    await assert.rejects(() => assertNoDuplicateDraftWorkflowMutationFromRoot(root))
  })

  await t.test("unsupported repository-local runner fails closed", async () => {
    const root = await createWorkflowReachabilityFixture(t, {
      workflow: "custom-runner scripts/hidden.mjs",
      files: { "scripts/hidden.mjs": "echo safe\n" },
    })
    await assert.rejects(() => assertNoDuplicateDraftWorkflowMutationFromRoot(root))
  })

  await t.test("comments and generated source do not create module edges", async () => {
    const root = await createWorkflowReachabilityFixture(t, {
      workflow: "node scripts/safe.mjs",
      files: {
        "scripts/safe.mjs": [
          "// import './missing-one.mjs'",
          "const text = \"require('./missing-two.cjs')\"",
          "const template = `export * from './missing-three.mjs'`",
          "export const safe = text + template",
        ].join("\n"),
      },
    })
    await assert.doesNotReject(() => assertNoDuplicateDraftWorkflowMutationFromRoot(root))
  })

  await t.test("nonliteral first arguments and harmless extra arguments stay safe", async () => {
    const root = await createWorkflowReachabilityFixture(t, {
      workflow: "node scripts/safe.mjs",
      files: {
        "scripts/safe.mjs": [
          "const target = './unreachable.mjs'",
          "import(target, {})",
          "require(target, undefined)",
          "import('node:path', {})",
          "require('node:fs', undefined)",
        ].join("\n"),
        "scripts/unreachable.mjs": "gh release delete opaque-tag --yes\n",
      },
    })
    await assert.doesNotReject(() => assertNoDuplicateDraftWorkflowMutationFromRoot(root))
  })

  await t.test("reachable JavaScript syntax errors fail closed", async () => {
    const root = await createWorkflowReachabilityFixture(t, {
      workflow: "node scripts/broken.mjs",
      files: { "scripts/broken.mjs": "import { from './broken.mjs'\n" },
    })
    await assert.rejects(
      () => assertNoDuplicateDraftWorkflowMutationFromRoot(root),
      /cannot be parsed/u,
    )
  })
})

test("version-pr.yml is version-only and uses only RELEASE_GITHUB_TOKEN", async () => {
  const { source, workflow } = await readRequiredWorkflow("version-pr.yml")
  const packageJson = JSON.parse(
    await readBoundedFixture(path.join(ROOT, "package.json"), { root: ROOT }),
  )
  assert.deepEqual(workflow.on, { push: { branches: ["main"] } })
  assert.deepEqual(workflow.permissions, {
    contents: "write",
    "pull-requests": "write",
  })
  assert.deepEqual(Object.keys(workflow.jobs), ["version"])

  const version = requiredJob(workflow, "version")
  assertReadOrWritePermissions(version.permissions, {
    contents: "write",
    "pull-requests": "write",
  })
  const changesets = onlyStepUsing(version, ACTIONS.changesets)
  const pnpm = onlyStepUsing(version, ACTIONS.pnpm)
  assert.deepEqual(pnpm.with, { version: "10.33.0" })
  assert.deepEqual(changesets.with, {
    commit: "Version Packages",
    title: "Version Packages",
    version: "pnpm run version",
  })
  assert.deepEqual(changesets.env, {
    GITHUB_TOKEN: workflowExpression("secrets.RELEASE_GITHUB_TOKEN"),
  })
  assert.equal(
    packageJson.scripts?.version,
    "changeset version && node scripts/sync-chart-appversion.mjs",
    "Version Packages must advance fixed-package and chart versions in one commit",
  )

  assert.doesNotMatch(
    source,
    /\|\||secrets\.GITHUB_TOKEN|\bpublish\s*:|createGithubReleases|registry-url/iu,
  )
  assert.doesNotMatch(
    source,
    /id-token|attestations|publisher\.mjs|npm\s+publish|gh\s+release|\/releases/iu,
  )
  assertPinnedToolchain(version)
})

test("release.yml has exact triggers and one repository-global non-cancelling queue", async () => {
  const { workflow } = await readRequiredWorkflow("release.yml")
  assert.deepEqual(workflow.env, {
    GITHUB_REPOSITORY_ID: workflowExpression("github.repository_id"),
  })
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "schedule", "workflow_dispatch"])
  assert.deepEqual(workflow.on.push, { branches: ["main"] })
  assert.ok(Array.isArray(workflow.on.schedule) && workflow.on.schedule.length === 1)
  assert.match(workflow.on.schedule[0].cron, /^[\d*/,-]+(?: [\d*/,-]+){4}$/u)
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), [
    "commitSha",
    "operation",
    "version",
  ])
  assertDispatchIdentityInput(workflow.on.workflow_dispatch.inputs.version)
  assertDispatchIdentityInput(workflow.on.workflow_dispatch.inputs.commitSha)
  assert.deepEqual(dispatchInputContract(workflow.on.workflow_dispatch.inputs.operation), {
    default: "reconcile",
    options: ["reconcile"],
    required: true,
    type: "choice",
  })
  assert.equal(
    workflow.on.workflow_dispatch.inputs.operation.description,
    "Reconcile this candidate",
  )

  assert.equal(typeof workflow.concurrency?.group, "string")
  assert.match(workflow.concurrency.group, /release/iu)
  assert.doesNotMatch(workflow.concurrency.group, /\$\{\{/u, "the release lock must be global")
  assert.equal(workflow.concurrency.queue, "max")
  assert.equal(workflow.concurrency["cancel-in-progress"], false)
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...FINAL_RELEASE_JOB_IDS].sort())
  assert.equal(Object.keys(workflow.jobs).length, 18)
})

test("final release workflows pin every action and the exact Node, pnpm, and npm toolchain", async () => {
  const sources = await readFinalWorkflowSources()
  const allowedActions = new Set(Object.values(ACTIONS))
  let pnpmSetups = 0
  let npmChecks = 0
  for (const [file, source] of Object.entries(sources)) {
    const workflow = parseWorkflowSource(source, file)
    for (const entry of workflowExecutables(workflow).filter(({ kind }) => kind === "step-uses")) {
      assert.match(entry.value, /^[^@\s]+@[0-9a-f]{40}$/u, `${file}: ${entry.value}`)
      assert.ok(allowedActions.has(entry.value), `${file}: unreviewed action ${entry.value}`)
    }
    for (const job of Object.values(workflow.jobs)) {
      const runs = runSource(job)
      if (
        /\bnode\s+scripts\//u.test(runs) ||
        job.steps?.some((step) => step.uses === ACTIONS.changesets)
      ) {
        assertPinnedToolchain(job)
      }
      pnpmSetups += job.steps?.filter((step) => step.uses === ACTIONS.pnpm).length ?? 0
      if (/npm\s+--version[\s\S]*11\.17\.0|11\.17\.0[\s\S]*npm\s+--version/u.test(runs)) {
        npmChecks += 1
      }
    }
  }
  assert.ok(pnpmSetups > 0, "the exact pnpm runtime must be installed where versioning uses it")
  assert.ok(npmChecks > 0, "the exact npm runtime must be asserted before release verification")
})

test("detect invokes the sole production observer and exports only validated controller outputs", async () => {
  const { source, workflow } = await readRequiredWorkflow("release.yml")
  const detect = requiredJob(workflow, "detect")
  assert.deepEqual(normalizeNeeds(detect.needs), [])
  assertNoWriteOrOidc(detect)
  assert.equal(detect.permissions?.checks, "read")
  const checkout = onlyStepUsing(detect, ACTIONS.checkout)
  const pnpm = onlyStepUsing(detect, ACTIONS.pnpm)
  const node = onlyStepUsing(detect, ACTIONS.node)
  const install = onlyRunStepMatching(
    detect,
    /^"\$PNPM_HOME\/pnpm" install --filter \. --frozen-lockfile --ignore-scripts$/u,
  )
  const observe = onlyRunStepMatching(detect, /node scripts\/release\/cli\.mjs observe\b/u)
  assert.deepEqual(pnpm.with, { version: "10.33.0" })
  assert.ok(detect.steps.indexOf(checkout) < detect.steps.indexOf(pnpm))
  assert.ok(detect.steps.indexOf(pnpm) < detect.steps.indexOf(node))
  assert.ok(detect.steps.indexOf(node) < detect.steps.indexOf(install))
  assert.ok(detect.steps.indexOf(install) < detect.steps.indexOf(observe))
  assert.equal(observe.id, "observe")
  assert.equal(observe["continue-on-error"], undefined)
  assertCommandFlags(observe.run, "node scripts/release/cli.mjs observe", [
    "--event",
    "--report",
    "--github-output",
  ])
  assert.match(observe.run, /--github-output\s+["']?\$GITHUB_OUTPUT["']?/u)
  assert.deepEqual(detect.outputs, {
    candidate_sha: workflowExpression("steps.observe.outputs.candidate_sha"),
    candidate_version: workflowExpression("steps.observe.outputs.candidate_version"),
    disposition: workflowExpression("steps.observe.outputs.disposition"),
    next_transition: workflowExpression("steps.observe.outputs.next_transition"),
    observation_artifact_id: workflowExpression("steps.observation.outputs.artifact-id"),
    state: workflowExpression("steps.observe.outputs.state"),
  })
  const observationUpload = detect.steps.find(
    (step) => step.id === "observation" && step.uses === ACTIONS.upload,
  )
  assert.ok(observationUpload)
  assert.equal(
    observationUpload.with?.name,
    `production-observation-${workflowExpression("github.run_id")}-${workflowExpression("github.run_attempt")}`,
  )
  assert.equal(observationUpload.with?.overwrite, false)
  assert.doesNotMatch(observe.run, /\|\||continue-on-error|shadow|fallback/iu)
  assert.equal(countMatches(source, /scripts\/release\/cli\.mjs observe\b/gu), 1)
  assert.doesNotMatch(source, /release:shadow|shadow-reconcile|release-shadow/iu)

  assert.equal(checkout.with?.ref, workflowExpression("github.event.repository.default_branch"))
  assert.equal(checkout.with?.["fetch-depth"], 0)
  assert.equal(checkout.with?.["persist-credentials"], false)
  assert.doesNotMatch(source, /RELEASE_ADMIN_READ_TOKEN|immutable-releases-gate/iu)
})

test("tag is the sole coordinator relay and exact-tag identity requires both ref and SHA", async () => {
  const { source, workflow } = await readRequiredWorkflow("release.yml")
  const tag = requiredJob(workflow, "tag")
  assert.deepEqual(normalizeNeeds(tag.needs), ["detect"])
  assertReadOrWritePermissions(tag.permissions, {
    actions: "write",
    contents: "write",
  })
  assert.deepEqual(Object.keys(tag.outputs), ["continue"])
  assert.match(tag.outputs.continue, /^\$\{\{ steps\.[\w-]+\.outputs\.continue \}\}$/u)
  onlyRunStepMatching(tag, /node scripts\/release\/cli\.mjs tag --candidate\b/u)
  const relay = onlyRunStepMatching(tag, /2026-03-10/u)
  assert.match(relay.run, /\.github\/workflows\/release\.yml/u)
  assert.match(relay.run, /refs\/tags\/v/u)
  assert.match(relay.run, /workflow_dispatch|dispatches/iu)
  assert.match(relay.run, /operation[\s"'=:]+reconcile/iu)
  assert.deepEqual(relay.env?.GITHUB_TOKEN, workflowExpression("github.token"))
  assert.equal(relay.env?.OPERATION, undefined)
  assert.doesNotMatch(relay.run, /list.*runs|runs\/\?|poll|wait|sleep/iu)
  assert.doesNotMatch(relay.run, /abandon/iu)
  assert.doesNotMatch(source, /target_commitish|git\s+tag\s+(?!-a|-s)|createGithubReleases/iu)

  for (const id of NORMAL_EXACT_TAG_JOBS) {
    assertExactTagAndOperationGate(requiredJob(workflow, id), {
      operation: "reconcile",
    })
  }
})

test("prepare, attestation, and ATTACHING-to-45-base escrow have one ordered authority path", async () => {
  const { source, workflow } = await readRequiredWorkflow("release.yml")
  const prepare = requiredJob(workflow, "prepare")
  const hydrate = requiredJob(workflow, "hydrate")
  const attest = requiredJob(workflow, "attest")
  const escrow = requiredJob(workflow, "escrow")
  assert.deepEqual(normalizeNeeds(prepare.needs), ["detect", "tag"])
  assert.deepEqual(normalizeNeeds(hydrate.needs), ["detect", "prepare", "tag"])
  assert.deepEqual(normalizeNeeds(attest.needs), ["detect", "hydrate", "tag"])
  assert.deepEqual(normalizeNeeds(escrow.needs), ["attest", "detect", "hydrate", "tag"])
  assertNoWriteOrOidc(prepare)
  assertNoWriteOrOidc(hydrate)
  assertReadOrWritePermissions(attest.permissions, {
    actions: "read",
    attestations: "write",
    contents: "read",
    "id-token": "write",
  })
  assert.equal(escrow.permissions?.contents, "write")
  assert.notEqual(escrow.permissions?.actions, "write")

  const handoff = onlyRunStepMatching(prepare, /node scripts\/release\/workflow-handoff\.mjs\b/u)
  assertCommandFlags(handoff.run, "node scripts/release/workflow-handoff.mjs", [
    "--report",
    "--root",
    "--output",
  ])
  const prepareStep = onlyRunStepMatching(prepare, /node scripts\/release\/cli\.mjs prepare\b/u)
  assert.ok(prepare.steps.indexOf(handoff) < prepare.steps.indexOf(prepareStep))
  assertCommandFlags(prepareStep.run, "node scripts/release/cli.mjs prepare", [
    "--handoff",
    "--root",
    "--output-dir",
    "--candidate-output",
  ])

  const uploads = prepare.steps.filter((step) => step.uses === ACTIONS.upload)
  assert.equal(uploads.length, 2, "prepare must upload payload and handoff separately")
  const payload = uploads.find((step) => step.id === "payload")
  const handoffUpload = uploads.find((step) => step.id === "handoff")
  assert.ok(payload, "prepare must expose the immutable payload upload")
  assert.ok(handoffUpload, "prepare must expose the small handoff upload")
  assert.equal(payload.id, "payload")
  assert.equal(payload.with?.["if-no-files-found"], "error")
  assert.equal(payload.with?.overwrite, false)
  const record = onlyRunStepMatching(prepare, /node scripts\/release\/cli\.mjs record-artifact\b/u)
  assertCommandFlags(record.run, "node scripts/release/cli.mjs record-artifact", [
    "--candidate",
    "--manifest",
    "--artifact-upload-result",
    "--output",
  ])
  assert.match(record.run, /steps\.payload\.outputs\.artifact-id/u)
  assert.match(record.run, /steps\.payload\.outputs\.artifact-url/u)
  assert.match(record.run, /steps\.payload\.outputs\.artifact-digest/u)
  assert.doesNotMatch(record.run, /steps\.payload\.outputs\.artifact-name/u)
  assert.deepEqual(workflowArtifactBasenames(handoffUpload.with?.path), ["release-record.json"])
  assert.equal(handoffUpload.with?.name, workflowExpression("steps.identity.outputs.handoff_name"))
  const identity = onlyRunStepMatching(prepare, /handoff_name=release-record-v/u)
  assert.match(identity.run, /j\.version/u)
  assert.match(identity.run, /j\.commitSha\.slice\(0,12\)/u)
  assert.equal(handoffUpload.with?.["if-no-files-found"], "error")
  assert.equal(handoffUpload.with?.overwrite, false)
  assert.ok(prepare.steps.indexOf(prepareStep) < prepare.steps.indexOf(payload))
  assert.ok(prepare.steps.indexOf(payload) < prepare.steps.indexOf(record))
  assert.ok(prepare.steps.indexOf(record) < prepare.steps.indexOf(handoffUpload))

  const recovery = onlyRunStepMatching(hydrate, /node scripts\/release\/workflow-recovery\.mjs\b/u)
  assertCommandFlags(recovery.run, "node scripts/release/workflow-recovery.mjs", [
    "--report",
    "--output-dir",
  ])
  const resolver = onlyRunStepMatching(
    hydrate,
    /node scripts\/release\/artifact-store\.mjs resolve\b/u,
  )
  assertCommandFlags(resolver.run, "node scripts/release/artifact-store.mjs resolve", [
    "--record",
    "--output-dir",
  ])
  assert.match(resolver.if, /next_transition != 'attest-artifacts'/u)
  const recoveredIdentity = onlyRunStepMatching(hydrate, /actionsArtifact\.id/u)
  assert.equal(recoveredIdentity.id, "recovered-artifact")
  assert.match(recoveredIdentity.run, /actionsArtifact\.prepareRunId/u)
  assert.equal(
    recoveredIdentity.if,
    workflowExpression("needs.detect.outputs.next_transition == 'attest-artifacts'"),
  )
  const preparedDownload = hydrate.steps.find(
    (step) =>
      step.uses === ACTIONS.download &&
      step.with?.["artifact-ids"] ===
        workflowExpression("steps.recovered-artifact.outputs.artifact_id"),
  )
  assert.ok(preparedDownload)
  assert.equal(
    preparedDownload.if,
    workflowExpression("needs.detect.outputs.next_transition == 'attest-artifacts'"),
  )
  assert.equal(preparedDownload.with?.["github-token"], workflowExpression("github.token"))
  assert.equal(
    preparedDownload.with?.["run-id"],
    workflowExpression("steps.recovered-artifact.outputs.prepare_run_id"),
  )
  assert.equal(preparedDownload.with?.path, `${workflowExpression("runner.temp")}/runtime/payload`)
  assert.match(hydrate.if, /next_transition/u)
  assert.match(hydrate.if, /prepare-artifacts/u)
  assert.match(hydrate.if, /publish-github-release/u)

  onlyStepUsing(attest, ACTIONS.attest)
  const escrowStep = onlyRunStepMatching(escrow, /node scripts\/release\/cli\.mjs escrow\b/u)
  assertCommandFlags(escrowStep.run, "node scripts/release/cli.mjs escrow", [
    "--candidate",
    "--record",
    "--artifact-dir",
    "--attestation-set",
    "--attestation-bundles-dir",
  ])
  assert.equal(countMatches(source, /node scripts\/release\/cli\.mjs escrow\b/gu), 1)
  assert.doesNotMatch(source, /gh\s+release\s+(?:create|upload|edit)|target_commitish/iu)
})

test("publish-npm is exact-tag, sparse, dependency-free, and schema-bound", async () => {
  const { workflow } = await readRequiredWorkflow("release.yml")
  const schema = JSON.parse(await readBoundedFixture(CONTROLLER_SCHEMA_PATH, { root: ROOT }))
  const publish = requiredJob(workflow, "publish-npm")
  assert.deepEqual(normalizeNeeds(publish.needs), ["detect", "escrow", "hydrate", "tag"])
  assertReadOrWritePermissions(publish.permissions, {
    actions: "read",
    attestations: "read",
    contents: "read",
    "id-token": "write",
  })
  if (schema.npmTrustedPublisherEnvironment === null) {
    assert.equal(publish.environment, undefined)
  } else {
    assert.equal(publish.environment, schema.npmTrustedPublisherEnvironment)
  }

  const checkout = onlyStepUsing(publish, ACTIONS.checkout)
  assert.equal(checkout.with?.ref, workflowExpression("needs.detect.outputs.candidate_sha"))
  assert.equal(checkout.with?.["persist-credentials"], false)
  assert.equal(checkout.with?.["sparse-checkout-cone-mode"], false)
  const sparseFiles = String(checkout.with?.["sparse-checkout"] ?? "")
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort()
  assert.deepEqual(
    sparseFiles,
    [...new Set([...ARTIFACT_STORE_SPARSE_FILES, ...PUBLISHER_SPARSE_FILES])].sort(),
  )
  assert.equal(
    sparseFiles.some((file) => /(?:^|\/)cli\.mjs$|package\.json|pnpm-lock|packages\//u.test(file)),
    false,
  )

  const publisher = onlyRunStepMatching(publish, /node scripts\/release\/publisher\.mjs\b/u)
  const runtime = onlyStepUsing(publish, ACTIONS.download)
  assert.match(String(runtime.with?.["artifact-ids"]), /needs\.hydrate\.outputs\.artifact_id/u)
  assert.ok(publish.steps.indexOf(runtime) < publish.steps.indexOf(publisher))
  assertCommandFlags(publisher.run, "node scripts/release/publisher.mjs", [
    "--candidate",
    "--record",
    "--artifact-dir",
    "--report",
    "--github-output",
  ])
  const runs = runSource(publish)
  assert.doesNotMatch(
    runs,
    /(?:pnpm|npm|yarn)\s+(?:install|ci)|\b(?:build|test|pack)\b|node_modules|packages\//iu,
  )
  assert.doesNotMatch(runs, /cli\.mjs|npm\s+publish/iu, "publisher.mjs owns the only npm mutation")
})

test("npm reconciliation and five controller-owned smoke lanes are separate and fail closed", async () => {
  const { workflow } = await readRequiredWorkflow("release.yml")
  assert.deepEqual(REQUIRED_RELEASE_SMOKE_LANES, [
    "metadata",
    "published-harness",
    "runtime-targets",
    "scaffold",
    "storage",
  ])

  const reconcileNpm = requiredJob(workflow, "reconcile-npm")
  assert.deepEqual(normalizeNeeds(reconcileNpm.needs), ["detect", "hydrate", "publish-npm", "tag"])
  assert.equal(reconcileNpm.permissions?.contents, "write")
  assert.equal(reconcileNpm.permissions?.actions, "read")
  onlyRunStepMatching(reconcileNpm, /node scripts\/release\/cli\.mjs reconcile-npm\b/u)

  for (const lane of REQUIRED_RELEASE_SMOKE_LANES) {
    const id = SMOKE_JOB_BY_LANE[lane]
    const smoke = requiredJob(workflow, id)
    assert.deepEqual(normalizeNeeds(smoke.needs), ["detect", "hydrate", "reconcile-npm", "tag"])
    assertNoWriteOrOidc(smoke)
    assert.equal(smoke["runs-on"], "ubuntu-24.04")
    const entrypoint =
      lane === "metadata"
        ? /node scripts\/published-artifact-verify\.mjs\b[\s\S]*--release-mode\b/u
        : new RegExp(`node scripts/release/smoke/${escapeRegExp(lane)}\\.mjs\\b`, "u")
    const execute = onlyRunStepMatching(smoke, entrypoint)
    assertCommandHasFlag(execute.run, "--result")
    const upload = onlyStepUsing(smoke, ACTIONS.upload)
    assert.equal(upload.id, "result")
    assert.equal(upload.if, workflowExpression("always()"))
    assert.equal(
      upload.with?.name,
      `smoke-result-${lane}-${workflowExpression("github.run_id")}-${workflowExpression("github.run_attempt")}`,
    )
    assert.equal(upload.with?.["if-no-files-found"], "error")
    assert.deepEqual(smoke.outputs, {
      artifact_id: workflowExpression(`steps.result.outputs.artifact-id`),
    })
  }

  const reconcile = requiredJob(workflow, "reconcile-smokes")
  assert.deepEqual(
    normalizeNeeds(reconcile.needs),
    [
      "detect",
      "hydrate",
      "publish-npm",
      "reconcile-npm",
      "tag",
      ...Object.values(SMOKE_JOB_BY_LANE),
    ].sort(),
  )
  assert.equal(reconcile.permissions?.contents, "write")
  assert.equal(reconcile.permissions?.actions, "read")
  assert.match(reconcile.if, /always\(\)/u)
  for (const id of Object.values(SMOKE_JOB_BY_LANE)) {
    assert.match(reconcile.if, new RegExp(`needs\\.${escapeRegExp(id)}\\.result == 'success'`, "u"))
  }
  const download = reconcile.steps.find(
    (step) => step.uses === ACTIONS.download && step.with?.["merge-multiple"] === true,
  )
  assert.ok(download, "smoke reconciliation must merge the exact five result artifacts")
  const artifactIds = String(download.with?.["artifact-ids"] ?? "")
  for (const id of Object.values(SMOKE_JOB_BY_LANE)) {
    assert.match(
      artifactIds,
      new RegExp(`needs\\.${escapeRegExp(id)}\\.outputs\\.artifact_id`, "u"),
    )
  }
  assert.equal(download.with?.["merge-multiple"], true)
  const command = onlyRunStepMatching(
    reconcile,
    /node scripts\/release\/cli\.mjs reconcile-smokes\b/u,
  )
  assertCommandHasFlag(command.run, "--smoke-results")
  assert.doesNotMatch(command.run, /required-lanes|lane-set/iu)
})

test("audit dispatch, receipt recording, correlation, and immutable publication stay split", async () => {
  const { source, workflow } = await readRequiredWorkflow("release.yml")
  const dispatch = requiredJob(workflow, "dispatch-audit")
  const record = requiredJob(workflow, "record-audit-dispatch")
  const correlate = requiredJob(workflow, "correlate-audit")
  const publish = requiredJob(workflow, "publish-release")
  assert.deepEqual(normalizeNeeds(dispatch.needs), ["detect", "hydrate", "reconcile-smokes", "tag"])
  assert.equal(dispatch.permissions?.actions, "write")
  assert.notEqual(dispatch.permissions?.contents, "write")
  const dispatchStep = onlyRunStepMatching(
    dispatch,
    /node scripts\/release\/cli\.mjs dispatch-audit\b/u,
  )
  assertCommandFlags(dispatchStep.run, "node scripts/release/cli.mjs dispatch-audit", [
    "--version",
    "--commit-sha",
    "--manifest-sha256",
    "--output",
  ])
  assert.doesNotMatch(dispatchStep.run, /return_run_details|list.*runs|runs\/\?/iu)

  assert.deepEqual(normalizeNeeds(record.needs), ["detect", "dispatch-audit", "hydrate", "tag"])
  assert.equal(record.permissions?.contents, "write")
  assert.notEqual(record.permissions?.actions, "write")
  onlyRunStepMatching(record, /node scripts\/release\/cli\.mjs record-audit-dispatch\b/u)

  assert.deepEqual(normalizeNeeds(correlate.needs), [
    "detect",
    "hydrate",
    "record-audit-dispatch",
    "tag",
  ])
  assert.equal(correlate.permissions?.actions, "read")
  assert.equal(correlate.permissions?.contents, "write")
  onlyRunStepMatching(correlate, /node scripts\/release\/cli\.mjs wait-audit\b/u)
  onlyRunStepMatching(correlate, /node scripts\/release\/cli\.mjs correlate-audit\b/u)

  assert.deepEqual(normalizeNeeds(publish.needs), ["correlate-audit", "detect", "hydrate", "tag"])
  assert.equal(publish.permissions?.contents, "write")
  assert.notEqual(publish.permissions?.actions, "write")
  const publishStep = onlyRunStepMatching(
    publish,
    /node scripts\/release\/cli\.mjs publish-release\b/u,
  )
  assertCommandFlags(publishStep.run, "node scripts/release/cli.mjs publish-release", [
    "--candidate",
    "--record",
    "--audit-result",
  ])
  const closure = transitiveNeeds(workflow, "publish-release")
  for (const id of Object.values(SMOKE_JOB_BY_LANE)) assert.ok(closure.has(id), id)
  assert.ok(closure.has("dispatch-audit"))
  assert.ok(closure.has("record-audit-dispatch"))
  assert.ok(closure.has("correlate-audit"))
  assert.equal(
    Object.entries(workflow.jobs).some(
      ([id, job]) =>
        id !== "publish-release" && normalizeNeeds(job.needs).includes("publish-release"),
    ),
    false,
    "no post-publication job may receive mutation authority",
  )
  assert.equal(countMatches(source, /node scripts\/release\/cli\.mjs publish-release\b/gu), 1)
  assert.doesNotMatch(source, /gh\s+release\s+edit|target_commitish|"draft"\s*:\s*false/iu)
})

test("release.yml makes workflow abandonment unreachable", async () => {
  const { source, workflow } = await readRequiredWorkflow("release.yml")
  const schema = JSON.parse(await readBoundedFixture(CONTROLLER_SCHEMA_PATH, { root: ROOT }))
  assert.equal(schema.abandonmentEnvironment, "release-abandonment")
  const liveBytes = await readFile(path.join(WORKFLOWS, "release.yml"))
  const disabledBytes = await readFile(
    path.join(ROOT, "scripts/release/test/fixtures/release-workflow-disabled.yml"),
  )
  assert.deepEqual(liveBytes, disabledBytes)
  assert.equal(
    classifyReleaseWorkflowAbandonment(liveBytes, {
      abandonmentEnvironment: schema.abandonmentEnvironment,
    }),
    "disabled",
  )
  assert.equal(workflow.jobs.abandon, undefined)
  assert.equal(
    Object.values(workflow.jobs).some((job) => job.environment === schema.abandonmentEnvironment),
    false,
  )
  assert.equal(
    workflowExecutables(workflow).some(({ value }) =>
      /node scripts\/release\/cli\.mjs (?:abandonment-context|abandon)\b/u.test(value),
    ),
    false,
  )
  assert.doesNotMatch(source, /inputs\.reason|Validate manual intent|release-abandonment/u)
  assert.doesNotMatch(source, /abandonment must be dispatched|inputs\.operation == 'abandon'/u)
})

test("the independent workflow relays default-branch audits and verifies exact tags in isolated modes", async () => {
  const { source, workflow } = await readRequiredWorkflow("published-artifact-verify.yml")
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"])
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), [
    "commitSha",
    "manifestSha256",
    "version",
  ])
  for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) {
    assertDispatchIdentityInput(input)
  }
  assert.equal(hasWritePermission(workflow.permissions), false)

  const coordinator = requiredJob(workflow, "coordinate")
  assert.equal(coordinator.permissions?.actions, "write")
  assert.notEqual(coordinator.permissions?.contents, "write")
  assert.match(coordinator.if, /github\.event\.repository\.default_branch/u)
  const coordinatorCheckout = onlyStepUsing(coordinator, ACTIONS.checkout)
  assert.equal(
    coordinatorCheckout.with?.ref,
    workflowExpression("github.event.repository.default_branch"),
  )
  assert.equal(coordinatorCheckout.with?.["persist-credentials"], false)
  const relay = onlyRunStepMatching(
    coordinator,
    /node scripts\/release\/independent-audit-coordinator\.mjs\b/u,
  )
  assertCommandFlags(relay.run, "node scripts/release/independent-audit-coordinator.mjs", [
    "--github-output",
  ])
  assert.doesNotMatch(relay.run, /return_run_details|list.*runs|runs\/\?|poll|wait|sleep/iu)

  const draft = requiredJob(workflow, "verify-draft")
  assert.equal(draft.name, "verify")
  assert.deepEqual(normalizeNeeds(draft.needs), ["coordinate"])
  assert.equal(hasWritePermission(draft.permissions), false)
  assert.equal(draft.permissions?.checks, "read")
  assertExactIndependentTagGate(draft, "draft")
  const checkout = onlyStepUsing(draft, ACTIONS.checkout)
  assert.equal(checkout.with?.ref, workflowExpression("github.ref"))
  assert.equal(checkout.with?.["fetch-depth"], 0)
  assert.equal(checkout.with?.["persist-credentials"], false)
  const draftPnpm = onlyStepUsing(draft, ACTIONS.pnpm)
  assert.deepEqual(draftPnpm.with, { version: "10.33.0" })
  const draftNode = onlyStepUsing(draft, ACTIONS.node)
  const draftNpm = onlyRunStepMatching(draft, /^test "\$\(npm --version\)" = "11\.17\.0"$/u)
  const draftInstall = onlyRunStepMatching(
    draft,
    /^"\$PNPM_HOME\/pnpm" install --filter \. --frozen-lockfile --ignore-scripts$/u,
  )
  const execute = onlyRunStepMatching(draft, /node scripts\/release\/independent-audit\.mjs\b/u)
  assert.deepEqual(
    [checkout, draftPnpm, draftNode, draftNpm, draftInstall, execute].map((step) =>
      draft.steps.indexOf(step),
    ),
    [0, 1, 2, 3, 4, 5],
  )
  assertCommandFlags(execute.run, "node scripts/release/independent-audit.mjs", [
    "--version",
    "--commit-sha",
    "--manifest-sha256",
    "--result",
  ])
  const resultUploads = draft.steps.filter((step) => step.uses === ACTIONS.upload)
  assert.equal(resultUploads.length, 1)
  assert.equal(resultUploads[0].id, "result")
  assert.equal(resultUploads[0].if, workflowExpression("always()"))
  assert.equal(
    resultUploads[0].with?.name,
    `audit-result-${workflowExpression("github.run_id")}-${workflowExpression("github.run_attempt")}`,
  )
  assert.equal(resultUploads[0].with?.["if-no-files-found"], "error")

  const published = requiredJob(workflow, "verify-published")
  assert.deepEqual(normalizeNeeds(published.needs), ["coordinate"])
  assert.equal(hasWritePermission(published.permissions), false)
  assert.equal(published.permissions?.checks, "read")
  assertExactIndependentTagGate(published, "published")
  const publishedCheckout = onlyStepUsing(published, ACTIONS.checkout)
  assert.equal(publishedCheckout.with?.ref, workflowExpression("github.ref"))
  assert.equal(publishedCheckout.with?.["fetch-depth"], 0)
  assert.equal(publishedCheckout.with?.["persist-credentials"], false)
  const publishedPnpm = onlyStepUsing(published, ACTIONS.pnpm)
  assert.deepEqual(publishedPnpm.with, { version: "10.33.0" })
  const publishedNode = onlyStepUsing(published, ACTIONS.node)
  const publishedNpm = onlyRunStepMatching(published, /^test "\$\(npm --version\)" = "11\.17\.0"$/u)
  const publishedInstall = onlyRunStepMatching(
    published,
    /^"\$PNPM_HOME\/pnpm" install --filter \. --frozen-lockfile --ignore-scripts$/u,
  )
  const publishedExecute = onlyRunStepMatching(
    published,
    /node scripts\/release\/post-publication-audit\.mjs\b/u,
  )
  assert.deepEqual(
    [
      publishedCheckout,
      publishedPnpm,
      publishedNode,
      publishedNpm,
      publishedInstall,
      publishedExecute,
    ].map((step) => published.steps.indexOf(step)),
    [0, 1, 2, 3, 4, 5],
  )
  assertCommandFlags(publishedExecute.run, "node scripts/release/post-publication-audit.mjs", [
    "--version",
    "--commit-sha",
    "--manifest-sha256",
    "--result",
  ])
  const publishedUploads = published.steps.filter((step) => step.uses === ACTIONS.upload)
  assert.equal(publishedUploads.length, 1)
  assert.equal(publishedUploads[0].if, workflowExpression("always()"))
  assert.doesNotMatch(
    source,
    /runOpenAI|runPgvector|packageSet|return_run_details|list.*workflow.*runs/iu,
  )
  assert.doesNotMatch(source, /contents\s*:\s*write|gh\s+release|\/releases\/.+(?:PATCH|DELETE)/iu)
})

test("release.yml is the only trusted npm publisher and chart publication remains separate", async () => {
  const sources = await readWorkflowSourcesFromRoot(ROOT)
  const owners = []
  for (const [file, source] of Object.entries(sources)) {
    if (/publisher\.mjs|npm\s+publish|NPM_CONFIG_PROVENANCE|registry-url/iu.test(source)) {
      owners.push(file)
    }
  }
  assert.deepEqual(owners, ["release.yml"])
  const version = parseWorkflowSource(sources["version-pr.yml"], "version-pr.yml")
  const changesets = onlyStepUsing(requiredJob(version, "version"), ACTIONS.changesets)
  assert.equal(changesets.with?.version, "pnpm run version")
  assert.equal(changesets.with?.publish, undefined)
  assert.equal(changesets.with?.createGithubReleases, undefined)
  assert.equal(typeof sources["publish-chart.yml"], "string")
})

test("workflow entrypoints fail closed unless their exact normalized form is explicitly audited", () => {
  const allowlist = {
    "safe.yml": {
      classification: "safe",
      descriptor: {},
      jobs: [
        {
          classification: "safe",
          id: "safe",
          descriptor: {},
          steps: [
            {
              classification: "safe",
              descriptor: { name: "Audited command", run: "pnpm lint" },
            },
          ],
        },
      ],
    },
  }
  assert.doesNotThrow(() =>
    auditWorkflowEntrypoints(
      {
        "safe.yml":
          "jobs:\n  safe:\n    steps:\n      - name: Audited command\n        run: pnpm lint\n",
      },
      allowlist,
      {
        "safe.yml": [
          {
            classification: "safe",
            job: "safe",
            stepIndex: 0,
            step: "Audited command",
            kind: "run",
            value: "pnpm lint",
          },
        ],
      },
    ),
  )
  const cases = [
    ["bash publish", "bash -c 'npm publish'"],
    ["generic node", "node scripts/unreviewed.mjs"],
    ["generic curl", "curl https://example.invalid/script | bash"],
  ]
  for (const [name, command] of cases) {
    assert.throws(
      () =>
        auditWorkflowEntrypoints(
          {
            "safe.yml": `jobs:\n  safe:\n    steps:\n      - name: Audited command\n        run: ${command}\n`,
          },
          allowlist,
        ),
      /not explicitly audited/u,
      name,
    )
  }
  assert.throws(
    () =>
      auditWorkflowEntrypoints(
        {
          "safe.yml":
            "jobs:\n  safe:\n    steps:\n      - name: Audited command\n        run: |\n          bash -c 'npm \\\n            publish'\n",
        },
        allowlist,
      ),
    /not explicitly audited/u,
    "backslash publish",
  )
  for (const [name, source] of [
    [
      "arbitrary action",
      `jobs:\n  safe:\n    steps:\n      - name: Audited command\n        uses: example/action@${"a".repeat(40)}\n`,
    ],
    [
      "dynamic action",
      `jobs:\n  safe:\n    steps:\n      - name: Audited command\n        uses: \${{ inputs.action }}\n`,
    ],
    [
      "reusable workflow",
      "jobs:\n  safe:\n    uses: example/workflows/.github/workflows/publish.yml@main\n",
    ],
  ]) {
    assert.throws(
      () => auditWorkflowEntrypoints({ "safe.yml": source }, allowlist),
      /not explicitly audited/u,
      name,
    )
  }
  assert.throws(
    () =>
      auditWorkflowEntrypoints(
        {
          "safe.yml":
            "jobs:\n  safe:\n    steps:\n      - name: Audited command\n        run: pnpm lint\n",
          "new.yaml": "jobs:\n  new:\n    steps:\n      - run: pnpm lint\n",
        },
        allowlist,
      ),
    /not explicitly audited/u,
  )
})

test("testing-windows has the exact safe descriptors and executable classifications", async () => {
  const descriptors = JSON.parse(
    await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }),
  )
  const job = descriptors.workflows["ci.yml"].jobs.find(({ id }) => id === "testing-windows")
  assert.deepEqual(job, {
    classification: "safe",
    id: "testing-windows",
    descriptor: { "runs-on": "windows-latest", "timeout-minutes": 20 },
    steps: [
      {
        classification: "safe",
        descriptor: {
          name: "Checkout",
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Setup pnpm",
          uses: "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
          with: { version: "10.33.0" },
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Setup Node.js",
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          with: { "node-version": "24.17.0", cache: "pnpm" },
        },
      },
      {
        classification: "safe",
        descriptor: { name: "Install", run: "pnpm install --frozen-lockfile" },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Build testing dependency closure",
          run: "pnpm --filter @dawn-ai/testing... build",
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Native Windows subprocess shutdown tests",
          run: 'pnpm --filter @dawn-ai/testing exec vitest --run --config vitest.config.ts test/subprocess.test.ts --testNamePattern "Windows process tree|injected Windows tree kill"',
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Dependency security regressions",
          run: "pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts test/security-dependencies/hono-serve-static-windows.test.ts",
        },
      },
    ],
  })
  assert.deepEqual(
    EXECUTABLE_ALLOWLIST.workflows["ci.yml"].filter(({ job }) => job === "testing-windows"),
    job.steps.map(({ descriptor }, stepIndex) => ({
      classification: "safe",
      job: "testing-windows",
      stepIndex,
      step: descriptor.name,
      kind: descriptor.run === undefined ? "step-uses" : "run",
      value: descriptor.run ?? descriptor.uses,
    })),
  )

  const sources = await readWorkflowSourcesFromRoot(ROOT)
  const mutated = sources["ci.yml"].replace(
    "pnpm --filter @dawn-ai/testing... build",
    "pnpm --filter @dawn-ai/testing... build && echo bypass",
  )
  assert.throws(
    () => auditWorkflowEntrypoints({ ...sources, "ci.yml": mutated }, descriptors.workflows),
    /not explicitly audited/u,
  )
})

test("dependency-security-browser has one exact isolated read-only descriptor", async () => {
  const descriptors = JSON.parse(
    await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }),
  )
  const job = descriptors.workflows["ci.yml"].jobs.find(
    ({ id }) => id === "dependency-security-browser",
  )
  assert.deepEqual(job, {
    classification: "safe",
    id: "dependency-security-browser",
    descriptor: {
      permissions: { contents: "read" },
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
    },
    steps: [
      {
        classification: "safe",
        descriptor: {
          name: "Checkout",
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Setup pnpm",
          uses: "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
          with: { version: "10.33.0" },
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Setup Node.js",
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          with: { "node-version": "24.17.0", cache: "pnpm" },
        },
      },
      {
        classification: "safe",
        descriptor: { name: "Install", run: "pnpm install --frozen-lockfile" },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Install Chromium",
          run: "pnpm exec playwright install --with-deps chromium",
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Dependency security browser regressions",
          run: "pnpm exec tsc -p test/security-dependencies/tsconfig.json --noEmit\npnpm exec playwright test --config test/security-dependencies/playwright.config.ts\n",
        },
      },
    ],
  })
  assert.deepEqual(
    EXECUTABLE_ALLOWLIST.workflows["ci.yml"].filter(
      ({ job: executableJob }) => executableJob === "dependency-security-browser",
    ),
    job.steps.map(({ descriptor }, stepIndex) => ({
      classification: "safe",
      job: "dependency-security-browser",
      stepIndex,
      step: descriptor.name,
      kind: descriptor.run === undefined ? "step-uses" : "run",
      value: descriptor.run ?? descriptor.uses,
    })),
  )
})

test("dependency security receipt uploader is exact, offline, read-only, and write-once", async () => {
  const source = await readBoundedFixture(path.join(WORKFLOWS, "dependency-security-receipt.yml"), {
    root: ROOT,
  })
  const workflow = parse(source, { maxAliasCount: 0, uniqueKeys: true })
  const expectedMainInput = workflowExpression("inputs.expectedMainSha")
  const expectedPrInput = workflowExpression("inputs.expectedPrNumber")
  const expectedReviewedBaseInput = workflowExpression("inputs.expectedReviewedBaseSha")
  const expectedReviewedHeadInput = workflowExpression("inputs.expectedReviewedHeadSha")
  const expectedMergeInput = workflowExpression("inputs.expectedMergeSha")
  const receiptGzipBase64Input = workflowExpression("inputs.receiptGzipBase64")
  const receiptSha256Input = workflowExpression("inputs.receiptSha256")
  const runnerTemp = workflowExpression("runner.temp")
  const githubToken = workflowExpression("github.token")

  assert.deepEqual(Object.keys(workflow).sort(), ["jobs", "name", "on", "run-name"])
  assert.equal(workflow.name, "Dependency Security Receipt")
  assert.equal(workflow["run-name"], `Dependency security receipt ${receiptSha256Input}`)
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"])
  const inputs = workflow.on.workflow_dispatch.inputs
  assert.deepEqual(Object.keys(inputs), [
    "expectedMainSha",
    "expectedPrNumber",
    "expectedReviewedBaseSha",
    "expectedReviewedHeadSha",
    "expectedMergeSha",
    "receiptGzipBase64",
    "receiptSha256",
  ])
  for (const input of Object.values(inputs)) {
    assert.equal(input.required, true)
    assert.equal(input.type, "string")
    assert.deepEqual(Object.keys(input).sort(), ["description", "required", "type"])
  }

  assert.deepEqual(Object.keys(workflow.jobs), ["upload"])
  const job = workflow.jobs.upload
  assert.deepEqual(job.permissions, { contents: "read" })
  assert.equal(job["runs-on"], "ubuntu-latest")
  assert.equal(job["timeout-minutes"], 10)
  assert.equal(job.environment, undefined)
  assert.equal(job.secrets, undefined)
  assert.equal(job.env, undefined)
  assert.deepEqual(
    job.steps.map(({ name }) => name),
    [
      "Validate receipt correlation inputs",
      "Checkout exact observation",
      "Setup Node.js",
      "Require unchanged default branch head",
      "Prepare sealed receipt directory",
      "Seal canonical receipt",
      "Upload sealed receipt",
    ],
  )

  const [validate, checkout, setupNode, requireHead, prepare, seal, upload] = job.steps
  assert.match(validate.run, /\^\[0-9a-f\]\{40\}\$/u)
  assert.match(validate.run, /\^\[1-9\]\[0-9\]\{0,14\}\$/u)
  assert.match(validate.run, /\^\[0-9a-f\]\{64\}\$/u)
  assert.deepEqual(checkout, {
    name: "Checkout exact observation",
    uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    with: {
      ref: expectedMainInput,
      "persist-credentials": false,
    },
  })
  assert.deepEqual(setupNode, {
    name: "Setup Node.js",
    uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    with: { "node-version": "24.17.0" },
  })
  assert.deepEqual(requireHead.env, {
    EXPECTED_MAIN_SHA: expectedMainInput,
    GH_TOKEN: githubToken,
  })
  assert.match(requireHead.run, /GITHUB_SHA/u)
  assert.match(requireHead.run, /repos\/cacheplane\/dawnai\/git\/ref\/heads\/main/u)
  assert.deepEqual(prepare.env, {
    RECEIPT_OUTPUT_ROOT: `${runnerTemp}/dependency-security-receipt-root`,
  })
  assert.equal(prepare.run, 'install -d -m 0700 -- "$RECEIPT_OUTPUT_ROOT"')
  assert.deepEqual(seal.env, {
    EXPECTED_MAIN_SHA: expectedMainInput,
    EXPECTED_PR_NUMBER: expectedPrInput,
    EXPECTED_REVIEWED_BASE_SHA: expectedReviewedBaseInput,
    EXPECTED_REVIEWED_HEAD_SHA: expectedReviewedHeadInput,
    EXPECTED_MERGE_SHA: expectedMergeInput,
    RECEIPT_GZIP_BASE64: receiptGzipBase64Input,
    RECEIPT_SHA256: receiptSha256Input,
    RECEIPT_OUTPUT_ROOT: `${runnerTemp}/dependency-security-receipt-root`,
    RECEIPT_OUTPUT_DIRECTORY: `${runnerTemp}/dependency-security-receipt-root/sealed`,
  })
  assert.equal(
    seal.run,
    'node scripts/security/dependency-evidence.mjs seal-receipt \\\n  --expected-main-sha "$EXPECTED_MAIN_SHA" \\\n  --expected-pr-number "$EXPECTED_PR_NUMBER" \\\n  --expected-reviewed-base-sha "$EXPECTED_REVIEWED_BASE_SHA" \\\n  --expected-reviewed-head-sha "$EXPECTED_REVIEWED_HEAD_SHA" \\\n  --expected-merge-sha "$EXPECTED_MERGE_SHA" \\\n  --receipt-gzip-base64 "$RECEIPT_GZIP_BASE64" \\\n  --receipt-sha256 "$RECEIPT_SHA256" \\\n  --output-root "$RECEIPT_OUTPUT_ROOT" \\\n  --output-directory "$RECEIPT_OUTPUT_DIRECTORY"\n',
  )
  assert.deepEqual(upload, {
    name: "Upload sealed receipt",
    uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    with: {
      name: `dependency-security-receipt-${expectedMainInput}-${receiptSha256Input}`,
      path: `${runnerTemp}/dependency-security-receipt-root/sealed/dependency-security-reconciliation.json\n${runnerTemp}/dependency-security-receipt-root/sealed/uploader-manifest.json\n`,
      "if-no-files-found": "error",
      "retention-days": 90,
    },
  })

  const actionSteps = job.steps.filter(({ uses }) => uses !== undefined)
  assert.deepEqual(
    actionSteps.map(({ uses }) => uses),
    [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    ],
  )
  for (const step of job.steps) {
    assert.equal(step.env?.GH_TOKEN, step === requireHead ? githubToken : undefined)
  }
  const runs = job.steps
    .filter(({ run }) => run !== undefined)
    .map(({ run }) => run)
    .join("\n")
  assert.doesNotMatch(runs, /(?:npm|pnpm)\s+install/u)
  assert.doesNotMatch(source, /secrets\.|id-token\s*:\s*write|contents\s*:\s*write/iu)
})

test("dependency security workflow mutations fail closed", async (t) => {
  const descriptors = JSON.parse(
    await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }),
  )
  const sources = await readWorkflowSourcesFromRoot(ROOT)
  const mutateBrowser = (source, mutate) => {
    const start = source.indexOf("  dependency-security-browser:\n")
    const end = source.indexOf("\n  sandbox-docker:\n", start)
    assert.notEqual(start, -1)
    assert.notEqual(end, -1)
    return `${source.slice(0, start)}${mutate(source.slice(start, end))}${source.slice(end)}`
  }
  const cases = [
    [
      "browser permissions",
      "ci.yml",
      (source) => mutateBrowser(source, (job) => job.replace("contents: read", "contents: write")),
    ],
    [
      "browser path",
      "ci.yml",
      (source) =>
        mutateBrowser(source, (job) =>
          job.replace(
            "test/security-dependencies/playwright.config.ts",
            "test/security-dependencies/vitest.config.ts",
          ),
        ),
    ],
    [
      "browser shell operator",
      "ci.yml",
      (source) =>
        mutateBrowser(source, (job) =>
          job.replace(
            "pnpm exec playwright install --with-deps chromium",
            "pnpm exec playwright install --with-deps chromium && echo bypass",
          ),
        ),
    ],
    [
      "broadened Windows test command",
      "ci.yml",
      (source) =>
        source.replace(
          "test/security-dependencies/dependency-resolution.test.ts test/security-dependencies/hono-serve-static-windows.test.ts",
          "test/security-dependencies",
        ),
    ],
    [
      "browser install without frozen lockfile",
      "ci.yml",
      (source) =>
        mutateBrowser(source, (job) =>
          job.replace("pnpm install --frozen-lockfile", "pnpm install"),
        ),
    ],
    [
      "receipt trigger expansion",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "  workflow_dispatch:\n",
          '  schedule:\n    - cron: "0 0 * * *"\n  workflow_dispatch:\n',
        ),
    ],
    [
      "receipt pull-request trigger",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace("  workflow_dispatch:\n", "  pull_request:\n  workflow_dispatch:\n"),
    ],
    [
      "receipt input removal",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "      receiptSha256:\n        description: SHA-256 of the canonical reconciliation receipt\n        required: true\n        type: string\n",
          "",
        ),
    ],
    [
      "receipt input expansion",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "      expectedMainSha:\n",
          "      command:\n        description: Unsafe dynamic command\n        required: true\n        type: string\n      expectedMainSha:\n",
        ),
    ],
    [
      "receipt permission expansion",
      "dependency-security-receipt.yml",
      (source) => source.replace("      contents: read", "      contents: write"),
    ],
    [
      "receipt OIDC permission",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace("      contents: read", "      contents: read\n      id-token: write"),
    ],
    [
      "receipt secret access",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          `          RECEIPT_SHA256: ${workflowExpression("inputs.receiptSha256")}\n        run:`,
          `          RECEIPT_SHA256: ${workflowExpression("inputs.receiptSha256")}\n          UNSAFE_SECRET: ${workflowExpression("secrets.UNSAFE")}\n        run:`,
        ),
    ],
    [
      "unpinned receipt action",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "uses: actions/checkout@v7",
        ),
    ],
    [
      "dynamic receipt action",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          `uses: ${workflowExpression("inputs.action")}`,
        ),
    ],
    [
      "persisted checkout credentials",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "          persist-credentials: false",
          "          persist-credentials: true",
        ),
    ],
    [
      "receipt dependency installation",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "      - name: Setup Node.js\n",
          "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n\n      - name: Setup Node.js\n",
        ),
    ],
    [
      "dynamic receipt command",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "node scripts/security/dependency-evidence.mjs seal-receipt",
          `node "${workflowExpression("inputs.command")}" seal-receipt`,
        ),
    ],
    [
      "default branch head drift",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "repos/cacheplane/dawnai/git/ref/heads/main",
          "repos/cacheplane/dawnai/git/ref/heads/reviewed-head",
        ),
    ],
    [
      "extra receipt archive file",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          `            ${workflowExpression("runner.temp")}/dependency-security-receipt-root/sealed/uploader-manifest.json\n`,
          `            ${workflowExpression("runner.temp")}/dependency-security-receipt-root/sealed/uploader-manifest.json\n            ${workflowExpression("runner.temp")}/dependency-security-receipt-root/sealed/extra.json\n`,
        ),
    ],
  ]
  for (const [name, file, mutate] of cases) {
    await t.test(name, () => {
      assert.throws(
        () =>
          auditWorkflowEntrypoints(
            { ...sources, [file]: mutate(sources[file]) },
            descriptors.workflows,
          ),
        /not explicitly audited/u,
      )
    })
  }
})

test("every workflow executable entrypoint matches the readable audited allowlist", async () => {
  const allowlist = JSON.parse(await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }))
  const sources = await readWorkflowSourcesFromRoot(ROOT)

  assert.deepEqual(Object.keys(allowlist).sort(), ["schemaVersion", "workflows"])
  assert.equal(allowlist.schemaVersion, 2)
  assert.doesNotThrow(() => auditWorkflowEntrypoints(sources, allowlist.workflows))
})

test("workflow audit binds complete execution descriptors and byte-exact run strings", async (t) => {
  const allowlist = JSON.parse(await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }))
  const sources = await readWorkflowSourcesFromRoot(ROOT)
  const cases = [
    [
      "workflow permissions",
      "dependency-security-receipt.yml",
      (source) => source.replace("contents: read", "contents: write"),
    ],
    [
      "job runner",
      "dependency-security-receipt.yml",
      (source) => source.replace("ubuntu-latest", "self-hosted"),
    ],
    [
      "checkout inputs",
      "dependency-security-receipt.yml",
      (source) => source.replace("persist-credentials: false", "persist-credentials: true"),
    ],
    [
      "action inputs",
      "dependency-security-receipt.yml",
      (source) => source.replace("node-version: 24.17.0", "node-version: 24.16.0"),
    ],
    [
      "action environment",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "      - name: Setup Node.js\n",
          "      - name: Setup Node.js\n        env:\n          BASH_ENV: scripts/bypass.sh\n",
        ),
    ],
    [
      "action condition",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "      - name: Setup Node.js\n",
          "      - name: Setup Node.js\n        if: always()\n",
        ),
    ],
    [
      "unknown step key",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "      - name: Setup Node.js\n",
          "      - name: Setup Node.js\n        unexpected: true\n",
        ),
    ],
  ]
  for (const [name, file, mutate] of cases) {
    await t.test(name, () => {
      assert.throws(
        () =>
          auditWorkflowEntrypoints(
            { ...sources, [file]: mutate(sources[file]) },
            allowlist.workflows,
          ),
        /not explicitly audited/u,
      )
    })
  }

  const backslash = "\\"
  const line = `DAWN_TEST_WORKERD=1 pnpm --filter @dawn-ai/cli test workerd-lane ${backslash}\n`
  assert.ok(sources["ci.yml"].includes(line))
  assert.throws(
    () =>
      auditWorkflowEntrypoints(
        {
          ...sources,
          "ci.yml": sources["ci.yml"].replace(
            line,
            line.replace(`${backslash}\n`, `${backslash}  \n`),
          ),
        },
        allowlist.workflows,
      ),
    /not explicitly audited/u,
  )
})

test("workflow classifications are explicit safe or release-only publication", async () => {
  const allowlist = JSON.parse(await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }))

  assert.doesNotMatch(JSON.stringify(allowlist), /"audited"/u)
  assert.deepEqual(Object.keys(EXECUTABLE_ALLOWLIST).sort(), ["schemaVersion", "workflows"])
  assert.equal(EXECUTABLE_ALLOWLIST.schemaVersion, 1)
  assert.doesNotMatch(JSON.stringify(EXECUTABLE_ALLOWLIST), /"audited"/u)
  const publication = Object.entries(EXECUTABLE_ALLOWLIST.workflows).flatMap(([file, entries]) =>
    entries
      .filter(({ classification }) => classification === "publication")
      .map((entry) => ({ file, ...entry })),
  )
  assert.ok(publication.length > 0, "the final release workflow must retain explicit mutations")
  assert.ok(publication.every(({ file }) => file === "release.yml"))
  assert.ok(publication.some(({ value }) => /publisher\.mjs/u.test(value)))
  assert.equal(
    publication.some(({ value }) =>
      /release-publish|backfill-release-tags|upload-release-assets/iu.test(value),
    ),
    false,
  )
})

test("matching descriptor inventory cannot classify a new executable as safe", () => {
  const cases = [
    ["npm publish", "jobs:\n  new:\n    steps:\n      - run: npm publish\n"],
    ["bash wrapper", "jobs:\n  new:\n    steps:\n      - run: bash -c 'npm publish'\n"],
    [
      "publishing action",
      `jobs:\n  new:\n    steps:\n      - uses: example/publish@${"a".repeat(40)}\n`,
    ],
    [
      "local release reusable workflow",
      "jobs:\n  new:\n    uses: ./.github/workflows/release.yml\n",
    ],
  ]
  for (const [name, source] of cases) {
    const workflow = parse(source)
    const classifications = new Map(
      workflowExecutables(workflow).map((entry) => [executableIdentity(entry), "safe"]),
    )
    const inventory = {
      "new.yaml": workflowDescriptor(workflow, classifications),
    }
    const executables = {
      "new.yaml": workflowExecutables(workflow).map((entry) => ({
        classification: "safe",
        ...entry,
      })),
    }
    assert.throws(
      () => auditWorkflowEntrypoints({ "new.yaml": source }, inventory, executables),
      /not explicitly audited/u,
      name,
    )
  }
})

test("workflow parsing rejects duplicate keys, aliases, accessors, sparse data, and unknown fields", () => {
  const descriptor = {
    "safe.yml": {
      classification: "safe",
      descriptor: {},
      jobs: [
        {
          classification: "safe",
          id: "safe",
          descriptor: {},
          steps: [
            {
              classification: "safe",
              descriptor: { name: "Safe", run: "pnpm lint" },
            },
          ],
        },
      ],
    },
  }
  for (const source of [
    "jobs:\n  safe:\n    steps:\n      - name: Safe\n        run: pnpm lint\n        run: pnpm test\n",
    "shared: &shared\n  run: pnpm lint\njobs:\n  safe:\n    steps:\n      - name: Safe\n        <<: *shared\n",
    "unexpected: true\njobs:\n  safe:\n    steps:\n      - name: Safe\n        run: pnpm lint\n",
    "jobs:\n  safe:\n    unexpected: true\n    steps:\n      - name: Safe\n        run: pnpm lint\n",
  ]) {
    assert.throws(() => auditWorkflowEntrypoints({ "safe.yml": source }, descriptor))
  }

  const accessorSources = {}
  Object.defineProperty(accessorSources, "safe.yml", {
    enumerable: true,
    get() {
      return "jobs: {}\n"
    },
  })
  assert.throws(() => auditWorkflowEntrypoints(accessorSources, descriptor))

  const sparse = structuredClone(descriptor)
  sparse["safe.yml"].jobs.length = 2
  assert.throws(() => auditWorkflowEntrypoints({ "safe.yml": "jobs: {}\n" }, sparse))
  assert.equal(Object.getPrototypeOf({}), Object.prototype)
})

test("workflow reads are bounded, contained, regular, and no-follow", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-read-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-outside-"))
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]),
  )
  const workflows = path.join(root, ".github", "workflows")
  await mkdir(workflows, { recursive: true })
  await writeFile(path.join(outside, "outside.yml"), "jobs: {}\n")
  await symlink(path.join(outside, "outside.yml"), path.join(workflows, "unsafe.yml"))
  await assert.rejects(() => readWorkflowSourcesFromRoot(root), /fixture file/u)

  await rm(path.join(workflows, "unsafe.yml"))
  await mkdir(path.join(workflows, "directory.yaml"))
  await assert.rejects(() => readWorkflowSourcesFromRoot(root), /fixture file/u)

  await rm(path.join(workflows, "directory.yaml"), { recursive: true })
  await writeFile(path.join(workflows, "oversize.yml"), "x".repeat(1024 * 1024 + 1))
  await assert.rejects(() => readWorkflowSourcesFromRoot(root), /fixture file/u)
})

test("workflow directory traversal is anchored at regular repository components", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-root-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-external-"))
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]),
  )
  await mkdir(path.join(outside, "workflows"))
  await writeFile(path.join(outside, "workflows", "safe.yml"), "jobs: {}\n")

  await symlink(outside, path.join(root, ".github"))
  await assert.rejects(() => readWorkflowSourcesFromRoot(root), /workflow directory/u)

  await rm(path.join(root, ".github"))
  await writeFile(path.join(root, ".github"), "not a directory\n")
  await assert.rejects(() => readWorkflowSourcesFromRoot(root), /workflow directory/u)

  await rm(path.join(root, ".github"))
  await mkdir(path.join(root, ".github"))
  await symlink(path.join(outside, "workflows"), path.join(root, ".github", "workflows"))
  await assert.rejects(() => readWorkflowSourcesFromRoot(root), /workflow directory/u)

  await rm(path.join(root, ".github", "workflows"))
  await mkdir(path.join(root, ".github", "workflows"))
  await writeFile(path.join(root, ".github", "workflows", "safe.yml"), "jobs: {}\n")
  assert.deepEqual(Object.keys(await readWorkflowSourcesFromRoot(root)), ["safe.yml"])
})

test("all scripts reachable from final release ownership match audited content pins", async () => {
  const pins = JSON.parse(await readBoundedFixture(SCRIPT_PIN_PATH, { root: ROOT }))
  const sources = await readFinalWorkflowSources()
  const packageJson = JSON.parse(
    await readBoundedFixture(path.join(ROOT, "package.json"), { root: ROOT }),
  )
  const coverage = releaseWorkflowScriptReferences(sources, packageJson)

  assert.deepEqual(Object.keys(pins).sort(), ["schemaVersion", "scripts"])
  assert.equal(pins.schemaVersion, 1)
  assert.deepEqual(coverage.unfollowable, [])
  assert.deepEqual(Object.keys(pins.scripts).sort(), coverage.referenced)
  await assertPinnedScriptContents(ROOT, pins, coverage.referenced)
})

test("final release reachability fails closed on hidden scripts and package indirection", async (t) => {
  const packageJson = {
    scripts: { version: "changeset version && node scripts/sync.mjs" },
  }
  const step = (body) =>
    `on:\n  workflow_dispatch: {}\njobs:\n  release:\n    steps:\n      - name: Publish\n${body}`
  const cases = [
    ["run step", step("        run: node scripts/evil.mjs\n"), /scripts\/evil\.mjs/u],
    [
      "action input literal",
      step(
        "        uses: example/action@x\n        with:\n          publish: node scripts/evil.mjs\n",
      ),
      /scripts\/evil\.mjs/u,
    ],
    [
      "action input pnpm indirection",
      step("        uses: example/action@x\n        with:\n          version: pnpm run version\n"),
      /scripts\/sync\.mjs/u,
    ],
    [
      "unaudited run indirection",
      step("        run: pnpm sneak\n"),
      /cannot follow to a repository script/u,
    ],
  ]
  for (const [name, source, pattern] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => assertReleaseScriptCoverage({ "release.yml": source }, packageJson, []),
        pattern,
        name,
      )
    })
  }

  await t.test("action input naming no package.json script", () => {
    assert.throws(
      () =>
        assertReleaseScriptCoverage(
          {
            "release.yml": step(
              "        uses: example/action@x\n        with:\n          publish: pnpm ghost\n",
            ),
          },
          packageJson,
          [],
        ),
      /cannot follow to a repository script/u,
    )
  })

  await t.test("a stale pin whose step disappeared", () => {
    assert.throws(
      () =>
        assertReleaseScriptCoverage(
          { "release.yml": step("        run: node scripts/visible.mjs\n") },
          packageJson,
          ["scripts/stale.mjs", "scripts/visible.mjs"],
        ),
      /pinned but no final owner workflow reaches/u,
    )
  })
})

test("script content pins fail closed on drift and on a pinned script that went missing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dawn-script-pins-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, "scripts", "release"), { recursive: true })
  const file = "scripts/release/example.mjs"
  const body = "export {}\n"
  const pins = {
    schemaVersion: 1,
    scripts: {
      [file]: { sha256: createHash("sha256").update(body).digest("hex") },
    },
  }
  await writeFile(path.join(root, file), body)
  await assertPinnedScriptContents(root, pins, [file])

  await writeFile(path.join(root, file), `${body}// appended\n`)
  await assert.rejects(
    () => assertPinnedScriptContents(root, pins, [file]),
    (error) =>
      error.message.includes(file) &&
      error.message.includes(pins.scripts[file].sha256) &&
      error.message.includes(SCRIPT_PIN_FIXTURE),
    "drift must report the file, both hashes, and the fixture to update",
  )

  await rm(path.join(root, file))
  await assert.rejects(
    () => assertPinnedScriptContents(root, pins, [file]),
    (error) => error.message.includes(file) && /missing|not a regular file/u.test(error.message),
    "a pinned script that disappeared must fail rather than silently pass",
  )

  await symlink(path.join(root, "scripts"), path.join(root, file))
  await assert.rejects(() => assertPinnedScriptContents(root, pins, [file]))
})

test("root scripts retain the controller surfaces without legacy publication commands", async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"))

  assert.equal(packageJson.scripts["release:preflight"], "node scripts/release/preflight.mjs")
  assert.equal(
    packageJson.scripts["test:release-controller"],
    "node --test scripts/published-artifacts.test.mjs scripts/release/test/*.test.mjs",
  )
  for (const command of LEGACY_PACKAGE_COMMANDS)
    assert.equal(packageJson.scripts[command], undefined)
})

async function readRequiredWorkflow(file) {
  let source
  try {
    source = await readBoundedFixture(path.join(WORKFLOWS, file), {
      root: ROOT,
      maxBytes: 1024 * 1024,
    })
  } catch (error) {
    assert.fail(`${file} must exist as a bounded regular workflow file: ${error.message}`)
  }
  return { source, workflow: parseWorkflowSource(source, file) }
}

async function readFinalWorkflowSources() {
  const sources = Object.create(null)
  for (const file of FINAL_WORKFLOW_FILES) {
    const { source } = await readRequiredWorkflow(file)
    sources[file] = source
  }
  return sources
}

function assertNoDuplicateDraftWorkflowMutation(sources) {
  for (const [file, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /duplicate-draft-consolidation|release:consolidate-drafts/u, file)
    const workflow = parseWorkflowSource(source, file)
    for (const context of workflowExecutionContexts(workflow)) {
      for (const normalized of normalizeExecutionContexts(context)) {
        if (
          containsGhReleaseDelete(normalized) ||
          containsDeleteReleaseOperation(normalized) ||
          (containsDeleteMethod(normalized) && containsPossibleReleaseEndpoint(normalized))
        ) {
          throw new Error(`${file} contains a Release DELETE endpoint in ${context.label}`)
        }
      }
    }
  }
}

async function assertNoDuplicateDraftWorkflowMutationFromRoot(root) {
  const sources = await readWorkflowSourcesFromRoot(root)
  assertNoDuplicateDraftWorkflowMutation(sources)
  const packageJson = JSON.parse(
    await readBoundedFixture(path.join(root, "package.json"), {
      root,
      maxBytes: 1024 * 1024,
    }),
  )
  const workspacePackages = await discoverWorkspacePackages(root)
  const visited = new Set()
  let visits = 0
  const claimVisit = (identity) => {
    if (visited.has(identity)) return false
    if (visits >= 256) throw new Error("Workflow executable traversal exceeds the isolation bound")
    visited.add(identity)
    visits += 1
    return true
  }
  const visitFile = async (relative, kind = "script") => {
    const normalized = normalizeReachablePath(relative)
    const identity = `${kind}:${normalized}`
    if (!claimVisit(identity)) return
    const source = await readBoundedFixture(path.join(root, normalized), {
      root,
      maxBytes: 1024 * 1024,
    })
    if (kind === "workflow") {
      await visitWorkflow(parseWorkflowSource(source, normalized), normalized)
      return
    }
    if (kind === "action") {
      const action = parse(source, { maxAliasCount: 0, uniqueKeys: true })
      if (!isRecord(action?.runs)) throw new TypeError(`${normalized} is not a local action`)
      if (action.runs.using === "composite") {
        for (const step of action.runs.steps ?? []) await visitStep(step, normalized)
      } else {
        for (const key of ["pre", "main", "post"]) {
          if (typeof action.runs[key] === "string") {
            await visitFile(path.posix.join(path.posix.dirname(normalized), action.runs[key]))
          }
        }
      }
      return
    }
    if (/duplicate-draft-consolidation|release:consolidate-drafts/u.test(source)) {
      throw new Error(`${normalized} contains a banned consolidation identifier`)
    }
    assertNoReleaseDeleteExecution(source, normalized)
    if (/\.(?:ba|z)?sh$/u.test(normalized) || !/\.[a-z0-9]+$/iu.test(normalized)) {
      await visitCommand(source, normalized)
    }
    if (/\.[cm]?[jt]sx?$/u.test(normalized)) {
      for (const reference of localModuleReferences(source, normalized)) {
        await visitResolvedFile(path.posix.dirname(normalized), reference)
      }
      for (const reference of localSpawnReferences(source)) {
        await visitCommand(reference, normalized)
      }
    }
  }
  const visitResolvedFile = async (directory, reference) => {
    const base = normalizeReachablePath(path.posix.join(directory, reference))
    if (base.split("/").includes("node_modules")) return
    const candidates = /\.[a-z0-9]+$/iu.test(base)
      ? [base, ...(/\.js$/u.test(base) ? [base.replace(/\.js$/u, ".ts")] : [])]
      : [
          base,
          ...[".mjs", ".js", ".cjs", ".ts", ".tsx"].map((suffix) => `${base}${suffix}`),
          ...["index.mjs", "index.js", "index.ts"].map((name) => path.posix.join(base, name)),
        ]
    let lastError
    for (const candidate of candidates) {
      try {
        const status = await lstat(path.join(root, candidate))
        if (!status.isFile() || status.isSymbolicLink()) {
          throw new TypeError("Invalid repository-local executable file")
        }
        await visitFile(candidate)
        return
      } catch (error) {
        if (error?.code !== "ENOENT") throw error
        lastError = error
      }
    }
    if (lastError?.code === "ENOENT") return
    throw lastError
  }
  const visitCommand = async (command, label, baseDirectory = ".") => {
    assertNoReleaseDeleteExecution(command, label)
    for (const name of packageScriptReferences(command)) {
      const script = packageJson.scripts?.[name]
      if (typeof script !== "string") continue
      const identity = `package:${name}`
      if (!claimVisit(identity)) continue
      await visitCommand(script, `package script ${name}`)
    }
    for (const { packageName, scriptName } of filteredPackageScriptReferences(command)) {
      const normalizedPackageName = packageName.replace(/^\.\.\./u, "").replace(/\.\.\.$/u, "")
      const workspace = workspacePackages.get(normalizedPackageName)
      const script = workspace?.manifest.scripts?.[scriptName]
      if (typeof script !== "string") {
        if (["exec", "install", "list"].includes(scriptName)) continue
        throw new Error(
          `${label} contains an unresolved filtered workspace script ${packageName}:${scriptName}`,
        )
      }
      const identity = `package:${normalizedPackageName}:${scriptName}`
      if (!claimVisit(identity)) continue
      await visitCommand(script, `package script ${packageName}:${scriptName}`, workspace.directory)
    }
    const files = localCommandFileReferences(command)
    for (const file of files) await visitResolvedFile(baseDirectory, file)
    const unknownRunner = /(?:^|[\n;&|])\s*([\w.-]+)\s+(?:\.\/)?(?:scripts|\.github)\//gu.exec(
      command,
    )?.[1]
    if (unknownRunner !== undefined && !["node", "bash", "sh", "tsx"].includes(unknownRunner)) {
      throw new Error(`${label} contains unsupported repository-local runner ${unknownRunner}`)
    }
    if (
      /(?:^|[\s;&|"'(])(?:scripts|\.\/scripts|\.github)\/[\w./-]+/u.test(command) &&
      files.size === 0 &&
      !/\bnode\s+--test\s+[^\n]*\*/u.test(command)
    ) {
      throw new Error(`${label} contains unsupported repository-local execution syntax: ${command}`)
    }
  }
  const visitStep = async (step, label) => {
    if (!isRecord(step)) throw new TypeError(`${label} contains an invalid executable step`)
    if (typeof step.run === "string") await visitCommand(step.run, label)
    if (typeof step.uses === "string" && step.uses.startsWith("./")) {
      await visitLocalUses(step.uses)
    }
  }
  const visitLocalUses = async (uses) => {
    const relative = normalizeReachablePath(uses)
    if (/\.ya?ml$/u.test(relative)) {
      await visitFile(relative, "workflow")
      return
    }
    let lastError
    for (const name of ["action.yml", "action.yaml"]) {
      try {
        await visitFile(path.posix.join(relative, name), "action")
        return
      } catch (error) {
        if (error?.code !== "ENOENT") throw error
        lastError = error
      }
    }
    throw lastError
  }
  const visitWorkflow = async (workflow, label) => {
    for (const job of Object.values(workflow.jobs)) {
      if (!isRecord(job)) continue
      if (typeof job.uses === "string" && job.uses.startsWith("./")) {
        await visitLocalUses(job.uses)
      }
      for (const step of job.steps ?? []) await visitStep(step, label)
    }
  }
  for (const [file, source] of Object.entries(sources)) {
    if (!claimVisit(`workflow:${file}`)) continue
    await visitWorkflow(parseWorkflowSource(source, file), file)
  }
}

function assertNoReleaseDeleteExecution(value, label) {
  const normalized = String(value)
    .replace(/\\\r?\n/gu, "")
    .toLowerCase()
  if (
    containsGhReleaseDelete(normalized) ||
    containsDeleteReleaseOperation(normalized) ||
    (containsDeleteMethod(normalized) && containsPossibleReleaseEndpoint(normalized))
  ) {
    throw new Error(`${label} contains a Release DELETE endpoint`)
  }
}

function normalizeReachablePath(value) {
  const normalized = path.posix.normalize(String(value).replace(/^\.\//u, ""))
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /[\0\r\n]|\$\{\{/u.test(normalized)
  ) {
    throw new TypeError("Invalid repository-local executable path")
  }
  return normalized
}

function packageScriptReferences(command) {
  const names = []
  const pattern =
    /(?:^|[\s;&|"'(])(?:pnpm\s+(?:run\s+)?|npm\s+run\s+|yarn\s+(?:run\s+)?)(?!-)([\w:.-]+)/gu
  for (const match of String(command).matchAll(pattern)) names.push(match[1])
  return names
}

function filteredPackageScriptReferences(command) {
  const references = []
  const pattern = /\bpnpm\s+(?:--filter|-F)\s+([^\s]+)\s+(?:run\s+)?([\w:.-]+)/gu
  for (const match of String(command).matchAll(pattern)) {
    references.push({ packageName: match[1], scriptName: match[2] })
  }
  return references
}

async function discoverWorkspacePackages(root) {
  const packages = new Map()
  const visitDirectory = async (relative, depth) => {
    let entries
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true })
    } catch (error) {
      if (error?.code === "ENOENT") return
      throw error
    }
    if (entries.length > 256) throw new Error("Workspace package discovery exceeds the bound")
    const manifestPath = path.join(root, relative, "package.json")
    try {
      const status = await lstat(manifestPath)
      if (!status.isFile() || status.isSymbolicLink())
        throw new TypeError("Invalid workspace manifest")
      const manifest = JSON.parse(
        await readBoundedFixture(manifestPath, {
          root,
          maxBytes: 1024 * 1024,
        }),
      )
      if (typeof manifest.name === "string")
        packages.set(manifest.name, { directory: relative, manifest })
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    if (depth === 0) return
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
        await visitDirectory(path.posix.join(relative, entry.name), depth - 1)
      }
    }
  }
  for (const [directory, depth] of [
    ["packages", 1],
    ["apps", 1],
    ["examples", 2],
  ]) {
    await visitDirectory(directory, depth)
  }
  return packages
}

function localCommandFileReferences(command) {
  const files = new Set()
  const pattern =
    /(?:^|[\s;&|"'(])(?:node(?:\s+--?[\w=-]+)*|(?:ba)?sh(?:\s+-[a-z]+)*|pnpm\s+exec\s+(?:tsx|node)(?:\s+--?[\w=-]+)*|tsx)\s+((?:\.\/)?(?:scripts|\.github)\/[\w./-]*[\w.-])(?![\w./*-])/giu
  for (const match of String(command).matchAll(pattern)) files.add(match[1])
  const direct = /(?:^|[\s;&|"'(])((?:\.\/)?(?:scripts|\.github)\/[\w./-]*[\w.-])(?![\w./*-])/gu
  for (const match of String(command).matchAll(direct)) files.add(match[1])
  return files
}

function localModuleReferences(source, file) {
  const references = new Set()
  const scriptKind = typescriptScriptKind(file)
  const sourceFile = typescript.createSourceFile(
    file,
    source,
    typescript.ScriptTarget.Latest,
    true,
    scriptKind,
  )
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0]
    const message = typescript.flattenDiagnosticMessageText(diagnostic.messageText, " ")
    throw new Error(`${file} cannot be parsed as executable JavaScript/TypeScript: ${message}`)
  }
  const addLiteral = (node) => {
    if (typescript.isStringLiteralLike(node) && /^\.\.?\//u.test(node.text)) {
      references.add(node.text)
    }
  }
  const visit = (node) => {
    if (
      (typescript.isImportDeclaration(node) || typescript.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      addLiteral(node.moduleSpecifier)
    } else if (
      typescript.isImportEqualsDeclaration(node) &&
      typescript.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined
    ) {
      addLiteral(node.moduleReference.expression)
    } else if (typescript.isCallExpression(node) && node.arguments.length >= 1) {
      if (
        node.expression.kind === typescript.SyntaxKind.ImportKeyword ||
        (typescript.isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        addLiteral(node.arguments[0])
      }
    }
    typescript.forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}

function typescriptScriptKind(file) {
  if (/\.tsx$/iu.test(file)) return typescript.ScriptKind.TSX
  if (/\.jsx$/iu.test(file)) return typescript.ScriptKind.JSX
  if (/\.(?:ts|mts|cts)$/iu.test(file)) return typescript.ScriptKind.TS
  if (/\.json$/iu.test(file)) return typescript.ScriptKind.JSON
  return typescript.ScriptKind.JS
}

function localSpawnReferences(source) {
  const commands = new Set()
  const executableSource = String(source).replace(/`(?:\\[\s\S]|[^`])*`/gu, "")
  const pattern =
    /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(["'])([^"']+)\1\s*,\s*\[([^\]]*)\]/gu
  for (const match of executableSource.matchAll(pattern)) {
    const args = [...match[3].matchAll(/(["'])([^"']+)\1/gu)].map((entry) => entry[2])
    commands.add([match[2], ...args].join(" "))
  }
  const execPattern = /\b(?:exec|execSync)\s*\(\s*(["'])([^"']+)\1/gu
  for (const match of executableSource.matchAll(execPattern)) commands.add(match[2])
  return commands
}

function workflowExecutionContexts(workflow) {
  const contexts = []
  const inputDefaults = collectWorkflowInputDefaults(workflow)
  const workflowEnv = collectScalarMap(workflow.env)
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (!isRecord(job)) continue
    const jobEnv = mergeScalarMaps(
      workflowEnv,
      collectScalarMap(job.container?.env),
      collectScalarMap(job.env),
    )
    const matrixRows = collectStaticMatrixRows(job.strategy?.matrix)
    if (typeof job.uses === "string") {
      contexts.push({
        env: jobEnv,
        inputDefaults,
        label: `job ${jobId}`,
        matrixRows,
        values: [
          `jobs.${jobId}.uses=${job.uses}`,
          ...executionObjectScalars(job.with, `jobs.${jobId}.with`),
          ...executionObjectScalars(job.secrets, `jobs.${jobId}.secrets`),
        ],
      })
    }
    if (!Array.isArray(job.steps)) continue
    for (const [stepIndex, step] of job.steps.entries()) {
      if (!isRecord(step)) continue
      const env = mergeScalarMaps(jobEnv, collectScalarMap(step.env))
      const values = [...executionObjectScalars(step.with, `jobs.${jobId}.steps.${stepIndex}.with`)]
      if (typeof step.run === "string") {
        values.push(`jobs.${jobId}.steps.${stepIndex}.run=${step.run}`)
      }
      if (typeof step.uses === "string") {
        values.push(`jobs.${jobId}.steps.${stepIndex}.uses=${step.uses}`)
      }
      contexts.push({
        env,
        inputDefaults,
        label: `job ${jobId} step ${stepIndex}`,
        matrixRows,
        values,
      })
    }
  }
  return contexts
}

function collectStaticMatrixRows(matrix) {
  if (!isRecord(matrix)) return { dynamic: matrix !== undefined, rows: [{}] }
  const axes = Object.entries(matrix).filter(([key]) => key !== "include" && key !== "exclude")
  if (axes.some(([, values]) => !Array.isArray(values) || !values.every(isStaticScalar))) {
    return { dynamic: true, rows: [{}] }
  }
  let states = [{ base: {}, row: {} }]
  for (const [key, values] of axes) {
    if (values.length === 0) return { dynamic: false, rows: [] }
    if (states.length > Math.floor(1024 / values.length)) {
      throw new Error("Workflow matrix expansion exceeds the isolation bound")
    }
    const next = []
    for (const state of states) {
      for (const value of values) {
        const scalar = String(value)
        next.push({
          base: { ...state.base, [key.toLowerCase()]: scalar },
          row: { ...state.row, [key.toLowerCase()]: scalar },
        })
      }
    }
    states = next
  }
  const exclusions = staticMatrixObjects(matrix.exclude)
  if (exclusions === null) return { dynamic: true, rows: [{}] }
  states = states.filter(({ base }) => !exclusions.some((entry) => rowMatches(base, entry)))
  const includes = staticMatrixObjects(matrix.include)
  if (includes === null) return { dynamic: true, rows: [{}] }
  if (axes.length === 0 && includes.length > 0) {
    if (includes.length > 1024) {
      throw new Error("Workflow matrix expansion exceeds the isolation bound")
    }
    states = includes.map((entry) => ({
      base: { ...entry },
      row: { ...entry },
    }))
  } else {
    const standalone = []
    for (const include of includes) {
      let applied = false
      for (const state of states) {
        if (!rowCompatible(state.base, include)) continue
        state.row = { ...state.row, ...include }
        applied = true
      }
      if (!applied) {
        if (states.length + standalone.length >= 1024) {
          throw new Error("Workflow matrix expansion exceeds the isolation bound")
        }
        standalone.push({ base: { ...include }, row: { ...include } })
      }
    }
    states.push(...standalone)
  }
  if (states.length > 1024) throw new Error("Workflow matrix expansion exceeds the isolation bound")
  return { dynamic: false, rows: states.map(({ row }) => row) }
}

function staticMatrixObjects(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const objects = []
  for (const entry of value) {
    if (!isRecord(entry) || Object.values(entry).some((item) => !isStaticScalar(item))) return null
    objects.push(
      Object.fromEntries(
        Object.entries(entry).map(([key, item]) => [key.toLowerCase(), String(item)]),
      ),
    )
  }
  return objects
}

function isStaticScalar(value) {
  return (
    (typeof value === "string" || typeof value === "number" || typeof value === "boolean") &&
    !(typeof value === "string" && /\$\{\{/u.test(value))
  )
}

function rowMatches(row, expected) {
  return Object.entries(expected).every(([key, value]) => row[key] === value)
}

function rowCompatible(row, included) {
  return Object.entries(included).every(
    ([key, value]) => !Object.hasOwn(row, key) || row[key] === value,
  )
}

function collectWorkflowInputDefaults(workflow) {
  const defaults = Object.create(null)
  for (const event of [workflow.on?.workflow_dispatch, workflow.on?.workflow_call]) {
    if (!isRecord(event?.inputs)) continue
    for (const [key, descriptor] of Object.entries(event.inputs)) {
      if (isRecord(descriptor) && isStaticScalar(descriptor.default)) {
        defaults[key.toLowerCase()] = String(descriptor.default)
      }
    }
  }
  return defaults
}

function collectScalarMap(value) {
  const result = Object.create(null)
  if (!isRecord(value)) return result
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      result[key.toLowerCase()] = String(entry)
    }
  }
  return result
}

function mergeScalarMaps(...maps) {
  return Object.assign(Object.create(null), ...maps)
}

function executionObjectScalars(value, prefix) {
  if (!isRecord(value) && !Array.isArray(value)) return []
  const found = []
  const visit = (current, pathParts) => {
    if (
      typeof current === "string" ||
      typeof current === "number" ||
      typeof current === "boolean"
    ) {
      found.push(`${prefix}.${pathParts.join(".")}=${String(current)}`)
      return
    }
    if (Array.isArray(current)) {
      for (const [index, entry] of current.entries()) visit(entry, [...pathParts, String(index)])
      return
    }
    if (!isRecord(current)) return
    for (const [key, entry] of Object.entries(current)) visit(entry, [...pathParts, key])
  }
  visit(value, [])
  return found
}

function normalizeExecutionContexts(context) {
  const resolved = resolveKnownExecutionReferences(context.values.join("\n"), context)
  const rows = context.matrixRows.dynamic ? [null] : context.matrixRows.rows
  return rows.flatMap((row) =>
    expandMatrixReferences(resolved, row, context.matrixRows.dynamic).map((value) =>
      value
        .replace(/\$\{\{[\s\S]*?\}\}/gu, "__expression__")
        .replace(/\\\r?\n/gu, "")
        .toLowerCase(),
    ),
  )
}

function resolveKnownExecutionReferences(value, context) {
  let resolved = value
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = resolved
      .replace(/\$\{\{\s*inputs\.([a-z_][a-z0-9_-]*)\s*\}\}/giu, (match, key) =>
        Object.hasOwn(context.inputDefaults, key.toLowerCase())
          ? context.inputDefaults[key.toLowerCase()]
          : match,
      )
      .replace(/\$\{\{\s*env\.([a-z_][a-z0-9_]*)\s*\}\}/giu, (match, key) =>
        Object.hasOwn(context.env, key.toLowerCase()) ? context.env[key.toLowerCase()] : match,
      )
      .replace(/\$\{([a-z_][a-z0-9_]*)\}/giu, (match, key) =>
        Object.hasOwn(context.env, key.toLowerCase()) ? context.env[key.toLowerCase()] : match,
      )
      .replace(/\$([a-z_][a-z0-9_]*)/giu, (match, key) =>
        Object.hasOwn(context.env, key.toLowerCase()) ? context.env[key.toLowerCase()] : match,
      )
    if (next === resolved) return resolved
    resolved = next
  }
  throw new Error("Workflow expression indirection exceeds the isolation bound")
}

function expandMatrixReferences(value, row, dynamic) {
  const expansions = []
  const visit = (current, assignments) => {
    if (expansions.length >= 1024) {
      throw new Error("Workflow matrix expansion exceeds the isolation bound")
    }
    const reference = findMatrixReference(current)
    if (reference === null) {
      expansions.push(current)
      return
    }
    const assignmentKey = reference.key ?? `dynamic:${reference.expression.toLowerCase()}`
    const assigned = assignments.get(assignmentKey)
    const configured =
      reference.key !== null && row !== null && Object.hasOwn(row, reference.key)
        ? row[reference.key]
        : undefined
    const choices =
      assigned === undefined
        ? configured !== undefined
          ? [configured]
          : dynamic || reference.key === null
            ? ["DELETE", "/repos/{owner}/{repo}/releases/{release_id}"]
            : [""]
        : [assigned]
    for (const choice of choices) {
      const nextAssignments =
        assigned === undefined ? new Map(assignments).set(assignmentKey, choice) : assignments
      visit(
        `${current.slice(0, reference.index)}${choice}${current.slice(reference.index + reference.expression.length)}`,
        nextAssignments,
      )
    }
  }
  visit(value, new Map())
  return expansions
}

function findMatrixReference(value) {
  const match = /\$\{\{\s*matrix\b[\s\S]*?\}\}/iu.exec(value)
  if (match === null) return null
  const parsed =
    /^\$\{\{\s*matrix\s*(?:\.\s*([a-z_][a-z0-9_-]*)|\[\s*(["'])([^"']+)\2\s*\])\s*\}\}$/iu.exec(
      match[0],
    )
  return {
    expression: match[0],
    index: match.index,
    key: parsed === null ? null : (parsed[1] ?? parsed[3]).toLowerCase(),
  }
}

function containsDeleteMethod(value) {
  return /(?:^|[\s"'`(])delete\s+(?=\/?repos\/)|(?:^|\s)(?:-x\s*["'`]?\s*(?:delete\b|__expression__)|--(?:method|request)(?:\s+|\s*=\s*)["'`]?\s*(?:delete\b|__expression__)|[^\s=:]*(?:method|request|verb)[^\s=:]*\s*[:=]\s*["'`]?(?:delete\b|__expression__))/iu.test(
    value,
  )
}

function containsGhReleaseDelete(value) {
  return /\bgh\s+release\s+delete(?:\s|$)/iu.test(value)
}

function containsDeleteReleaseOperation(value) {
  return /(?:\bdeleterelease\s*(?:\?\s*\.\s*)?\(|["']deleterelease["']\s*\]\s*(?:\?\s*\.\s*)?\()/iu.test(
    value,
  )
}

function containsReleaseEndpoint(value) {
  const segment = String.raw`(?:__expression__|\$[a-z_][a-z0-9_]*|[^/\s"'=:]+)`
  const repository = `(?:${segment}|${segment}/${segment})`
  const releaseId = String.raw`(?:[1-9][0-9]*|__expression__|\$[a-z_][a-z0-9_]*|\$\{[a-z_][a-z0-9_]*\}|\{[a-z_][a-z0-9_]*\})`
  const host = String.raw`(?:https?://[^/\s"']+|__expression__|\$[a-z_][a-z0-9_]*|\$\{[a-z_][a-z0-9_]*\})`
  return new RegExp(
    String.raw`(?:^|[\s"'=])${host}?/?repos/${repository}/releases/${releaseId}(?:$|[?&#/\s"'])`,
    "iu",
  ).test(value)
}

function containsPossibleReleaseEndpoint(value) {
  return (
    containsReleaseEndpoint(value) ||
    /\b(?:gh\s+api|curl\b)[^\n]*["']?__expression__["']?/iu.test(value)
  )
}

function runWorkflow(run, block = "|", stepEnv, jobEnv) {
  const indent = (value, spaces) =>
    value
      .split("\n")
      .map((line) => `${" ".repeat(spaces)}${line}`)
      .join("\n")
  const yamlMap = (value, spaces) =>
    Object.entries(value ?? {})
      .map(([key, entry]) => `${" ".repeat(spaces)}${key}: ${JSON.stringify(entry)}`)
      .join("\n")
  return `name: fixture
on:
  workflow_dispatch: {}
jobs:
  mutation:
    runs-on: ubuntu-latest
${jobEnv === undefined ? "" : `    env:\n${yamlMap(jobEnv, 6)}\n`}    steps:
      - run: ${block}
${indent(run, 10)}
${stepEnv === undefined ? "" : `        env:\n${yamlMap(stepEnv, 10)}\n`}`
}

function actionWorkflow(withValues) {
  const inputs = Object.entries(withValues)
    .map(([key, value]) => `          ${key}: ${JSON.stringify(value)}`)
    .join("\n")
  return `name: fixture
on:
  workflow_dispatch: {}
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: example/action@0123456789012345678901234567890123456789
        with:
${inputs}
`
}

function reusableWorkflow(withValues) {
  const inputs = Object.entries(withValues)
    .map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`)
    .join("\n")
  return `name: fixture
on:
  workflow_dispatch: {}
jobs:
  mutation:
    uses: example/workflows/.github/workflows/delete.yml@0123456789012345678901234567890123456789
    with:
${inputs}
`
}

function matrixWorkflow(matrix, run) {
  const matrixYaml = stringify(matrix, { lineWidth: 0 })
    .trimEnd()
    .split("\n")
    .map((line) => `        ${line}`)
    .join("\n")
  const steps = (Array.isArray(run) ? run : [run])
    .map((value) => `      - run: ${JSON.stringify(value)}`)
    .join("\n")
  return `name: fixture
on:
  workflow_dispatch: {}
jobs:
  mutation:
    strategy:
      matrix:
${matrixYaml}
    runs-on: ubuntu-latest
    steps:
${steps}
`
}

function dynamicMatrixWorkflow(run) {
  const steps = (Array.isArray(run) ? run : [run])
    .map((value) => `      - run: ${JSON.stringify(value)}`)
    .join("\n")
  return `name: fixture
on:
  workflow_dispatch: {}
jobs:
  mutation:
    strategy:
      matrix: \${{ fromJSON(needs.scope.outputs.matrix) }}
    runs-on: ubuntu-latest
    steps:
${steps}
`
}

function inputDefaultWorkflow(defaults, run) {
  const inputs = Object.entries(defaults)
    .map(
      ([key, value]) =>
        `      ${key}:\n        type: string\n        default: ${JSON.stringify(value)}`,
    )
    .join("\n")
  return `name: fixture
on:
  workflow_dispatch:
    inputs:
${inputs}
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: ${JSON.stringify(run)}
`
}

async function createWorkflowReachabilityFixture(t, fixture) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-reachability-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true })
  const step =
    fixture.uses === undefined
      ? `      - run: ${JSON.stringify(fixture.workflow ?? "echo safe")}`
      : `      - uses: ${fixture.uses}`
  const workflow =
    fixture.jobUses === undefined
      ? `on:\n  workflow_dispatch: {}\njobs:\n  fixture:\n    runs-on: ubuntu-latest\n    steps:\n${step}\n`
      : `on:\n  workflow_dispatch: {}\njobs:\n  fixture:\n    uses: ${fixture.jobUses}\n`
  await writeFile(path.join(root, ".github", "workflows", "fixture.yml"), workflow)
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ private: true, scripts: fixture.packageScripts ?? {} }, null, 2)}\n`,
  )
  for (const [file, source] of Object.entries(fixture.files ?? {})) {
    const target = path.join(root, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, source)
  }
  return root
}

function parseWorkflowSource(source, file) {
  let workflow
  try {
    workflow = parse(source, { maxAliasCount: 0, uniqueKeys: true })
  } catch (error) {
    assert.fail(`${file} must be valid unique-key YAML: ${error.message}`)
  }
  assert.ok(isRecord(workflow), `${file} must parse to a workflow object`)
  assert.ok(isRecord(workflow.on), `${file} must declare parsed triggers`)
  assert.ok(isRecord(workflow.jobs), `${file} must declare parsed jobs`)
  return workflow
}

function requiredJob(workflow, id) {
  const job = workflow.jobs?.[id]
  assert.ok(isRecord(job), `workflow must define job ${id}`)
  assert.ok(Array.isArray(job.steps), `${id} must define concrete steps`)
  return job
}

function onlyStepUsing(job, uses) {
  const matches = job.steps.filter((step) => step.uses === uses)
  assert.equal(matches.length, 1, `job must use ${uses} exactly once`)
  return matches[0]
}

function onlyRunStepMatching(job, pattern) {
  const matches = job.steps.filter((step) => typeof step.run === "string" && pattern.test(step.run))
  assert.equal(matches.length, 1, `job must have exactly one run step matching ${pattern}`)
  return matches[0]
}

function runSource(job) {
  return job.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n")
}

function workflowArtifactBasenames(value) {
  assert.equal(typeof value, "string", "artifact upload path must be explicit")
  const entries = value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
  assert.equal(entries.length, 1, "small handoff must contain exactly one release record")
  const globCharacters = ["*", "?", "!", "[", "]", "{", "}"]
  assert.ok(
    entries.every((entry) => globCharacters.every((character) => !entry.includes(character))),
    "handoff paths must not glob",
  )
  return entries.map((entry) => path.posix.basename(entry)).sort()
}

function assertPinnedToolchain(job) {
  const nodeSteps = job.steps.filter((step) => step.uses === ACTIONS.node)
  assert.equal(nodeSteps.length, 1, "Node jobs must have one pinned setup-node step")
  assert.equal(nodeSteps[0].with?.["node-version"], "24.19.0")
  for (const step of job.steps.filter((entry) => entry.uses === ACTIONS.pnpm)) {
    assert.equal(step.with?.version, "10.33.0")
  }
  const runs = runSource(job)
  if (
    /publisher\.mjs|independent-audit\.mjs|published-artifact-verify\.mjs|release\/smoke\//u.test(
      runs,
    )
  ) {
    assert.match(runs, /npm\s+--version/u)
    assert.match(runs, /11\.17\.0/u)
  }
}

function dispatchInputContract(input) {
  assert.ok(isRecord(input))
  return Object.fromEntries(
    ["default", "options", "required", "type"]
      .filter((key) => Object.hasOwn(input, key))
      .map((key) => [key, input[key]]),
  )
}

function assertDispatchIdentityInput(input) {
  assert.deepEqual(dispatchInputContract(input), {
    required: true,
    type: "string",
  })
}

function assertReadOrWritePermissions(actual, expected) {
  assert.deepEqual(actual, expected)
  for (const [permission, value] of Object.entries(actual)) {
    assert.ok(["read", "write"].includes(value), `${permission} has invalid permission ${value}`)
  }
}

function hasWritePermission(permissions) {
  return isRecord(permissions) && Object.values(permissions).some((value) => value === "write")
}

function assertNoWriteOrOidc(job) {
  assert.ok(isRecord(job.permissions), "read-only jobs must declare explicit permissions")
  assert.equal(hasWritePermission(job.permissions), false)
  assert.notEqual(job.permissions["id-token"], "write")
}

function normalizeNeeds(needs) {
  if (needs === undefined) return []
  const values = Array.isArray(needs) ? needs : [needs]
  assert.ok(values.every((value) => typeof value === "string"))
  assert.equal(new Set(values).size, values.length, "job needs must not contain duplicates")
  return [...values].sort()
}

function commandLine(run, command) {
  const lines = run.split(/\r?\n/u)
  const start = lines.findIndex((line) => line.includes(command))
  assert.notEqual(start, -1, `run step must invoke ${command}`)
  const selected = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim()
    selected.push(line.replace(/\\$/u, "").trim())
    if (!line.endsWith("\\")) break
  }
  return selected.join(" ").replace(/\s+/gu, " ").trim()
}

function assertCommandFlags(run, command, expectedFlags) {
  const line = commandLine(run, command)
  const actualFlags = [...line.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)\b/gu)].map(([, flag]) => flag)
  assert.deepEqual(actualFlags, expectedFlags, `${command} flags must be exact and ordered`)
}

function assertCommandHasFlag(run, flag) {
  assert.match(run, new RegExp(`(?:^|\\s)${escapeRegExp(flag)}(?:\\s|$)`, "u"))
  assert.equal(countMatches(run, new RegExp(escapeRegExp(flag), "gu")), 1)
}

function assertExactTagAndOperationGate(job, { operation }) {
  assert.equal(typeof job.if, "string", "exact-tag jobs must declare a job condition")
  assert.match(job.if, /needs\.tag\.outputs\.continue == 'true'/u)
  assert.match(
    job.if,
    /github\.ref == format\('refs\/tags\/v\{0\}', (?:inputs\.version|needs\.detect\.outputs\.candidate_version)\)/u,
  )
  assert.match(job.if, /github\.sha == needs\.detect\.outputs\.candidate_sha/u)
  assert.match(job.if, /inputs\.version == needs\.detect\.outputs\.candidate_version/u)
  assert.match(job.if, /inputs\.commitSha == needs\.detect\.outputs\.candidate_sha/u)
  assert.match(job.if, new RegExp(`inputs\\.operation == '${operation}'`, "u"))
  if (operation === "abandon") assert.match(job.if, /github\.event_name == 'workflow_dispatch'/u)
}

function assertExactIndependentTagGate(job, mode) {
  assert.equal(typeof job.if, "string")
  assert.match(job.if, /github\.event_name == 'workflow_dispatch'/u)
  assert.match(job.if, new RegExp(`needs\\.coordinate\\.outputs\\.mode == '${mode}'`, "u"))
  assert.match(job.if, /github\.ref == format\('refs\/tags\/v\{0\}', inputs\.version\)/u)
  assert.match(job.if, /github\.sha == inputs\.commitSha/u)
}

function transitiveNeeds(workflow, start) {
  const found = new Set()
  const visit = (id) => {
    for (const dependency of normalizeNeeds(requiredJob(workflow, id).needs)) {
      if (found.has(dependency)) continue
      found.add(dependency)
      visit(dependency)
    }
  }
  visit(start)
  return found
}

function countMatches(source, pattern) {
  return source.match(pattern)?.length ?? 0
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

async function readWorkflowSourcesFromRoot(root) {
  const resolvedRoot = path.resolve(root)
  const githubDirectory = path.join(resolvedRoot, ".github")
  const directory = path.join(githubDirectory, "workflows")
  try {
    const canonicalRoot = await realpath(resolvedRoot)
    for (const component of [githubDirectory, directory]) {
      const status = await lstat(component)
      if (!status.isDirectory() || status.isSymbolicLink()) throw new TypeError("unsafe")
      const canonicalComponent = await realpath(component)
      const relative = path.relative(canonicalRoot, canonicalComponent)
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new TypeError("unsafe")
    }
  } catch {
    throw new TypeError("Invalid workflow directory")
  }
  const sources = Object.create(null)
  for (const file of (await readdir(directory)).filter((name) => /\.ya?ml$/u.test(name)).sort()) {
    Object.defineProperty(sources, file, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: await readBoundedFixture(path.join(directory, file), {
        root: resolvedRoot,
        maxBytes: 1024 * 1024,
      }),
    })
  }
  return sources
}

// Collects every repository script reachable from the three final owner workflows.
// Literal paths are recorded directly. A pnpm package-script indirection is followed
// exactly once and rejected when it cannot be resolved without executing code.
function releaseWorkflowScriptReferences(sources, packageJson) {
  const referenced = new Set()
  const unfollowable = []
  for (const [file, source] of Object.entries(sources)) {
    const workflow = parseWorkflowSource(source, file)
    for (const [job, descriptor] of Object.entries(workflow.jobs)) {
      for (const [stepIndex, step] of (descriptor.steps ?? []).entries()) {
        const where = `${file} ${job} step ${stepIndex}${step.name ? ` ("${step.name}")` : ""}`
        const scan = (value, key) => {
          for (const script of matchAllGroups(value, SCRIPT_REFERENCE)) referenced.add(script)
          for (const name of matchAllGroups(value, PNPM_REFERENCE)) {
            const command = packageJson.scripts?.[name]
            if (typeof command !== "string") {
              unfollowable.push(
                key === null
                  ? `${where} runs \`pnpm ${name}\``
                  : `${where} passes \`${key}: ${value}\`, and \`${name}\` is not a package.json script`,
              )
              continue
            }
            const scripts = matchAllGroups(command, SCRIPT_REFERENCE)
            for (const script of scripts) referenced.add(script)
            if (scripts.length === 0 || matchAllGroups(command, PNPM_REFERENCE).length > 0) {
              unfollowable.push(
                `${where} reaches \`pnpm ${name}\`, which resolves to \`${command}\``,
              )
            }
          }
        }
        if (typeof step.run === "string") scan(step.run, null)
        for (const [key, value] of Object.entries(step.with ?? {})) {
          if (typeof value === "string") scan(value, key)
        }
      }
    }
  }
  return { referenced: [...referenced].sort(), unfollowable }
}

function assertReleaseScriptCoverage(sources, packageJson, pinned) {
  const { referenced, unfollowable } = releaseWorkflowScriptReferences(sources, packageJson)
  if (unfollowable.length > 0) {
    throw new Error(
      [
        `Release workflow reaches a command this check cannot follow to a repository script:`,
        ...unfollowable.map((entry) => `  ${entry}`),
        "An unfollowable command could run an unpinned script; invoke the reviewed script directly.",
      ].join("\n"),
    )
  }
  for (const file of referenced) {
    if (pinned.includes(file)) continue
    throw new Error(
      [
        `Release workflow reaches a repository script with no content pin: ${file}`,
        "A final release owner runs it directly or through package.json, so its bytes must be pinned with the command line.",
        `Add its sha256 to ${SCRIPT_PIN_FIXTURE}. Compute the hash with:`,
        `  node -p "require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('${file}')).digest('hex')"`,
      ].join("\n"),
    )
  }
  for (const file of pinned) {
    if (referenced.includes(file)) continue
    throw new Error(
      [
        `Release script pin is stale: ${file} is pinned but no final owner workflow reaches it.`,
        `Either restore the reviewed entrypoint or remove its entry from ${SCRIPT_PIN_FIXTURE}.`,
      ].join("\n"),
    )
  }
}

function matchAllGroups(value, pattern) {
  return [...value.matchAll(pattern)].map(([, group]) => group)
}

async function assertPinnedScriptContents(root, pins, files) {
  for (const file of files) {
    const expected = pins.scripts?.[file]?.sha256
    if (typeof expected !== "string" || !SHA256_HEX.test(expected)) {
      throw new Error(
        `Release script pin for ${file} is missing or is not a 64-character lowercase sha256 in ${SCRIPT_PIN_FIXTURE}.`,
      )
    }
    let source
    try {
      source = await readBoundedFixture(path.join(root, file), {
        root,
        maxBytes: 1024 * 1024,
      })
    } catch {
      throw new Error(
        [
          `Release script ${file} is pinned in ${SCRIPT_PIN_FIXTURE} but is missing or not a regular file inside the repository.`,
          `A pinned script must exist. If it was intentionally removed, delete its entry from ${SCRIPT_PIN_FIXTURE} and its final workflow entrypoint together.`,
        ].join("\n"),
      )
    }
    const actual = createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex")
    if (actual !== expected) {
      throw new Error(
        [
          `Release script content pin mismatch: ${file}`,
          `  expected sha256: ${expected}`,
          `  actual   sha256: ${actual}`,
          `This script runs during a release, so its bytes are pinned alongside the command line in the workflow entrypoint allowlist.`,
          `If you meant to change it, update the "sha256" for ${file} in ${SCRIPT_PIN_FIXTURE} in the same commit, and have the script diff reviewed as a release-integrity change. Recompute with:`,
          `  node -p "require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('${file}')).digest('hex')"`,
        ].join("\n"),
      )
    }
  }
}

function auditWorkflowEntrypoints(
  sources,
  allowlist,
  executableAllowlist = EXECUTABLE_ALLOWLIST.workflows,
) {
  const sourceSnapshot = snapshotDescriptor(sources)
  const allowlistSnapshot = snapshotDescriptor(allowlist)
  const executableSnapshot = snapshotDescriptor(executableAllowlist)
  if (!isRecord(sourceSnapshot) || !isRecord(allowlistSnapshot) || !isRecord(executableSnapshot))
    throw unauditedEntrypoint()
  const files = Object.keys(sourceSnapshot).sort()
  const allowedFiles = Object.keys(allowlistSnapshot).sort()
  const executableFiles = Object.keys(executableSnapshot).sort()
  if (!sameStrings(files, allowedFiles) || !sameStrings(files, executableFiles))
    throw unauditedEntrypoint()
  for (const file of files) {
    let workflow
    try {
      if (typeof sourceSnapshot[file] !== "string") throw new TypeError("invalid source")
      workflow = parse(sourceSnapshot[file], {
        maxAliasCount: 0,
        uniqueKeys: true,
      })
    } catch {
      throw unauditedEntrypoint()
    }
    const classifications = classifyExecutables(
      file,
      workflowExecutables(workflow),
      executableSnapshot[file],
    )
    const actual = workflowDescriptor(workflow, classifications)
    const expected = allowlistSnapshot[file]
    if (canonicalJson(actual) !== canonicalJson(expected)) throw unauditedEntrypoint()
  }
}

function workflowExecutables(workflow) {
  if (!isRecord(workflow?.jobs)) throw unauditedEntrypoint()
  const entries = []
  for (const [job, descriptor] of Object.entries(workflow.jobs)) {
    if (!isRecord(descriptor)) throw unauditedEntrypoint()
    if (descriptor.uses !== undefined) {
      if (typeof descriptor.uses !== "string") throw unauditedEntrypoint()
      entries.push({
        job,
        stepIndex: null,
        step: null,
        kind: "job-uses",
        value: descriptor.uses,
      })
    }
    if (descriptor.steps !== undefined && !Array.isArray(descriptor.steps))
      throw unauditedEntrypoint()
    for (const [stepIndex, step] of (descriptor.steps ?? []).entries()) {
      if (!isRecord(step)) throw unauditedEntrypoint()
      const hasRun = typeof step.run === "string"
      const hasUses = typeof step.uses === "string"
      if (hasRun === hasUses) throw unauditedEntrypoint()
      entries.push({
        job,
        stepIndex,
        step: typeof step.name === "string" ? step.name : null,
        kind: hasRun ? "run" : "step-uses",
        value: hasRun ? step.run : step.uses,
      })
    }
  }
  return entries
}

function classifyExecutables(file, actual, expected) {
  if (!Array.isArray(expected) || actual.length !== expected.length) throw unauditedEntrypoint()
  const classifications = new Map()
  for (let index = 0; index < actual.length; index += 1) {
    const allowed = expected[index]
    if (!isRecord(allowed) || !["safe", "publication"].includes(allowed.classification))
      throw unauditedEntrypoint()
    const identity = {
      job: allowed.job,
      stepIndex: allowed.stepIndex,
      step: allowed.step,
      kind: allowed.kind,
      value: allowed.value,
    }
    if (canonicalJson(actual[index]) !== canonicalJson(identity)) throw unauditedEntrypoint()
    const publication = isReleaseMutationExecutable(file, actual[index])
    if (allowed.classification === "publication") {
      if (file !== "release.yml" || !publication) throw unauditedEntrypoint()
    } else if (publication) throw unauditedEntrypoint()
    classifications.set(executableIdentity(actual[index]), allowed.classification)
  }
  return classifications
}

function isReleaseMutationExecutable(file, entry) {
  const value = entry.value
  if (entry.kind === "job-uses") {
    return /\.github\/workflows\/release\.yml(?:@|$)/u.test(value)
  }
  if (entry.kind === "step-uses") {
    if (/\/[^@]*(?:publish|release|attest)[^@]*@/iu.test(value)) {
      return file !== "version-pr.yml" || value !== ACTIONS.changesets
    }
    return file === "release.yml" && (value === ACTIONS.attest || value === ACTIONS.changesets)
  }
  if (
    /(?:\bnpm\s+publish\b|scripts\/release\/publisher\.mjs\b|scripts\/(?:release-publish|backfill-release-tags|upload-release-assets)\.mjs\b)/iu.test(
      value,
    )
  ) {
    return true
  }
  return (
    file === "release.yml" &&
    /(?:scripts\/release\/cli\.mjs\s+(?:tag|escrow|reconcile-npm|reconcile-smokes|dispatch-audit|record-audit-dispatch|correlate-audit|publish-release|abandon)\b|2026-03-10[\s\S]*workflow_dispatch)/iu.test(
      value,
    )
  )
}

function executableIdentity(entry) {
  return canonicalJson({
    job: entry.job,
    stepIndex: entry.stepIndex,
    kind: entry.kind,
    value: entry.value,
  })
}

const WORKFLOW_KEYS = new Set([
  "concurrency",
  "defaults",
  "env",
  "jobs",
  "name",
  "on",
  "permissions",
  "run-name",
])
const JOB_KEYS = new Set([
  "concurrency",
  "container",
  "continue-on-error",
  "defaults",
  "env",
  "environment",
  "if",
  "name",
  "needs",
  "outputs",
  "permissions",
  "runs-on",
  "secrets",
  "services",
  "steps",
  "strategy",
  "timeout-minutes",
  "uses",
  "with",
])
const STEP_KEYS = new Set([
  "continue-on-error",
  "env",
  "id",
  "if",
  "name",
  "run",
  "shell",
  "timeout-minutes",
  "uses",
  "with",
  "working-directory",
])

function workflowDescriptor(workflow, classifications) {
  assertAllowedRecord(workflow, WORKFLOW_KEYS)
  if (!isRecord(workflow.jobs)) throw unauditedEntrypoint()
  const descriptor = omitField(workflow, "jobs")
  const jobs = Object.entries(workflow.jobs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, job]) => {
      assertAllowedRecord(job, JOB_KEYS)
      const hasSteps = Array.isArray(job.steps)
      const hasUses = typeof job.uses === "string"
      if (hasSteps === hasUses) throw unauditedEntrypoint()
      const steps = hasSteps
        ? job.steps.map((step, stepIndex) => {
            assertAllowedRecord(step, STEP_KEYS)
            const hasRun = typeof step.run === "string"
            const hasStepUses = typeof step.uses === "string"
            if (hasRun === hasStepUses) throw unauditedEntrypoint()
            const executable = {
              job: id,
              stepIndex,
              kind: hasRun ? "run" : "step-uses",
              value: hasRun ? step.run : step.uses,
            }
            const classification = classifications.get(executableIdentity(executable))
            if (!["safe", "publication"].includes(classification)) throw unauditedEntrypoint()
            return {
              classification,
              descriptor: snapshotDescriptor(step),
            }
          })
        : []
      return {
        classification: "safe",
        id,
        descriptor: omitField(job, "steps"),
        steps,
      }
    })
  return { classification: "safe", descriptor, jobs }
}

function omitField(value, omitted) {
  const result = Object.create(null)
  for (const key of Object.keys(value).sort()) {
    if (key === omitted) continue
    Object.defineProperty(result, key, {
      enumerable: true,
      value: snapshotDescriptor(value[key]),
    })
  }
  return result
}

function assertAllowedRecord(value, allowed) {
  if (!isRecord(value)) throw unauditedEntrypoint()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw unauditedEntrypoint()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) throw unauditedEntrypoint()
  }
}

function snapshotDescriptor(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || ancestors.has(value)) throw unauditedEntrypoint()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw unauditedEntrypoint()
      if (Reflect.ownKeys(value).length !== value.length + 1) throw unauditedEntrypoint()
      return value.map((_entry, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !("value" in descriptor)) throw unauditedEntrypoint()
        return snapshotDescriptor(descriptor.value, ancestors)
      })
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw unauditedEntrypoint()
    const result = Object.create(null)
    for (const key of Reflect.ownKeys(value).sort()) {
      if (typeof key !== "string") throw unauditedEntrypoint()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) throw unauditedEntrypoint()
      Object.defineProperty(result, key, {
        enumerable: true,
        value: snapshotDescriptor(descriptor.value, ancestors),
      })
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

function canonicalJson(value) {
  return JSON.stringify(snapshotDescriptor(value))
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function unauditedEntrypoint() {
  return new Error("Workflow entrypoint is not explicitly audited")
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
