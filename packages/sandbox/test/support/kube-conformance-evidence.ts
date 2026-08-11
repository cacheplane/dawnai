type MarkerRule = {
  readonly validate: (value: string) => boolean
  readonly expectedDescription: string
}

const exact = (expected: string): MarkerRule => ({
  validate: (value) => value === expected,
  expectedDescription: expected,
})

const restrictedMarkerRules = {
  DAWN_PROC_CAP_EFF: {
    validate: (value) => /^0+$/.test(value),
    expectedDescription: "an all-zero hexadecimal capability mask",
  },
  DAWN_PROC_NO_NEW_PRIVS: exact("1"),
  DAWN_PROC_SECCOMP: exact("2"),
  DAWN_WRITE_ETC: exact("read-only"),
  DAWN_WRITE_WORKSPACE: exact("writable"),
  DAWN_WRITE_TMP: exact("writable"),
  DAWN_WRITE_RUN: exact("writable"),
  DAWN_SERVICEACCOUNT_TOKEN: exact("absent"),
} as const satisfies Readonly<Record<string, MarkerRule>>

function parseExactMarkers(
  output: string,
  rules: Readonly<Record<string, MarkerRule>>,
): Readonly<Record<string, string>> {
  const observed = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("DAWN_")) continue
    const match = /^(DAWN_[A-Z0-9_]+)=(.*)$/.exec(line)
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new Error(`Invalid Kubernetes conformance evidence marker line: ${line}`)
    }
    const [, name, value] = match
    const rule = rules[name]
    if (rule === undefined) {
      throw new Error(`Unexpected Kubernetes conformance evidence marker: ${name}`)
    }
    if (observed.has(name)) {
      throw new Error(`Duplicate or contradictory Kubernetes conformance marker: ${name}`)
    }
    if (!rule.validate(value)) {
      throw new Error(
        `Unknown or invalid value for Kubernetes conformance marker ${name}; expected ${rule.expectedDescription}`,
      )
    }
    observed.set(name, value)
  }

  const missing = Object.keys(rules)
    .filter((name) => !observed.has(name))
    .sort()
  if (missing.length > 0) {
    throw new Error(`Missing Kubernetes conformance evidence markers: ${missing.join(", ")}`)
  }
  return Object.freeze(Object.fromEntries(observed))
}

export function parseEgressControlUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error("Kubernetes egress control URL must be a non-empty URL without whitespace")
  }
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new Error("Kubernetes egress control URL must be a valid URL", { cause: error })
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Kubernetes egress control URL must use http or https")
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("Kubernetes egress control URL must not contain credentials")
  }
  return url.href
}

function posixQuote(value: string): string {
  if (value.includes("\0")) {
    throw new Error("POSIX shell arguments must not contain NUL bytes")
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function buildNodeEvalCommand(source: string): string {
  return `node -e ${posixQuote(source)}`
}

export function buildDnsProbeCommand(url: string): string {
  const hostname = new URL(url).hostname
  const source = [
    'const { promises: dns } = require("node:dns")',
    `dns.lookup(${JSON.stringify(hostname)})`,
    '  .then(() => console.log("DAWN_DNS_RESULT=resolved"))',
    "  .catch((error) => { console.error(error); process.exitCode = 1 })",
  ].join("; ")
  return buildNodeEvalCommand(source)
}

export function buildEgressProbeCommand(url: string): string {
  const source = [
    `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(5000) })`,
    '  .then(() => { console.log("DAWN_EGRESS_RESULT=reached"); process.exit(0) })',
    '  .catch(() => { console.log("DAWN_EGRESS_RESULT=blocked"); process.exit(7) })',
  ].join("; ")
  return buildNodeEvalCommand(source)
}

export function buildRestrictedSecurityProbeCommand(): string {
  return [
    "cap_eff= no_new_privs= seccomp=",
    "while read -r key value _; do",
    '  case "$key" in',
    '    CapEff:) cap_eff="$value" ;;',
    '    NoNewPrivs:) no_new_privs="$value" ;;',
    '    Seccomp:) seccomp="$value" ;;',
    "  esac",
    "done < /proc/self/status",
    'printf "DAWN_PROC_CAP_EFF=%s\\n" "$cap_eff"',
    'printf "DAWN_PROC_NO_NEW_PRIVS=%s\\n" "$no_new_privs"',
    'printf "DAWN_PROC_SECCOMP=%s\\n" "$seccomp"',
    "for target in ETC WORKSPACE TMP RUN; do",
    '  case "$target" in',
    '    ETC) path="/etc/dawn-compat-write" ;;',
    '    WORKSPACE) path="/workspace/dawn-compat-write" ;;',
    '    TMP) path="/tmp/dawn-compat-write" ;;',
    '    RUN) path="/run/dawn-compat-write" ;;',
    "  esac",
    '  if touch "$path" >/dev/null 2>&1; then result=writable; else result=read-only; fi',
    '  printf "DAWN_WRITE_%s=%s\\n" "$target" "$result"',
    "done",
    'token_path="/var/run/secrets/kubernetes.io/serviceaccount/token"',
    'if [ -e "$token_path" ]; then token=present; else token=absent; fi',
    'printf "DAWN_SERVICEACCOUNT_TOKEN=%s\\n" "$token"',
  ].join("\n")
}

export function assertRestrictedSecurityEvidence(output: string): void {
  parseExactMarkers(output, restrictedMarkerRules)
}

export function assertDnsEvidence(output: string): void {
  parseExactMarkers(output, { DAWN_DNS_RESULT: exact("resolved") })
}

export function assertEgressEvidence(output: string, expected: "blocked" | "reached"): void {
  const parsed = parseExactMarkers(output, {
    DAWN_EGRESS_RESULT: {
      validate: (value) => value === "blocked" || value === "reached",
      expectedDescription: "blocked or reached",
    },
  })
  if (parsed.DAWN_EGRESS_RESULT !== expected) {
    throw new Error(
      `Kubernetes egress evidence expected ${expected}, received ${parsed.DAWN_EGRESS_RESULT}`,
    )
  }
}
