// Runtime dependencies are trusted read/transport adapters. Requests never carry authority.
import { createHash } from "node:crypto"
import { types } from "node:util"
import { requestGitHubJson } from "../adapters/github-write-transport.mjs"
import { captureRecoveryAuthority, captureRecoveryEligibility } from "./authority.mjs"
import {
  buildRecoveryVerificationSet,
  observeRecoveryLaneEvidence,
  readRecoveryEvidencePolicy,
  recoveryProvenanceName,
  recoveryVerificationName,
  verifyRecoveryEscrowProducer,
  verifyRecoveryProvenanceBindings,
} from "./evidence-proof.mjs"
import {
  parseRecoveryReleaseMarker,
  renderRecoveryFinalMetadata,
  renderRecoveryReleaseBody,
} from "./metadata.mjs"
import { planRecovery } from "./model.mjs"
import { normalizeRecoveryAssetInventory, observeRecoveryCandidate } from "./observe.mjs"
import { RECOVERY_RETRY, recoveryMethods, runRecoveryRead } from "./policy.mjs"
import {
  canonicalRecoveryBytes,
  parseRecovery,
  RECOVERY_LIMITS,
  snapshotRecoveryData,
} from "./schema.mjs"

const unsettled = new WeakMap()
const hash = (value) => createHash("sha256").update(value).digest("hex")
function requireThat(value, message) {
  if (!value) throw new Error(`Recovery writer blocked: ${message}`)
}
function same(a, b, message) {
  requireThat(JSON.stringify(stable(a)) === JSON.stringify(stable(b)), message)
}
function stable(v) {
  return Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v
}
function exact(input, fields) {
  const value = snapshotRecoveryData(input, 2 * RECOVERY_LIMITS.selectionBytes)
  requireThat(
    value &&
      typeof value === "object" &&
      Object.keys(value).sort().join(" ") === fields.split(" ").sort().join(" "),
    "exact request fields required",
  )
  return value
}
function data(value, name) {
  requireThat(
    value !== null &&
      typeof value === "object" &&
      !types.isProxy(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    "safe dependency container required",
  )
  const d = Object.getOwnPropertyDescriptor(value, name)
  requireThat(d && Object.hasOwn(d, "value"), `safe ${name} dependency required`)
  return d.value
}
function snapshotObservation(value) {
  const result = {}
  for (const key of ["github", "git", "npm", "npmAuditFactory", "attestations"])
    result[key] = data(value, key)
  return result
}
export function recoveryAdoptionAssetName(executor) {
  return `recovery-v2-adoption-${executor.controllerSha}-${executor.runId}-${executor.runAttempt}-${executor.jobId}.json`
}
export function createRecoveryWriter(config, dependencies) {
  config = exact(config, "repository token")
  requireThat(
    typeof config.repository === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(config.repository),
    "repository required",
  )
  requireThat(
    config.token === null ||
      (typeof config.token === "string" &&
        config.token.length > 0 &&
        config.token.length <= 4096 &&
        !/[\r\n]/u.test(config.token)),
    "token invalid",
  )
  const observation = snapshotObservation(data(dependencies, "observation"))
  const authority = data(dependencies, "authority")
  const callbacks = recoveryMethods(authority, ["now", "sleep"])
  let previousTime = -1
  const now = () => {
    const value = callbacks.now()
    requireThat(
      Number.isSafeInteger(value) && value >= 0 && value >= previousTime,
      "monotonic bounded clock required",
    )
    previousTime = value
    return value
  }
  const { fetchImpl, observeImmutableReleasePolicy } = recoveryMethods(dependencies, [
    "fetchImpl",
    "observeImmutableReleasePolicy",
  ])
  const deadline = now() + RECOVERY_RETRY.phaseDeadlineMs
  const base = `https://api.github.com/repos/${config.repository}`
  const uploads = `https://uploads.github.com/repos/${config.repository}`
  const transportIdentity = data(dependencies, "fetchImpl")
  const shared = unsettled.get(transportIdentity) ?? { pending: new Set(), owner: null }
  unsettled.set(transportIdentity, shared)
  const pending = shared.pending
  const owner = Symbol("recovery transaction")
  requireThat(pending.size === 0, "unsettled write; resume only after settlement")
  let stopped = false,
    busy = false
  const active = () =>
    requireThat(
      !stopped && now() < deadline,
      "invocation stopped; resume through fresh observation",
    )
  const track = (fn) => {
    const p = Promise.resolve().then(fn)
    pending.add(p)
    p.then(
      () => pending.delete(p),
      () => pending.delete(p),
    )
    return p
  }
  const fetchTracked = async (...args) => {
    const response = await track(() => fetchImpl(...args))
    const body = response.body
    const wrapped =
      body == null
        ? body
        : {
            getReader() {
              const reader = body.getReader()
              return {
                read: () => track(() => reader.read()),
                cancel: () => track(() => reader.cancel()),
              }
            },
            cancel: () => track(() => body.cancel()),
          }
    if (stopped) {
      if (wrapped) void wrapped.cancel().catch(() => {})
      throw new Error("Recovery write settled after invocation stopped")
    }
    return { status: response.status, headers: response.headers, body: wrapped }
  }
  const observe = async (args, override = {}) => {
    active()
    const result = await observeRecoveryCandidate({
      ...observation,
      candidate: args.candidate,
      controllerRef: args.expectedControllerSha,
      intentPath: args.intentPath,
      ...override,
    })
    active()
    requireThat(result.outcome !== "blocked", result.errors.join("; "))
    return result
  }
  const validate = (input, extra) => {
    const args = exact(
      input,
      `candidate expectedControllerSha intentPath expectedBodySha256${extra ? ` ${extra}` : ""}`,
    )
    parseRecovery({
      schemaVersion: 2,
      kind: "recovery-adoption-intent",
      candidate: args.candidate,
      policySha256: "0".repeat(64),
      legacyBodySha256: args.expectedBodySha256,
      legacyPhase: "NPM_COMPLETE",
      operations: ["adopt"],
    })
    requireThat(
      args.candidate.repository === config.repository &&
        /^[a-f0-9]{40}$/u.test(args.expectedControllerSha),
      "request identity differs",
    )
    requireThat(
      /^scripts\/release\/recovery-adoptions\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(
        args.intentPath,
      ),
      "intent path invalid",
    )
    return args
  }
  const capture = async (args, current, operation) => {
    const request = { candidate: args.candidate, expectedControllerSha: args.expectedControllerSha }
    const proof =
      current.phase === "NPM_COMPLETE"
        ? await captureRecoveryAuthority(
            {
              ...request,
              intentPath: args.intentPath,
              legacyBodySha256: args.expectedBodySha256,
              operation,
            },
            authority,
          )
        : await captureRecoveryEligibility(request, authority)
    active()
    if (current.facts.policySha256)
      same(proof.policySha256, current.facts.policySha256, "accepted policy changed")
    return proof
  }
  const compare = async (args, current) => {
    const github = recoveryMethods(observation.github, [
      "getRelease",
      "listReleaseAssets",
      "getRef",
      "getGitTag",
    ])
    const read = async (method, input) => {
      const result = await runRecoveryRead(
        { phaseDeadline: deadline, responseBytes: 16 * 1024 * 1024 },
        () => github[method](input),
        { now, sleep: callbacks.sleep },
      )
      active()
      requireThat(result.status === "PRESENT", "fresh comparison unavailable")
      return result.value
    }
    same(
      await read("getRelease", { releaseId: args.candidate.releaseId }),
      current.facts.release,
      "release changed before mutation",
    )
    same(
      normalizeRecoveryAssetInventory(
        await read("listReleaseAssets", { releaseId: args.candidate.releaseId }),
      ),
      current.facts.assets,
      "asset inventory changed before mutation",
    )
    const ref = await read("getRef", { ref: `tags/${args.candidate.tag}` })
    requireThat(
      ref.object?.type === "tag" && ref.object.sha === args.candidate.tagObjectSha,
      "tag changed before mutation",
    )
    const tag = await read("getGitTag", { tagSha: args.candidate.tagObjectSha })
    requireThat(
      tag.tag === args.candidate.tag &&
        tag.object?.type === "commit" &&
        tag.object.sha === args.candidate.candidateSha,
      "tag target changed before mutation",
    )
  }
  const send = async (request) => {
    active()
    requireThat(shared.owner === owner && pending.size === 0, "unsettled or competing write")
    const timeoutMs = Math.min(RECOVERY_RETRY.readTimeoutMs, deadline - now())
    let timer,
      httpStatus = null
    const work = requestGitHubJson(
      {
        fetchImpl: fetchTracked,
        token: config.token,
        timeoutMs,
        maxResponseBytes: RECOVERY_LIMITS.selectionBytes,
      },
      { ...request, apiVersion: "2022-11-28" },
    )
    try {
      const response = await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("Recovery write uncertain after timeout; later resume required")),
            timeoutMs,
          )
        }),
      ])
      httpStatus = response.httpStatus
      requireThat(
        [200, 201].includes(response.httpStatus),
        `write uncertain after HTTP ${response.httpStatus}; later resume required`,
      )
    } catch {
      stopped = true
      const error = new Error(
        `Recovery write uncertain${httpStatus === null ? "" : ` after HTTP ${httpStatus}`}; invocation stopped, resume through fresh observation`,
      )
      error.httpStatus = httpStatus
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  const transaction = async (fn) => {
    active()
    requireThat(
      !busy && shared.owner === null && pending.size === 0,
      "unsettled write or active invocation; resume only after settlement",
    )
    busy = true
    shared.owner = owner
    let timer
    try {
      return await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => {
              stopped = true
              reject(new Error("Recovery phase deadline expired; resume required"))
            },
            Math.max(1, deadline - now()),
          )
        }),
      ])
    } catch (error) {
      stopped = true
      throw error
    } finally {
      busy = false
      shared.owner = null
      clearTimeout(timer)
    }
  }
  const mutable = (args, current) => {
    requireThat(
      current.facts.release.draft === true && current.facts.release.immutable === false,
      "exact mutable draft required",
    )
    requireThat(
      hash(current.facts.release.body) === args.expectedBodySha256,
      "release body changed",
    )
  }
  const immutablePolicy = async (args) => {
    const envelope = await runRecoveryRead(
      { phaseDeadline: deadline },
      async () => ({
        status: "PRESENT",
        value: await observeImmutableReleasePolicy({ candidate: args.candidate }),
      }),
      { now, sleep: callbacks.sleep },
    )
    requireThat(envelope.status === "PRESENT", "immutable release policy observation unavailable")
    const result = envelope.value
    active()
    requireThat(
      result?.repository === args.candidate.repository && result.enabled === true,
      "repository-bound immutable release policy must be enabled",
    )
  }
  const planningFacts = (current, authorityProof) => ({
    ...current.facts,
    ...authorityProof,
    publication: null,
    fresh: {
      candidate: current.candidate,
      tag: current.facts.tag,
      registry: current.facts.npmEvidence,
      assets: current.facts.assets,
      immutableReleasePolicy: "enabled",
      ownership: "exclusive",
    },
  })

  return Object.freeze({
    uploadRecoveryAsset(input) {
      return transaction(async () => {
        const args = validate(input, "name contentBase64")
        requireThat(
          typeof args.contentBase64 === "string" &&
            args.contentBase64.length <= Math.ceil(RECOVERY_LIMITS.selectionBytes / 3) * 4,
          "bounded asset bytes required",
        )
        requireThat(
          typeof args.name === "string" &&
            /^recovery-v2-[A-Za-z0-9._@+-]+\.(?:json|txt)$/u.test(args.name),
          "recovery asset namespace required",
        )
        const bytes = Buffer.from(args.contentBase64, "base64")
        requireThat(
          bytes.length > 0 && bytes.toString("base64") === args.contentBase64,
          "canonical asset base64 required",
        )
        const current = await observe(args)
        mutable(args, current)
        const existing = current.facts.assets.find((a) => a.assetName === args.name)
        // Observe verifies downloaded bytes, including all original and retained assets.
        if (existing) {
          requireThat(
            existing.sha256 === hash(bytes) && existing.size === bytes.length,
            "same-name asset has differing bytes",
          )
          await capture(args, current, "adopt")
          return existing
        }
        requireThat(
          !current.facts.assets.some((a) => a.assetName === "recovery-v2-finalization.json"),
          "finalization freezes every new asset",
        )
        let receipt = null
        if (
          current.phase === "NPM_COMPLETE" &&
          args.name ===
            `recovery-v2-legacy-${args.candidate.version}-${args.expectedBodySha256}.txt`
        )
          requireThat(
            bytes.equals(Buffer.from(current.facts.release.body)),
            "legacy archive bytes differ",
          )
        else {
          receipt = parseRecovery(bytes, { candidate: args.candidate })
          requireThat(
            canonicalRecoveryBytes(receipt).equals(bytes),
            "canonical receipt bytes required",
          )
          const allowed = {
            NPM_COMPLETE: ["recovery-adoption"],
            RECOVERY_ADOPTED: [
              "recovery-lane",
              "recovery-installation",
              "recovery-provenance",
              "recovery-verification-set",
            ],
            AUDIT_VERIFIED: ["recovery-finalization"],
          }
          requireThat(
            allowed[current.phase]?.includes(receipt.kind),
            "receipt is forbidden in current phase",
          )
          requireThat(
            /^recovery-v2-[A-Za-z0-9._@+-]+\.json$/u.test(args.name),
            "recovery asset namespace invalid",
          )
          if (current.phase === "RECOVERY_ADOPTED") {
            requireThat(
              !current.facts.verification,
              "accepted verification selection freezes new verification assets",
            )
            const eligibility = await capture(args, current, "verify")
            if (receipt.kind === "recovery-verification-set") {
              requireThat(
                args.name === recoveryVerificationName(receipt.executor),
                "attempt-qualified verification name required",
              )
              same(
                receipt,
                buildRecoveryVerificationSet(current, eligibility.executor),
                "verification selection differs from independently persisted escrow",
              )
            } else {
              const lane =
                receipt.kind === "recovery-provenance" ? receipt.provenance.lane : receipt.lane
              const verified = await observeRecoveryLaneEvidence(
                {
                  candidate: args.candidate,
                  executor: eligibility.executor,
                  policy: await readRecoveryEvidencePolicy(
                    eligibility.executor,
                    eligibility.policySha256,
                    observation.git,
                  ),
                  policySha256: eligibility.policySha256,
                  manifestPackages: current.facts.manifestPackages,
                  lane,
                },
                observation.github,
                { now, sleep: callbacks.sleep },
              )
              requireThat(!verified.missing, verified.missing ?? "lane proof unavailable")
              if (receipt.kind === "recovery-provenance") {
                requireThat(
                  args.name === recoveryProvenanceName(receipt),
                  "digest-qualified provenance name required",
                )
                same(receipt.executor, eligibility.executor, "escrow producer differs")
                const { validatedAt: _time, ...expected } = verified.provenance
                const { validatedAt: stamp, ...claimed } = receipt.provenance
                same(claimed, expected, "provenance differs from independent API proof")
                requireThat(Date.parse(stamp) <= now(), "provenance timestamp is in the future")
                same(
                  receipt.artifact,
                  verified.artifact,
                  "artifact descriptor differs from independent API proof",
                )
                verifyRecoveryProvenanceBindings(
                  receipt,
                  verified.lane,
                  current.facts.assets,
                  verified.installations,
                  current.facts.manifestPackages,
                )
                await verifyRecoveryEscrowProducer(
                  receipt,
                  async (method, input) => {
                    const envelope = await runRecoveryRead(
                      { phaseDeadline: deadline },
                      () => recoveryMethods(observation.github, [method])[method](input),
                      { now, sleep: callbacks.sleep },
                    )
                    requireThat(envelope.status === "PRESENT", "producer API proof unavailable")
                    return envelope.value
                  },
                  now(),
                )
              } else {
                same(
                  args.contentBase64,
                  receipt.kind === "recovery-lane" && args.name === verified.name
                    ? verified.contentBase64
                    : verified.installations[args.name],
                  "raw bytes differ from independently downloaded artifact membership",
                )
              }
            }
          }
          if (receipt.kind === "recovery-adoption") {
            same(receipt.baseAssets, current.facts.baseAssets, "adoption base inventory differs")
            same(receipt.npmEvidence, current.facts.npmEvidence, "adoption npm proof differs")
            same(
              receipt.archive,
              current.facts.partialAdoption.archive,
              "adoption archive not persisted",
            )
            same(
              receipt.retainedAttempts,
              current.facts.partialAdoption.attempts.map((a) => a.ref),
              "partial attempts must all be retained",
            )
            requireThat(
              args.name === recoveryAdoptionAssetName(receipt.executor),
              "attempt-qualified adoption name required",
            )
          }
          if (receipt.kind === "recovery-finalization") {
            requireThat(
              args.name === "recovery-v2-finalization.json",
              "fixed finalization name required",
            )
            await immutablePolicy(args)
          }
        }
        await compare(args, current)
        const proof = await capture(args, current, "adopt") // Last awaited precondition before physical write.
        if (receipt) {
          if (receipt.policySha256)
            same(receipt.policySha256, proof.policySha256, "receipt policy differs")
          if (receipt.executor && receipt.kind !== "recovery-audit-result") {
            for (const key of [
              "controllerSha",
              "verifierClosureSha256",
              "workflow",
              "runId",
              "runAttempt",
            ])
              same(receipt.executor[key], proof.executor[key], "receipt executor differs")
          }
          if (receipt.kind === "recovery-adoption") {
            same(receipt.executor, proof.executor, "adoption executor differs")
            const { intent: _intent, ...reference } = proof.authority
            same(receipt.authority, reference, "adoption authority differs")
          }
        }
        if (receipt?.kind === "recovery-finalization") {
          const plan = planRecovery({
            ...planningFacts(current, proof),
            proposedFinalization: { receipt },
          })
          requireThat(
            plan.outcome === "planned" && plan.effects.some((e) => e.operation === "finalize"),
            plan.errors.join("; ") || "finalization is not admissible",
          )
        }
        await send({
          url: `${uploads}/releases/${args.candidate.releaseId}/assets?name=${encodeURIComponent(args.name)}`,
          method: "POST",
          bodyBytes: bytes,
          contentType: "application/octet-stream",
          maxRequestBytes: RECOVERY_LIMITS.selectionBytes,
        })
        const observed = await observe(args)
        same(observed.facts.release, current.facts.release, "release changed during upload")
        const ref = observed.facts.assets.find((a) => a.assetName === args.name)
        requireThat(
          ref && ref.sha256 === hash(bytes) && ref.size === bytes.length,
          "upload postcondition differs",
        )
        same(
          observed.facts.assets.filter((a) => a.assetName !== args.name),
          current.facts.assets,
          "unrelated asset mutation",
        )
        return ref
      })
    },
    updateRecoveryDraft(input) {
      return transaction(async () => {
        const args = validate(input, "title body")
        requireThat(
          typeof args.title === "string" &&
            args.title.length > 0 &&
            Buffer.byteLength(args.title) <= 512,
          "bounded title required",
        )
        const marker = parseRecoveryReleaseMarker(args.body)
        same(marker.candidate, args.candidate, "marker candidate differs")
        const markerStart = args.body.indexOf("\n\n<!-- DAWN_RELEASE_CONTROLLER_MARKER\n")
        requireThat(
          markerStart >= 0 &&
            args.body ===
              renderRecoveryReleaseBody({ marker, body: args.body.slice(0, markerStart) }),
          "canonical v2 body required",
        )
        const current = await observe(args)
        if (current.facts.release.body === args.body && current.facts.release.name === args.title)
          return current
        mutable(args, current)
        const frozen = current.facts.finalization
        if (frozen) {
          const expected = renderRecoveryFinalMetadata(frozen.receipt, frozen.ref)
          same(
            { title: args.title, body: args.body },
            expected,
            "finalization freezes canonical metadata",
          )
          await immutablePolicy(args)
        } else {
          if (current.phase === "RECOVERY_ADOPTED" && marker.phase === "VERIFICATION_COMPLETE") {
            requireThat(
              current.facts.verification,
              "independently persisted verification selection required",
            )
            same(
              marker,
              {
                ...current.facts.marker,
                revision: current.facts.marker.revision + 1,
                phase: "VERIFICATION_COMPLETE",
                verificationSet: current.facts.verification.ref,
              },
              "verification marker differs",
            )
            const eligibility = await capture(args, current, "verify")
            const plan = planRecovery({ ...current.facts, ...eligibility, publication: null })
            requireThat(
              plan.outcome === "planned" &&
                plan.effects.some(
                  (e) => e.operation === "write-marker" && e.target === "VERIFICATION_COMPLETE",
                ),
              plan.errors.join("; ") || "verification advancement is not admissible",
            )
          } else {
            requireThat(
              current.phase === "NPM_COMPLETE" && marker.phase === "RECOVERY_ADOPTED",
              "unsupported transition; selection controller not implemented",
            )
            const selected = current.facts.partialAdoption.attempts.find(
              (a) => a.ref.assetName === marker.adoption.assetName,
            )
            requireThat(selected, "adoption receipt is not independently persisted")
            same(
              marker,
              {
                schemaVersion: 2,
                kind: "recovery-marker",
                candidate: args.candidate,
                policySha256: selected.receipt.policySha256,
                revision: 1,
                phase: "RECOVERY_ADOPTED",
                adoption: selected.ref,
                verificationSet: null,
                audit: null,
                finalization: null,
              },
              "adoption marker differs from verified receipt",
            )
            same(
              selected.receipt.retainedAttempts,
              current.facts.partialAdoption.attempts
                .map((a) => a.ref)
                .filter((r) => r.assetName !== selected.ref.assetName),
              "adoption must retain every earlier valid attempt",
            )
          }
        }
        await compare(args, current)
        const proof = await capture(args, current, "adopt")
        same(marker.policySha256, proof.policySha256, "marker policy differs")
        if (frozen) {
          const plan = planRecovery(planningFacts(current, proof))
          requireThat(
            plan.outcome === "planned" &&
              plan.effects.some(
                (e) => e.operation === "write-marker" && e.target === "PUBLICATION_READY",
              ),
            plan.errors.join("; ") || "readiness reconstruction is not admissible",
          )
        }
        await send({
          url: `${base}/releases/${args.candidate.releaseId}`,
          method: "PATCH",
          body: { name: args.title, body: args.body },
        })
        const observed = await observe(args)
        requireThat(
          observed.facts.release.name === args.title && observed.facts.release.body === args.body,
          "draft update postcondition differs",
        )
        same(observed.facts.assets, current.facts.assets, "assets changed during marker update")
        return observed
      })
    },
    publishRecoveryDraft(input) {
      return transaction(async () => {
        const args = validate(input, "")
        const current = await observe(args)
        if (current.terminal) return current
        mutable(args, current)
        requireThat(
          current.phase === "PUBLICATION_READY" && current.facts.finalization,
          "verified finalization and readiness required",
        )
        const rendered = renderRecoveryFinalMetadata(
          current.facts.finalization.receipt,
          current.facts.finalization.ref,
        )
        same(
          { title: current.facts.release.name, body: current.facts.release.body },
          rendered,
          "publication metadata differs",
        )
        await immutablePolicy(args)
        await compare(args, current)
        const proof = await capture(args, current, "publish")
        const plan = planRecovery(planningFacts(current, proof))
        requireThat(
          plan.outcome === "planned" && plan.effects.some((e) => e.operation === "publish"),
          plan.errors.join("; ") || "publication is not admissible",
        )
        await send({
          url: `${base}/releases/${args.candidate.releaseId}`,
          method: "PATCH",
          body: { tag_name: args.candidate.tag, draft: false },
        })
        const observed = await observe(args)
        requireThat(
          observed.terminal && !observed.displayDrift,
          "immutable publication postcondition not proven",
        )
        return observed
      })
    },
  })
}
