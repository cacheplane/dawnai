# Security Code-Risk Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven live Dawn-owned CodeQL findings on exact `main` without weakening the real Vercel deployment lane, muting scanners, or adding broad dependency overrides.

**Architecture:** Keep the fixes at the boundaries Dawn owns. Evals and testing use identical private synchronous-regex adapters that snapshot the caller's expression through intrinsic accessors, cap the source at 4,096 UTF-16 code units and input at 65,536, and compile and match inside a fresh Node VM context with a hard 100 ms execution deadline; the release fault proxy constructs requests only from a validated loopback upstream and a normalized relative path; blog slugs are canonicalized at ingestion and encoded at both URL sinks; test-only source construction is replaced with data arguments; and the docs checker reuses one canonical heading parser instead of deleting tag-like substrings.

**Tech Stack:** Node.js 24 and `node:vm`, TypeScript 7, Vitest 4, `node:test`, React server rendering, CodeQL, pnpm 10.33

**Approved design:** `docs/superpowers/specs/2026-08-09-security-backlog-release-recovery-design.md`, Pull request 2

**Pinned starting point:** `4dc44b3ad6e9fdef04493db18e7e68afaaa70bdd`

---

## Publication containment

Before every commit and before merge, prove that workflow `260503756` (Release) and workflow `309127405` (Publish Chart) remain `disabled_manually` and have no non-completed runs. This pull request must not create a version candidate, enable or dispatch either workflow, publish npm packages or charts, or mutate GitHub alert dispositions.

The exact live CodeQL acceptance set is:

- `#25` high `js/polynomial-redos` in `packages/evals/src/scorers.ts`;
- `#26` medium `js/identity-replacement` in `packages/cli/test/test-command.test.ts`;
- `#27` and `#28` high `js/stored-xss` in the two blog cards;
- `#49` critical `js/request-forgery` in `scripts/release/test/support/fault-proxy.mjs`;
- `#50` medium `js/bad-code-sanitization` in `packages/cli/test/vercel-native-lane.test.ts`; and
- `#52` high `js/incomplete-multi-character-sanitization` in `scripts/check-docs.mjs`.

No alert may be dismissed or muted. PR CodeQL must make all seven absent from the exact head analysis, and the post-merge analysis must reconcile all seven to `fixed`.

## File structure

### Synchronous regular-expression policy

- Create `packages/evals/src/regex-safety.ts`: private evals adapter with shared source/input caps, a VM execution deadline, and stable errors.
- Create `packages/testing/src/regex-safety.ts`: private testing adapter with byte-for-byte equivalent behavior.
- Modify `packages/evals/src/scorers.ts`: compile the safe tester when `regex()` is constructed.
- Modify `packages/testing/src/matchers.ts`: route both public `toMatch()` helpers through the safe tester.
- Modify `packages/evals/test/scorers.test.ts` and `packages/testing/test/matchers.test.ts`: deadline, source/input-bound, intrinsic-accessor, flag, mutation, and statefulness regressions.
- Create `.changeset/bounded-regex-evaluation.md`: patch changes for `@dawn-ai/evals` and `@dawn-ai/testing`.

The adapters stay private; this change must not invent a public regex-safety API. Both define:

```ts
const MAX_REGEX_INPUT_CODE_UNITS = 65_536
const MAX_REGEX_SOURCE_CODE_UNITS = 4_096
const REGEX_EXECUTION_TIMEOUT_MS = 100
const OVERSIZED_REGEX_SOURCE_MESSAGE =
  "Regular expression source exceeds 4096 UTF-16 code units"
const OVERSIZED_REGEX_INPUT_MESSAGE =
  "Regular expression input exceeds 65536 UTF-16 code units"
const REGEX_TIMEOUT_MESSAGE =
  "Regular expression evaluation exceeded 100ms execution limit"

export function createSafeRegexTester(expression: RegExp): (input: string) => boolean
```

