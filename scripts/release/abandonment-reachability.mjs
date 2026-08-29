import {
  canonicalizeReleaseWorkflow,
  loadAbandonmentWorkflowPolicy,
  parseReleaseWorkflow,
} from "./abandonment-workflow-policy.mjs"
import { snapshotJson } from "./adapter-normalize.mjs"

const ENVIRONMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/u
const DISABLED_INPUTS = Object.freeze(["version", "commitSha", "operation"])
const DISABLED_OPERATION_OPTIONS = Object.freeze(["reconcile"])
const PROTECTED_INPUTS = Object.freeze(["version", "commitSha", "operation", "reason"])
const PROTECTED_OPERATION_OPTIONS = Object.freeze(["reconcile", "abandon"])
const PROTECTED_ABANDON_JOB_FIELDS = Object.freeze([
  "needs",
  "if",
  "runs-on",
  "timeout-minutes",
  "environment",
  "permissions",
  "steps",
])
const POLICY = loadAbandonmentWorkflowPolicy()

const MANUAL_INTENT_STEP = Object.freeze({
  name: "Validate manual intent",
  env: Object.freeze({
    OPERATION: workflowExpression("inputs.operation"),
    REASON: workflowExpression("inputs.reason"),
  }),
  run: [
    'if [[ "$OPERATION" == "reconcile" && -n "$REASON" ]]; then',
    '  echo "reason is forbidden for reconcile" >&2',
    "  exit 2",
    "fi",
    'if [[ "$OPERATION" == "abandon" && -z "$REASON" ]]; then',
    '  echo "reason is required for abandon" >&2',
    "  exit 2",
    "fi",
    "",
  ].join("\n"),
})

const PROTECTED_ROUTE_STEP = Object.freeze({
  name: "Continue at the exact tag or relay once",
  id: "route",
  env: Object.freeze({
    GITHUB_TOKEN: workflowExpression("github.token"),
    VERSION: workflowExpression("needs.detect.outputs.candidate_version"),
    COMMIT_SHA: workflowExpression("needs.detect.outputs.candidate_sha"),
    OPERATION: workflowExpression("inputs.operation"),
  }),
  run: [
    'if [[ "$GITHUB_EVENT_NAME" == "workflow_dispatch" &&',
    '      "$GITHUB_REF" == "refs/tags/v' + shellVariable("VERSION") + '" &&',
    '      "$GITHUB_SHA" == "$COMMIT_SHA" ]]; then',
    "  printf 'continue=true\\n' >> \"$GITHUB_OUTPUT\"",
    "  exit 0",
    "fi",
    'if [[ "$OPERATION" == "abandon" ]]; then',
    '  echo "abandonment must be dispatched at refs/tags/v' + shellVariable("VERSION") + '" >&2',
    "  exit 2",
    "fi",
    "",
    'WORKFLOW_PATH=".github/workflows/release.yml"',
    'WORKFLOW_ID="$(node -e \'process.stdout.write(encodeURIComponent(process.argv[1]))\' "$WORKFLOW_PATH")"',
    'BODY="$(node -e \'process.stdout.write(JSON.stringify({ref:"v"+process.env.VERSION,inputs:{version:process.env.VERSION,commitSha:process.env.COMMIT_SHA,operation:"reconcile"}}))\')"',
    'STATUS="$(curl --silent --show-error --output "$RUNNER_TEMP/dispatch.json" --write-out \'%{http_code}\' \\',
    "  --request POST \\",
    "  --header 'Accept: application/vnd.github+json' \\",
    '  --header "Authorization: Bearer $GITHUB_TOKEN" \\',
    "  --header 'X-GitHub-Api-Version: 2026-03-10' \\",
    '  "https://api.github.com/repos/$GITHUB_REPOSITORY/actions/workflows/$WORKFLOW_ID/dispatches" \\',
    '  --data "$BODY")"',
    'test "$STATUS" = "200"',
    "printf 'continue=false\\n' >> \"$GITHUB_OUTPUT\"",
    "",
  ].join("\n"),
})

