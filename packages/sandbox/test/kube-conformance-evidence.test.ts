import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { describe, expect, test } from "vitest"

import {
  assertDnsEvidence,
  assertEgressEvidence,
  assertRestrictedSecurityEvidence,
  buildDnsProbeCommand,
  buildEgressProbeCommand,
  buildNodeEvalCommand,
  buildRestrictedSecurityProbeCommand,
  parseEgressControlUrl,
} from "./support/kube-conformance-evidence.ts"

const execFileAsync = promisify(execFile)

const restrictedMarkers = [
  "DAWN_PROC_CAP_EFF=0000000000000000",
  "DAWN_PROC_NO_NEW_PRIVS=1",
  "DAWN_PROC_SECCOMP=2",
  "DAWN_WRITE_ETC=read-only",
  "DAWN_WRITE_WORKSPACE=writable",
  "DAWN_WRITE_TMP=writable",
  "DAWN_WRITE_RUN=writable",
  "DAWN_SERVICEACCOUNT_TOKEN=absent",
] as const

describe("Kubernetes conformance command construction", () => {
  test.each([
    "ftp://example.test/probe",
    "https://user@example.test/probe",
    "https://user:password@example.test/probe",
    "not a URL",
    "",
  ])("rejects an unsafe egress control URL: %s", (value) => {
    expect(() => parseEgressControlUrl(value)).toThrow(/http|https|credentials|URL/i)
  })

  test("POSIX-quotes an apostrophe and shell metacharacters without allowing escape", async () => {
    const sentinel = join(tmpdir(), `dawn-shell-escape-${randomUUID()}`)
    const rawUrl = `https://example.test/a';touch\${IFS}${sentinel};#?query=$(touch\${IFS}${sentinel})`
    const url = parseEgressControlUrl(rawUrl)
    const command = buildNodeEvalCommand(`process.stdout.write(${JSON.stringify(url)})`)

    const result = await execFileAsync("/bin/sh", ["-c", command])

    expect(result.stdout).toBe(url)
    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("builds node probes from the parsed URL with exact evidence markers", () => {
    const url = parseEgressControlUrl("https://example.test/a'b;$(echo escaped)?query=`id`")

    expect(buildDnsProbeCommand(url)).toContain("DAWN_DNS_RESULT=resolved")
    expect(buildEgressProbeCommand(url)).toContain("DAWN_EGRESS_RESULT=reached")
    expect(buildEgressProbeCommand(url)).toContain("DAWN_EGRESS_RESULT=blocked")
    expect(buildRestrictedSecurityProbeCommand()).toContain("DAWN_PROC_CAP_EFF=")
    expect(buildRestrictedSecurityProbeCommand()).toContain("DAWN_SERVICEACCOUNT_TOKEN=")
  })

  test("executes the generated DNS probe as valid JavaScript", async () => {
    const command = buildDnsProbeCommand(parseEgressControlUrl("http://localhost/probe"))

    const result = await execFileAsync("/bin/sh", ["-c", command])

    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("DAWN_DNS_RESULT=resolved\n")
  })

  test("executes the generated egress probe with the blocked exit contract", async () => {
    const command = buildEgressProbeCommand(parseEgressControlUrl("http://127.0.0.1:1/probe"))

    await expect(execFileAsync("/bin/sh", ["-c", command])).rejects.toMatchObject({
      code: 7,
      stdout: "DAWN_EGRESS_RESULT=blocked\n",
    })
  })
})

describe("Kubernetes conformance evidence parsing", () => {
  test("accepts the exact restricted security evidence once per marker", () => {
    expect(() => assertRestrictedSecurityEvidence(restrictedMarkers.join("\n"))).not.toThrow()
  })

  test.each(restrictedMarkers)("rejects a missing restricted marker: %s", (marker) => {
    const output = restrictedMarkers.filter((candidate) => candidate !== marker).join("\n")

    expect(() => assertRestrictedSecurityEvidence(output)).toThrow(/missing/i)
  })

  test.each(restrictedMarkers)("rejects a duplicate restricted marker: %s", (marker) => {
    expect(() =>
      assertRestrictedSecurityEvidence([...restrictedMarkers, marker].join("\n")),
    ).toThrow(/duplicate/i)
  })

  test.each(restrictedMarkers)("rejects an unknown restricted value: %s", (marker) => {
    const [name] = marker.split("=", 1)
    const output = restrictedMarkers
      .map((candidate) => (candidate === marker ? `${name}=unknown` : candidate))
      .join("\n")

    expect(() => assertRestrictedSecurityEvidence(output)).toThrow(/unknown|invalid/i)
  })

  test("rejects contradictory and unexpected restricted markers", () => {
    expect(() =>
      assertRestrictedSecurityEvidence(
        [...restrictedMarkers, "DAWN_WRITE_ETC=writable"].join("\n"),
      ),
    ).toThrow(/duplicate|contradictory/i)
    expect(() =>
      assertRestrictedSecurityEvidence([...restrictedMarkers, "DAWN_UNKNOWN=value"].join("\n")),
    ).toThrow(/unexpected/i)
  })

  test("requires one exact DNS marker", () => {
    expect(() => assertDnsEvidence("noise\nDAWN_DNS_RESULT=resolved\n")).not.toThrow()
    expect(() => assertDnsEvidence("noise only")).toThrow(/missing/i)
    expect(() => assertDnsEvidence("DAWN_DNS_RESULT=resolved\nDAWN_DNS_RESULT=resolved")).toThrow(
      /duplicate/i,
    )
    expect(() => assertDnsEvidence("DAWN_DNS_RESULT=failed")).toThrow(/unknown/i)
  })

  test.each(["blocked", "reached"] as const)(
    "requires one exact egress marker with expected value %s",
    (expected) => {
      expect(() => assertEgressEvidence(`DAWN_EGRESS_RESULT=${expected}\n`, expected)).not.toThrow()
      expect(() => assertEgressEvidence("noise only", expected)).toThrow(/missing/i)
      expect(() =>
        assertEgressEvidence(
          `DAWN_EGRESS_RESULT=${expected}\nDAWN_EGRESS_RESULT=${expected}`,
          expected,
        ),
      ).toThrow(/duplicate/i)
      expect(() => assertEgressEvidence("DAWN_EGRESS_RESULT=unknown", expected)).toThrow(/unknown/i)
      const contradictory = expected === "blocked" ? "reached" : "blocked"
      expect(() => assertEgressEvidence(`DAWN_EGRESS_RESULT=${contradictory}`, expected)).toThrow(
        /expected/i,
      )
    },
  )

  test("does not accept marker substrings that are not exact lines", () => {
    expect(() => assertDnsEvidence("prefix DAWN_DNS_RESULT=resolved suffix")).toThrow(/missing/i)
    expect(() => assertEgressEvidence("DAWN_EGRESS_RESULT=blocked extra", "blocked")).toThrow(
      /unknown/i,
    )
  })
})