Construction snapshots the source and each supported flag through intrinsic `RegExp.prototype` accessors, so caller overrides and property traps cannot change the validated expression, then rejects an oversized source with `RangeError(OVERSIZED_REGEX_SOURCE_MESSAGE)`. The returned function rejects an oversized string with `RangeError(OVERSIZED_REGEX_INPUT_MESSAGE)` before invoking the engine. It compiles and tests a fresh expression in a fresh Node VM context using one constant script, disabled string/Wasm code generation, and the hard timeout. Only `ERR_SCRIPT_EXECUTION_TIMEOUT` is normalized to `RangeError(REGEX_TIMEOUT_MESSAGE)`; other failures propagate. This preserves JavaScript `RegExp` semantics while hard-bounding compile and match execution and leaving caller-owned `lastIndex` unchanged.

### Request, content, and scanner boundaries

- Modify `scripts/release/test/support/fault-proxy.mjs` and `scripts/release/test/fault-harness.integration.mjs` for explicit outbound request construction and raw-request tests.
- Modify the blog index, its tests, and both cards; add `apps/web/app/components/blog/post-cards.test.ts` using `createElement` rather than JSX so the existing web Vitest include pattern executes it.
- Modify `packages/cli/test/test-command.test.ts` for exact sentinel replacement.
- Modify `packages/cli/test/vercel-native-lane.test.ts` so dynamic paths are argv data rather than generated program text.
- Modify `scripts/check-docs.mjs` and `apps/web/app/components/docs/nav.test.ts` so maintained docs IDs come from the existing `markdownHeadings()` parser.

## Task 1: Add the bounded private regex policy

**Files:**
- Create: `packages/evals/src/regex-safety.ts`
- Create: `packages/testing/src/regex-safety.ts`
- Modify: `packages/evals/test/scorers.test.ts`
- Modify: `packages/testing/test/matchers.test.ts`

- [ ] **Step 1: Write the failing policy tests**

In both packages, add a child-process regression using the overlapping-alternative expression `/(a|aa)+$/u` and a rejecting input long enough to exceed the VM deadline. The child must use a constant `--eval` program, receive the module path as an argument, have its own outer process timeout, and require the exact stable timeout error:

```ts
expect(result.error).toBeUndefined()
expect(result.status).toBe(0)
expect(JSON.parse(result.stdout)).toEqual({
  name: "RangeError",
  message: "Regular expression evaluation exceeded 100ms execution limit",
})

const test = createSafeRegexTester(/\d+ items/iu)
expect(test("12 ITEMS")).toBe(true)
expect(test("none")).toBe(false)

const oversized = "a".repeat(65_537)
expect(() => createSafeRegexTester(/a+/u)(oversized)).toThrow(
  "Regular expression input exceeds 65536 UTF-16 code units",
)
```

Also require the 4,096/4,097 source boundary; the 65,536/65,537 input boundary; ordinary flags; intrinsic source/flag snapshots despite overridden instance accessors; fail-closed RegExp proxy handling without property-trap reads; mutation snapshots; and `g`/`y` expressions that return the same result across repeated calls while preserving a nonzero caller-owned `lastIndex`. Mirror the same contract in each package and assert exact error classes and messages. Do not cross-import either private adapter from the other package and do not export an adapter merely for parity testing.

- [ ] **Step 2: Run RED**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm --filter @dawn-ai/testing exec vitest --run --config vitest.config.ts \
    test/matchers.test.ts
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm --filter @dawn-ai/evals exec vitest --run --config vitest.config.ts \
    test/scorers.test.ts
```

Expected: fail because the private adapters do not exist; when replayed against the previous heuristic implementation, the child process exceeds its outer timeout for the accepted false-negative expression.

- [ ] **Step 3: Implement the two private adapters**

Use the exact constants, exceptions, intrinsic snapshots, constant VM script, fresh-context behavior, and order of checks above. Keep the files byte-for-byte equivalent. Add no runtime dependency, native addon, override, or heuristic pattern allow/deny list.

- [ ] **Step 4: Run GREEN and package checks**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm install --frozen-lockfile
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/testing test
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/evals test
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/testing typecheck
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/evals typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/evals/src/regex-safety.ts packages/testing/src/regex-safety.ts \
  packages/evals/test/scorers.test.ts packages/testing/test/matchers.test.ts
git commit -m "fix(security): bound synchronous regex evaluation"
```

## Task 2: Route evals and testing through the policy

