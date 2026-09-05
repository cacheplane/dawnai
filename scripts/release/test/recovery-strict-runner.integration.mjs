import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { executeRuntimeTargetsSmoke } from "../smoke/runtime-targets.mjs"
import {
  assertStrictSmokeCommandOptions,
  createStrictSmokeProcessRunner,
  STRICT_SMOKE_COMMAND_OPTION_FIELDS,
} from "../smoke-process-runner.mjs"

const environment = process.env
const enabled = environment.DAWN_TEST_RECOVERY_RUNNER === "1"
const eligible = process.platform === "linux" && environment.ImageOS === "ubuntu24"
test("recovery uses real systemd execution and removes detached descendants", {
  skip: !enabled ? "DAWN_TEST_RECOVERY_RUNNER=1 is required" : false,
  timeout: 60_000,
}, async () => {
  assert.ok(eligible, "ineligible host: requires the actual Linux ubuntu24 systemd runner")
  assert.deepEqual(STRICT_SMOKE_COMMAND_OPTION_FIELDS, [
    "acceptedExitCodes",
    "cwd",
    "env",
    "maxOutputBytes",
    "signal",
    "timeoutMs",
  ])
  const root = await mkdtemp(join(tmpdir(), "dawn-recovery-strict-"))
  try {
    const runner = createStrictSmokeProcessRunner()
    const capability = await runner.probe()
    assert.equal(capability.adapter, "systemd-cgroup-v2")
    const options = {
      cwd: root,
      env: { ...process.env },
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      acceptedExitCodes: [0],
      signal: new AbortController().signal,
    }
    assertStrictSmokeCommandOptions(options)
    const pidFile = join(root, "child.pid")
    const result = await runner.runCommand(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      child.unref();
      console.log('parent completed');
    `,
      ],
      options,
    )
    // Exercise the production runtime-target command adapter too. This bounded
    // integration does not install packages or emit a lane receipt.
    await writeFile(join(root, "node-runtime.mjs"), "console.log('adapter executed')\n")
    const observed = []
    await executeRuntimeTargetsSmoke(
      { version: "0.8.24" },
      {
        async check(name, _detail, operation) {
          if (name === "temporary-project") return root
          if (name === "containment" || name === "node-runtime") return operation()
        },
        deferCleanup() {},
      },
      {
        strictRunner: {
          probe: () => runner.probe(),
          async runCommand(command, args, options) {
            assertStrictSmokeCommandOptions(options)
            observed.push(Object.keys(options).sort())
            return runner.runCommand(command, args, options)
          },
        },
      },
    )
    assert.deepEqual(observed, [["cwd", "env", "maxOutputBytes", "timeoutMs"]])
    assert.match(result.stdout, /parent completed/u)
    const pid = Number(await readFile(pidFile, "utf8"))
    assert.ok(Number.isSafeInteger(pid) && pid > 1)
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