const DISABLED_ROUTE_STEP = Object.freeze({
  name: "Continue at the exact tag or relay once",
  id: "route",
  env: Object.freeze({
    GITHUB_TOKEN: workflowExpression("github.token"),
    VERSION: workflowExpression("needs.detect.outputs.candidate_version"),
    COMMIT_SHA: workflowExpression("needs.detect.outputs.candidate_sha"),
  }),
  run: [
    'if [[ "$GITHUB_EVENT_NAME" == "workflow_dispatch" &&',
    '      "$GITHUB_REF" == "refs/tags/v' + shellVariable("VERSION") + '" &&',
    '      "$GITHUB_SHA" == "$COMMIT_SHA" ]]; then',
    "  printf 'continue=true\\n' >> \"$GITHUB_OUTPUT\"",
    "  exit 0",
    "fi",
    "",
    'WORKFLOW_PATH=".github/workflows/release.yml"',
    'WORKFLOW_ID="$(node -e \'process.stdout.write(encodeURIComponent(process.argv[1]))\' "$WORKFLOW_PATH")"',
    'BODY="$(node -e \'process.stdout.write(JSON.stringify({ref:"v"+process.env.VERSION,inputs:{version:process.env.VERSION,commitSha:process.env.COMMIT_SHA,operation:"reconcile"}}))\')"',
    'STATUS="$(curl --silent --show-error --output "$RUNNER_TEMP/dispatch.json" --write-out \'%{http_code}\' \\',
    "  --request POST \\",
    "  --header 'Accept: application/vnd.github+json' \\",
    '  --header "Authorization: Bearer $GITHUB_TOKEN" \\',
    "  --header 'X-GitHub-Api-Version: 2026-03-10' \\",
    '  "https://api.github.com/repos/$GITHUB_REPOSITORY/actions/workflows/$WORKFLOW_ID/dispatches" \\',
    '  --data "$BODY")"',
    'test "$STATUS" = "200"',
    "printf 'continue=false\\n' >> \"$GITHUB_OUTPUT\"",
    "",
  ].join("\n"),
})

const PROTECTED_ABANDON_IF = [
  "github.event_name == 'workflow_dispatch'",
  "needs.tag.outputs.continue == 'true'",
  "github.ref == format('refs/tags/v{0}', inputs.version)",
  "github.sha == needs.detect.outputs.candidate_sha",
  "inputs.version == needs.detect.outputs.candidate_version",
  "inputs.commitSha == needs.detect.outputs.candidate_sha",
  "inputs.operation == 'abandon'",
  'contains(fromJSON(\'["CANDIDATE_TAGGED","ARTIFACTS_PREPARED","ARTIFACTS_ATTESTED","CANDIDATE_ESCROWED"]\'), needs.detect.outputs.state)',
].join(" && ")

const PROTECTED_PERMISSIONS = Object.freeze({
  actions: "read",
  attestations: "read",
  checks: "read",
  contents: "write",
})

const ABANDON_CHECKOUT_STEP = Object.freeze({
  name: "Checkout exact candidate",
  uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  with: Object.freeze({
    "fetch-depth": 0,
    ref: workflowExpression("needs.detect.outputs.candidate_sha"),
    "persist-credentials": false,
  }),
})

const ABANDON_SETUP_STEP = Object.freeze({
  name: "Setup Node.js",
  uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  with: Object.freeze({ "node-version": "24.19.0" }),
})

const CONTEXT_STEP = Object.freeze({
  name: "Derive fresh protected abandonment context",
  env: Object.freeze({ GITHUB_TOKEN: workflowExpression("github.token") }),
  run: [
    "node scripts/release/cli.mjs abandonment-context \\",
    '  --version "' + workflowExpression("needs.detect.outputs.candidate_version") + '" \\',
    '  --commit-sha "' + workflowExpression("needs.detect.outputs.candidate_sha") + '" \\',
    '  --output "$RUNNER_TEMP/artifact-context.json"',
    "",
  ].join("\n"),
})