**Files:**
- Modify: `packages/evals/src/scorers.ts`
- Modify: `packages/evals/test/scorers.test.ts`
- Modify: `packages/testing/src/matchers.ts`
- Modify: `packages/testing/test/matchers.test.ts`
- Create: `.changeset/bounded-regex-evaluation.md`

- [ ] **Step 1: Write call-site RED tests**

Test the public APIs, not only the adapters:

- ordinary overlapping-alternative expressions preserve normal JavaScript matching semantics when they finish within the budget;
- both public API paths invoke the same private hard-bounded tester whose catastrophic-match regression runs in a child process;
- eval scoring rejects oversized `finalMessage` before evaluation;
- `expectFinalMessage(...).toMatch()` and `expectSystemPrompt(...).toMatch()` enforce the same policy;
- ordinary flags and matching semantics remain intact; and
- repeated global/sticky calls are deterministic and preserve the input expression's `lastIndex`.

- [ ] **Step 2: Run RED**

Run the two focused test files. Expected: current direct `RegExp.prototype.test` call sites fail the policy and statefulness cases.

- [ ] **Step 3: Implement the minimal integrations**

In `regex()`, create the tester once before returning the scorer. In both testing matchers, create and invoke the private tester instead of calling `re.test()` directly. Do not truncate inputs or silently convert a rejection to a failed match.

- [ ] **Step 4: Add the patch changeset**

```md
---
"@dawn-ai/evals": patch
"@dawn-ai/testing": patch
---

Evaluate regular expression compilation and matching inside a fresh, time-bounded
Node context, reject over-limit expression sources and matcher inputs, and make
global and sticky expression matching deterministic across repeated calls.
```

- [ ] **Step 5: Verify and commit**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/testing test
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/evals test
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/testing build
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/evals build
git add packages/evals/src/scorers.ts packages/evals/test/scorers.test.ts \
  packages/testing/src/matchers.ts packages/testing/test/matchers.test.ts \
  .changeset/bounded-regex-evaluation.md
git commit -m "fix(evals): enforce safe regex matching"
```

## Task 3: Close the fault-proxy request-forgery sink

**Files:**
- Modify: `scripts/release/test/support/fault-proxy.mjs`
- Modify: `scripts/release/test/fault-harness.integration.mjs`

- [ ] **Step 1: Add raw-request RED cases**

Use `node:http`, not `fetch`, so the client does not normalize the test target. Record the upstream method, target, `Host`, `Accept`, and response behavior. Cover:

- an ordinary relative path plus an exact query round trip;
- an absolute-form target for the configured loopback origin;
- a scheme-relative target;
- a different loopback port;
- a metadata-service IP target;
- a redirect response that is returned without following it;
- an invalid configured upstream; and
- an attacker-supplied inbound `Host` that must not reach upstream.

Expected RED: the current proxy forwards inbound `Host`, and its outbound URL object retains inbound-derived request construction.

- [ ] **Step 2: Implement explicit request options**

Parse and validate the inbound target, retain only normalized `pathname + search`, and call `http.request()` with an explicit object built from the already validated configured upstream:

```js
{
  protocol: upstream.protocol,
  hostname: upstream.hostname,
  port: upstream.port,
  method: request.method,
  path: `${target.pathname}${target.search}`,
  headers: typeof request.headers.accept === "string"
    ? { Accept: request.headers.accept }
    : {},
}
```

Never forward inbound `Host`, credentials, fragments, or another origin. Preserve all existing deadlines, byte bounds, error handling, loopback binding, and redirect non-following.

- [ ] **Step 3: Run focused recovery tests**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  node --test scripts/release/test/fault-harness.integration.mjs
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm test:release-fault-harness
```

Expected: all pass on two consecutive runs.

- [ ] **Step 4: Commit**

```bash
git add scripts/release/test/support/fault-proxy.mjs \
  scripts/release/test/fault-harness.integration.mjs
git commit -m "fix(security): isolate release fault proxy targets"
```

## Task 4: Canonicalize blog route identity

