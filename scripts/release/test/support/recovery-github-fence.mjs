// Test-only authority and reporting. This does not authorize production adoption.
export function authorizeFenceProbe(env) {
  const repository = env.DAWN_RECOVERY_TEST_REPOSITORY
  if (env.DAWN_TEST_RECOVERY_GITHUB !== "1") throw new Error("explicit opt-in required")
  if (typeof repository !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("disposable repository required")
  }
  if (repository.toLowerCase() === "cacheplane/dawnai") throw new Error("production forbidden")
  if (env.DAWN_RECOVERY_AUTHORIZED_REPOSITORY !== repository) {
    throw new Error("repository must match the separately authorized repository")
  }
  return repository
}

export function classifyFenceProbe(observations) {
  if (observations.some((item) => item.stage === "disabled" && item.accepted)) {
    return "workflow-disable-insufficient"
  }
  const methods = ["dispatch", "all", "failed", "job"]
  if (observations.length !== 12) return "inconclusive"
  for (const method of methods) {
    for (const stage of ["active-before", "disabled", "active-after"]) {
      const matches = observations.filter((item) => item.method === method && item.stage === stage)
      if (matches.length !== 1) return "inconclusive"
      const item = matches[0]
      if (stage === "disabled") {
        if (
          item.accepted !== false ||
          item.unchanged !== true ||
          ![403, 404, 409, 422].includes(item.status)
        ) {
          return "inconclusive"
        }
      } else if (item.accepted !== true) return "inconclusive"
    }
  }
  return "disposable-fence-observed"
}
