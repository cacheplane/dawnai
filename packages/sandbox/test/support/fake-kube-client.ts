import type {
  KubeClient,
  KubeNetworkPolicySpec,
  KubePodSpec,
  KubePvcSpec,
  PodPhase,
} from "../../src/kubernetes/kube-client.ts"

interface FakePod {
  spec: KubePodSpec
  phase: PodPhase
  files: Map<string, string>
  /** Remaining phase-reads that report "Pending" before the stored phase (models
   * slow scheduling / image pull). Decremented on each readNamespacedPodPhase. */
  pendingReads: number
}

/** In-memory KubeClient. Models pods, PVCs (as a filestore that survives pod
 * deletion), and network policies. exec() is a tiny sh interpreter covering the
 * commands kubeFilesystem/kubeExec emit (cat/tee/ls/mkdir/rm/true/id/echo). */
export function fakeKubeClient(
  opts: {
    readonly canICreate?: boolean
    readonly cniEnforced?: boolean | "unknown"
    readonly startPhase?: PodPhase // phase newly-created pods report (default "Running")
    readonly pendingReads?: number // reads a fresh pod reports "Pending" before startPhase
    /** After deleteNamespacedPvc, pvcExists still reports true for this many calls
     * (models real-cluster async PVC deletion), then reports gone. Default 0. */
    readonly pvcLingerReads?: number
  } = {},
): KubeClient & {
  readonly pods: Map<string, FakePod>
  readonly pvcs: Map<string, { spec: KubePvcSpec; files: Map<string, string> }>
  readonly netpols: Map<string, KubeNetworkPolicySpec>
} {
  const pods = new Map<string, FakePod>()
  const pvcs = new Map<string, { spec: KubePvcSpec; files: Map<string, string> }>()
  const netpols = new Map<string, KubeNetworkPolicySpec>()
  // Separate from `pvcs` so pvcExists can report lingering-true even though the
  // entry is removed from `pvcs` immediately (tests assert on `.pvcs.has(...)`).
  const lingering = new Map<string, number>()

  const runSh = (pod: FakePod, rawScript: string, stdin?: string) => {
    const files = pod.files
    // kubeExec prefixes commands with `cd '<cwd>' && `; strip it so the
    // matchers below (which model the un-prefixed commands kube-filesystem
    // and other callers emit) still recognize the underlying command.
    const cdMatch = rawScript.match(/^cd '.*?' && (.*)$/s)
    const script = cdMatch?.[1] ?? rawScript
    const catMatch = script.match(/^cat '(.+)'$/)
    const catPath = catMatch?.[1]
    if (catPath !== undefined) {
      const f = files.get(catPath)
      return f === undefined
        ? { stdout: "", stderr: "cat: no such file", exitCode: 1 }
        : { stdout: f, stderr: "", exitCode: 0 }
    }
    // kubeFilesystem/dockerFilesystem's writeFile emits either the bare
    // `cat > 'path'` or the compound `mkdir -p "$(dirname 'path')" && cat > 'path'`
    // (to ensure parent dirs exist); match both forms.
    const writeMatch = script.match(/^(?:mkdir -p "\$\(dirname '.+'\)" && )?cat > '(.+)'$/)
    const writePath = writeMatch?.[1]
    if (writePath !== undefined) {
      files.set(writePath, stdin ?? "")
      return { stdout: "", stderr: "", exitCode: 0 }
    }
    const lsMatch = script.match(/^ls -1 '(.+)'$/)
    const lsDir = lsMatch?.[1]
    if (lsDir !== undefined) {
      const dir = lsDir.replace(/\/$/, "")
      const names = [...files.keys()]
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) =>
          p
            .slice(dir.length + 1)
            .split("/")
            .at(0),
        )
        .filter((name): name is string => name !== undefined)
      return { stdout: [...new Set(names)].join("\n"), stderr: "", exitCode: 0 }
    }
    if (script === "true" || script.startsWith("mkdir -p") || script.startsWith("touch"))
      return { stdout: "", stderr: "", exitCode: 0 }
    if (script.startsWith("rm -f")) return { stdout: "", stderr: "", exitCode: 0 }
    if (script === "id -u") return { stdout: "1000", stderr: "", exitCode: 0 }
    return { stdout: "", stderr: `unhandled: ${script}`, exitCode: 127 }
  }

  return {
    pods,
    pvcs,
    netpols,
    async readNamespacedPodPhase(_ns, name) {
      const pod = pods.get(name)
      if (!pod) return null
      if (pod.pendingReads > 0) {
        pod.pendingReads -= 1
        return "Pending"
      }
      return pod.phase
    },
    async createNamespacedPod(_ns, spec) {
      if (pods.has(spec.name)) {
        throw Object.assign(new Error(`pods "${spec.name}" already exists`), { code: 409 })
      }
      const pvc = pvcs.get(spec.pvcName)
      pods.set(spec.name, {
        spec,
        phase: opts.startPhase ?? "Running",
        files: pvc?.files ?? new Map(),
        pendingReads: opts.pendingReads ?? 0,
      })
    },
    async deleteNamespacedPod(_ns, name, _opts?) {
      pods.delete(name)
    },
    async createNamespacedPvcIfAbsent(_ns, spec) {
      if (!pvcs.has(spec.name)) pvcs.set(spec.name, { spec, files: new Map() })
    },
    async deleteNamespacedPvc(_ns, name) {
      lingering.set(name, opts.pvcLingerReads ?? 0)
      pvcs.delete(name)
    },
    async pvcExists(_ns, name) {
      const remaining = lingering.get(name) ?? 0
      if (remaining > 0) {
        lingering.set(name, remaining - 1)
        return true
      }
      return pvcs.has(name)
    },
    async upsertNamespacedNetworkPolicy(_ns, spec) {
      netpols.set(spec.name, spec)
    },
    async deleteNamespacedNetworkPolicy(_ns, name) {
      netpols.delete(name)
    },
    async exec(_ns, pod, argv, execOpts) {
      const p = pods.get(pod)
      if (!p) return { stdout: "", stderr: "pod not found", exitCode: 1 }
      const sh = argv.indexOf("sh")
      const script = argv[sh + 2] ?? ""
      return runSh(p, script, execOpts?.stdin)
    },
    async canI() {
      return opts.canICreate ?? true
    },
    async networkPolicyEnforced() {
      return opts.cniEnforced ?? true
    },
  }
}