**Files:**
- Modify: `apps/web/app/components/blog/post-index.ts`
- Modify: `apps/web/app/components/blog/post-index.test.ts`
- Modify: `apps/web/app/components/blog/PostCard.tsx`
- Modify: `apps/web/app/components/blog/FeaturedPostCard.tsx`
- Create: `apps/web/app/components/blog/post-cards.test.ts`

- [ ] **Step 1: Write ingestion RED tests**

Require both frontmatter and filename-derived slugs to match:

```ts
/^[a-z0-9]+(?:-[a-z0-9]+)*$/
```

Table-test protocol-like text, network-path text, single and double quotes, backslashes, `.` and `..`, controls, uppercase, leading/trailing hyphens, and repeated hyphens. A non-string frontmatter slug must also fail. Error text names the source filename but must not echo the rejected slug.

Require valid explicit and filename-derived lowercase slugs to round-trip unchanged.

- [ ] **Step 2: Write route-sink RED tests**

In `post-cards.test.ts`, use `createElement` and `renderToStaticMarkup` so the current `app/**/*.test.ts` Vitest pattern executes the file. Assert both cards render `/blog/valid-slug`. Also construct an adversarial `Post` directly and require the emitted href to encode it as one route segment rather than creating a protocol, network path, or additional path segment.

- [ ] **Step 3: Run RED**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm --filter @dawn-ai/web exec vitest --run --config vitest.config.ts \
    app/components/blog/post-index.test.ts app/components/blog/post-cards.test.ts
```

Expected: invalid slugs are accepted and both card sinks interpolate raw values.

- [ ] **Step 4: Implement ingestion validation and sink encoding**

Validate the chosen slug inside `parsePost()` before constructing `Post`. At both card sinks use:

```tsx
href={`/blog/${encodeURIComponent(post.slug)}`}
```

Do not add a compatibility path for previously invalid slugs.

- [ ] **Step 5: Verify web behavior**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/web test
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/web typecheck
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/web build
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/components/blog/post-index.ts \
  apps/web/app/components/blog/post-index.test.ts \
  apps/web/app/components/blog/PostCard.tsx \
  apps/web/app/components/blog/FeaturedPostCard.tsx \
  apps/web/app/components/blog/post-cards.test.ts
git commit -m "fix(web): validate blog route slugs"
```

## Task 5: Remove test-only code-construction ambiguities

**Files:**
- Modify: `packages/cli/test/test-command.test.ts`
- Modify: `packages/cli/test/vercel-native-lane.test.ts`

- [ ] **Step 1: Write sentinel-replacement RED cases**

Add separate focused tests proving `replaceInFile()` rejects a missing sentinel and rejects `search === replacement`. Run the named test before changing the helper and require both new assertions to fail.

- [ ] **Step 2: Make sentinel replacement fail closed**

Change the helper to reject `search === replacement` and a source that does not contain `search`, then remove the identity replacement from `scenarioModule(...)`. The one real `__SERVER_URL__` replacement remains.

- [ ] **Step 3: Verify the CLI scenario**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
    test/test-command.test.ts
```

Expected: pass, and no `replace("__SERVER_URL__", "__SERVER_URL__")` remains.

- [ ] **Step 4: Record the scanner-only RED for Vercel child source**

The pinned baseline CodeQL alert `#50` is the RED evidence for this static-dataflow finding. The existing finite-deadline child-runner test must remain green before and after the change; do not claim that unchanged runtime behavior is a behavioral RED.

- [ ] **Step 5: Move Vercel child data to argv**

Keep the parent and grandchild program text as constants. Invoke the parent as:

```ts
args: ["-e", parentScript, grandchildScript, sentinel]
```

The parent reads the child program and sentinel from `process.argv[1]` and `[2]`; the child reads its sentinel from `process.argv[1]`. No path or other runtime value may be interpolated into JavaScript source. Preserve the existing finite-deadline and process-tree cleanup assertions.

- [ ] **Step 6: Verify the native child test**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
    test/vercel-native-lane.test.ts \
    -t "runs sanitized explicit-env children and kills them at a finite deadline"
```

Expected: pass without Vercel credentials because this is the local child-runner unit path. Exact-head CodeQL must later prove alert `#50` absent; that is the GREEN evidence for the static finding.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/test/test-command.test.ts \
  packages/cli/test/vercel-native-lane.test.ts