const ABANDON_STEP = Object.freeze({
  name: "Permanently abandon pre-publication candidate",
  env: Object.freeze({
    GITHUB_TOKEN: workflowExpression("github.token"),
    REASON: workflowExpression("inputs.reason"),
  }),
  run: [
    "node scripts/release/cli.mjs abandon \\",
    '  --version "' + workflowExpression("needs.detect.outputs.candidate_version") + '" \\',
    '  --commit-sha "' + workflowExpression("needs.detect.outputs.candidate_sha") + '" \\',
    '  --reason "$REASON" \\',
    '  --artifact-context "$RUNNER_TEMP/artifact-context.json"',
    "",
  ].join("\n"),
})

export function classifyReleaseWorkflowAbandonment(bytes, options) {
  const { abandonmentEnvironment } = normalizeOptions(options)
  const workflow = parseReleaseWorkflow(bytes)
  const mode = classifyTopology(workflow, abandonmentEnvironment)
  const canonical = canonicalizeReleaseWorkflow(workflow)
  const matches = POLICY.variants.filter(
    (variant) => variant.canonicalSha256 === canonical.canonicalSha256,
  )
  if (matches.length !== 1 || matches[0].mode !== mode) throw unknownVariant()
  return mode
}

export function aggregateReleaseWorkflowAbandonment(modes) {
  let snapshot
  try {
    snapshot = snapshotJson(modes)
  } catch (error) {
    throw invalidAggregate(error)
  }
  if (!Array.isArray(snapshot) || snapshot.length === 0) throw invalidAggregate()
  let hasDisabled = false
  let hasProtected = false
  for (const mode of snapshot) {
    if (mode === "disabled") hasDisabled = true
    else if (mode === "protected") hasProtected = true
    else if (mode !== "absent") throw invalidAggregate()
  }
  if (hasProtected) return "protected"
  if (hasDisabled) return "disabled"
  throw invalidAggregate()
}

function classifyTopology(workflow, abandonmentEnvironment) {
  if (workflow.name !== "Release") throw invalidTopology()
  const dispatch = requiredRecord(requiredRecord(workflow.on).workflow_dispatch)
  const inputs = requiredRecord(dispatch.inputs)
  const jobs = requiredRecord(workflow.jobs)
  const tag = requiredConcreteJob(jobs.tag)
  const mode = classifyInputs(inputs)
  if (mode === "disabled") {
    assertDisabledTopology(jobs, tag)
    return mode
  }
  assertProtectedTopology(jobs, tag, abandonmentEnvironment)
  return mode
}

function classifyInputs(inputs) {
  const names = Object.keys(inputs)
  if (sameStringSets(names, DISABLED_INPUTS)) {
    assertIdentityInput(inputs.version)
    assertIdentityInput(inputs.commitSha)
    assertOperationInput(inputs.operation, DISABLED_OPERATION_OPTIONS)
    return "disabled"
  }
  if (sameStringSets(names, PROTECTED_INPUTS)) {
    assertIdentityInput(inputs.version)
    assertIdentityInput(inputs.commitSha)
    assertOperationInput(inputs.operation, PROTECTED_OPERATION_OPTIONS)
    assertReasonInput(inputs.reason)
    return "protected"
  }
  throw invalidTopology()
}

function assertIdentityInput(value) {
  assertInputDescriptor(value, ["description", "required", "type"])
  if (value.required !== true || value.type !== "string") throw invalidTopology()
}

function assertOperationInput(value, options) {
  assertInputDescriptor(value, ["description", "required", "type", "default", "options"])
  if (
    value.required !== true ||
    value.type !== "choice" ||
    value.default !== "reconcile" ||
    !sameStrings(value.options, options)
  ) {
    throw invalidTopology()
  }
}

