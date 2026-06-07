import { DEFAULT_CASE_BAR, type EvalDefinition, type GatePolicy, type GateResult } from "./types.js"

function pass(reason?: string): GateResult {
  return reason !== undefined ? { passed: true, reason } : { passed: true }
}
function fail(reason: string): GateResult {
  return { passed: false, reason }
}

export const gate = {
  mean(n: number): GatePolicy {
    return (r) => (r.mean >= n ? pass() : fail(`mean ${r.mean.toFixed(2)} < ${n}`))
  },
  passRate(n: number): GatePolicy {
    return (r) => {
      const rate = r.cases.length === 0 ? 1 : r.cases.filter((c) => c.passed).length / r.cases.length
      return rate >= n ? pass() : fail(`pass-rate ${rate.toFixed(2)} < ${n}`)
    }
  },
  everyCase(n: number): GatePolicy {
    return (r) => {
      const bad = r.cases.find((c) => c.mean < n)
      return bad ? fail(`case "${bad.name}" mean ${bad.mean.toFixed(2)} < ${n}`) : pass()
    }
  },
  perScorer(): GatePolicy {
    return (r) => {
      const bad = r.byScorer.find((s) => s.threshold !== undefined && s.mean < s.threshold)
      return bad
        ? fail(`scorer "${bad.scorer}" mean ${bad.mean.toFixed(2)} < ${bad.threshold}`)
        : pass()
    }
  },
  all(...policies: GatePolicy[]): GatePolicy {
    return (r) => {
      for (const p of policies) {
        const res = p(r)
        if (!res.passed) return res
      }
      return pass()
    }
  },
  any(...policies: GatePolicy[]): GatePolicy {
    return (r) => {
      const reasons: string[] = []
      for (const p of policies) {
        const res = p(r)
        if (res.passed) return pass()
        if (res.reason) reasons.push(res.reason)
      }
      return fail(`no policy passed: ${reasons.join("; ")}`)
    }
  },
}

/** gate wins; else threshold → mean(threshold); else informational (always passes). */
export function resolveGate(def: Pick<EvalDefinition, "gate" | "threshold">): GatePolicy {
  if (def.gate) return def.gate
  if (def.threshold !== undefined) return gate.mean(def.threshold)
  return () => pass("informational (no gate)")
}

export { DEFAULT_CASE_BAR }