git commit -m "test(cli): remove dynamic source construction"
```

## Task 6: Reuse the canonical docs heading parser

**Files:**
- Modify: `scripts/check-docs.mjs`
- Modify: `apps/web/app/components/docs/nav.test.ts`

- [ ] **Step 1: Extract a behavior-preserving maintained-heading seam**

Extract the current duplicated maintained-page heading-ID calculation into a private helper in `scripts/check-docs.mjs`, without changing its normalization behavior. Add a narrow `--analyze-maintained-heading-ids` fixture mode that returns this helper's IDs for a supplied Markdown source. The production `maintainedDocsPages` construction and the fixture mode must both call this same helper; do not create a test-only copy of the parser.

- [ ] **Step 2: Add the heading-identity RED matrix**

In `nav.test.ts`, invoke `--analyze-maintained-heading-ids` with headings containing inline code, ordinary Markdown links, tag-like nested text that would recreate `<script>` after substring deletion, and repeated headings. Require deterministic GitHub-style IDs and preserved code-span contents. The nested tag-like fixture must fail under the extracted duplicate sanitizer, proving the test reaches alert `#52`'s maintained-page path.

- [ ] **Step 3: Run RED**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm --filter @dawn-ai/web exec vitest --run --config vitest.config.ts \
    app/components/docs/nav.test.ts
```

Expected: the shared maintained-page analyzer diverges on the nested tag-like identity fixture while exercising the same helper used by production link validation.

- [ ] **Step 4: Remove the duplicate sanitizer path**

Change the shared maintained-heading helper to derive IDs from:

```js
const ids = new Set(markdownHeadings(source).map(({ id }) => id))
```

Delete the remaining `.replace(/<[^>]+>/g, "")` and the rest of the duplicated `matchAll`/slugger normalization. Do not replace it with another sanitizer loop. The checker computes identity; it never renders HTML.

- [ ] **Step 5: Verify docs and web**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/web test
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" node scripts/check-docs.mjs
```

Expected: all pass and the duplicate deletion regex is absent.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-docs.mjs apps/web/app/components/docs/nav.test.ts
git commit -m "fix(docs): unify heading identity parsing"
```

## Task 7: Verify, review, and merge the exact security head

**Files:**
- Verify all changed files
- No evidence document may claim post-merge results before they exist

- [ ] **Step 1: Run focused security verification**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/testing test
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/evals test
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm --filter @dawn-ai/cli exec vitest --run --config vitest.config.ts \
    test/test-command.test.ts test/vercel-native-lane.test.ts
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @dawn-ai/web test
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm test:release-fault-harness
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" node scripts/check-docs.mjs
```

- [ ] **Step 2: Run scoped hygiene**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm lint
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" \
  pnpm exec biome lint \
    --config-path packages/config-biome/biome.json \
    packages/evals/test/scorers.test.ts
git diff --check origin/main...HEAD
node scripts/check-changesets.mjs
```

- [ ] **Step 3: Run the complete Definition of Done**

```bash
PATH="/Users/blove/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm ci:validate
```

Expected: all 14 repository gates and framework/runtime/smoke lanes pass.

- [ ] **Step 4: Re-prove publication containment**

Read workflow IDs `260503756` and `309127405`; require `disabled_manually` and no queued, in-progress, waiting, requested, or pending run.

- [ ] **Step 5: Open the pull request and require exact-head checks**

Push the branch, open a non-draft pull request, and require every repository-owned CI lane plus CodeQL on the exact head. The PR title/body and commits must not mention coding assistants.

- [ ] **Step 6: Run two-stage independent review**

First request specification compliance against the approved security design and this plan. After every spec finding is fixed and re-reviewed, request code-quality/security review of the exact diff. Fix all Critical or Important findings with new RED-to-GREEN evidence and re-review.

- [ ] **Step 7: Merge and reconcile**

Merge only the exact reviewed green head. Record the merge SHA, wait for exact-main CI and CodeQL, and confirm alerts `25`, `26`, `27`, `28`, `49`, `50`, and `52` are all `fixed` with no dismissal. Keep Release and Publish Chart disabled for the following ownership-cutover PR.