function assertReasonInput(value) {
  assertInputDescriptor(value, ["description", "required", "type"])
  if (value.required !== false || value.type !== "string") throw invalidTopology()
}

function assertInputDescriptor(value, fields) {
  if (
    !isRecord(value) ||
    !sameStringSets(Object.keys(value), fields) ||
    typeof value.description !== "string" ||
    value.description.length === 0
  ) {
    throw invalidTopology()
  }
}

function assertDisabledTopology(jobs, tag) {
  if (
    Object.hasOwn(jobs, "abandon") ||
    tag.steps.length !== 5 ||
    !sameValue(tag.steps[4], DISABLED_ROUTE_STEP)
  ) {
    throw invalidTopology()
  }
}

function assertProtectedTopology(jobs, tag, abandonmentEnvironment) {
  const abandon = requiredConcreteJob(jobs.abandon)
  if (
    tag.steps.length !== 6 ||
    !sameValue(tag.steps[2], MANUAL_INTENT_STEP) ||
    !sameValue(tag.steps[5], PROTECTED_ROUTE_STEP) ||
    !sameStringSets(Object.keys(abandon), PROTECTED_ABANDON_JOB_FIELDS) ||
    !sameStrings(abandon.needs, ["detect", "tag"]) ||
    abandon.if !== PROTECTED_ABANDON_IF ||
    abandon["runs-on"] !== "ubuntu-24.04" ||
    abandon["timeout-minutes"] !== 20 ||
    abandon.environment !== abandonmentEnvironment ||
    !sameValue(abandon.permissions, PROTECTED_PERMISSIONS) ||
    abandon.steps.length !== 4 ||
    !sameValue(abandon.steps[0], ABANDON_CHECKOUT_STEP) ||
    !sameValue(abandon.steps[1], ABANDON_SETUP_STEP) ||
    !sameValue(abandon.steps[2], CONTEXT_STEP) ||
    !sameValue(abandon.steps[3], ABANDON_STEP)
  ) {
    throw invalidTopology()
  }
}

function normalizeOptions(value) {
  let snapshot
  try {
    snapshot = snapshotJson(value)
  } catch (error) {
    throw invalidTopology(error)
  }
  if (
    !isRecord(snapshot) ||
    !sameStringSets(Object.keys(snapshot), ["abandonmentEnvironment"]) ||
    typeof snapshot.abandonmentEnvironment !== "string" ||
    !ENVIRONMENT_PATTERN.test(snapshot.abandonmentEnvironment)
  ) {
    throw invalidTopology()
  }
  return snapshot
}

function requiredRecord(value) {
  if (!isRecord(value)) throw invalidTopology()
  return value
}

function requiredConcreteJob(value) {
  const job = requiredRecord(value)
  if (!Array.isArray(job.steps)) throw invalidTopology()
  return job
}

function sameStrings(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => typeof value === "string" && value === right[index])
  )
}

function sameStringSets(left, right) {
  const sortedLeft = [...left].sort(compareText)
  const sortedRight = [...right].sort(compareText)
  return sameStrings(sortedLeft, sortedRight)
}

function sameValue(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    )
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort(compareText)
  const rightKeys = Object.keys(right).sort(compareText)
  return (
    sameStrings(leftKeys, rightKeys) && leftKeys.every((key) => sameValue(left[key], right[key]))
  )
}

function workflowExpression(value) {
  return "$" + "{{ " + value + " }}"
}

function shellVariable(value) {
  return "$" + "{" + value + "}"
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

function invalidTopology(cause) {
  return new TypeError("Release workflow abandonment topology is invalid", {
    ...(cause === undefined ? {} : { cause }),
  })
}

function unknownVariant() {
  return new TypeError("Release workflow is not a reviewed variant")
}

function invalidAggregate(cause) {
  return new TypeError("Release workflow abandonment aggregate is invalid", {
    ...(cause === undefined ? {} : { cause }),
  })
}
