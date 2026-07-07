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
}

/** In-memory KubeClient. Models pods, PVCs (as a filestore that survives pod
 * deletion), and network policies. exec() is a tiny sh interpreter covering the
 * commands kubeFilesystem/kubeExec emit (cat/tee/ls/mkdir/rm/true/id/echo). */
export function fakeKubeClient(
  opts: {
    readonly canICreate?: boolean
    readonly cniEnforced?: boolean | "unknown"
    readonly startPhase?: PodPhase // phase newly-created pods report (default "Running")
  } = {},
): KubeClient & {
  readonly pods: Map<string, FakePod>
  readonly pvcs: Map<string, { spec: KubePvcSpec; files: Map<string, string> }>
  readonly netpols: Map<string, KubeNetworkPolicySpec>
} {
  const pods = new Map<string, FakePod>()
  const pvcs = new Map<string, { spec: KubePvcSpec; files: Map<string, string> }>()
  const netpols = new Map<string, KubeNetworkPolicySpec>()

  const runSh = (pod: FakePod, script: string, stdin?: string) => {
    const files = pod.files
    const catMatch = script.match(/^cat '(.+)'$/)
    const catPath = catMatch?.[1]
    if (catPath !== undefined) {
      const f = files.get(catPath)
      return f === undefined
        ? { stdout: "", stderr: "cat: no such file", exitCode: 1 }
        : { stdout: f, stderr: "", exitCode: 0 }
    }
    const writeMatch = script.match(/^cat > '(.+)'$/)
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
      return pods.get(name)?.phase ?? null
    },
    async createNamespacedPod(_ns, spec) {
      const pvc = pvcs.get(spec.pvcName)
      pods.set(spec.name, {
        spec,
        phase: opts.startPhase ?? "Running",
        files: pvc?.files ?? new Map(),
      })
    },
    async deleteNamespacedPod(_ns, name) {
      pods.delete(name)
    },
    async createNamespacedPvcIfAbsent(_ns, spec) {
      if (!pvcs.has(spec.name)) pvcs.set(spec.name, { spec, files: new Map() })
    },
    async deleteNamespacedPvc(_ns, name) {
      pvcs.delete(name)
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
