import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function assertExists(path: string) {
  await expect(access(path, constants.F_OK)).resolves.toBeUndefined();
}

async function runCommand(command: string, args: readonly string[], cwd: string) {
  return await new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>(
    (resolvePromise, rejectPromise) => {
      const child = spawn(command, [...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });

      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.once("error", rejectPromise);
      child.once("close", (code) => {
        resolvePromise({ code, stderr, stdout });
      });
    },
  );
}

describe("create-dawn-app", () => {
  test("creates the canonical basic app structure and produces an installable fixture app", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "create-dawn-app-"));
    tempDirs.push(tempRoot);

    const targetDir = join(tempRoot, "hello-dawn");

    const exitCode = await run([targetDir, "--template", "basic"]);

    expect(exitCode).toBe(0);

    await assertExists(targetDir);
    await assertExists(join(targetDir, "package.json"));
    await assertExists(join(targetDir, "dawn.config.ts"));
    await assertExists(join(targetDir, "tsconfig.json"));
    await assertExists(join(targetDir, "src/app/(public)/hello/[tenant]/route.ts"));
    await assertExists(join(targetDir, "src/app/(public)/hello/[tenant]/workflow.ts"));
    await assertExists(join(targetDir, "src/app/(public)/hello/[tenant]/state.ts"));

    const packageJson = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8")) as {
      readonly name: string;
      readonly scripts: Record<string, string>;
    };

    expect(packageJson.name).toBe(basename(targetDir));
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");
    expect(packageJson.scripts.check).toContain("packages/cli/dist/index.js check");

    const repoRoot = resolve(import.meta.dirname, "../../..");
    const buildResult = await runCommand("pnpm", ["--filter", "create-dawn-app", "build"], repoRoot);
    expect(buildResult.code).toBe(0);

    const installResult = await runCommand("pnpm", ["install", "--dir", targetDir], tempRoot);
    expect(installResult.code).toBe(0);
    expect(installResult.stderr).not.toContain("ERR_");

    const typecheckResult = await runCommand("pnpm", ["--dir", targetDir, "typecheck"], tempRoot);
    expect(typecheckResult.code).toBe(0);

    const checkResult = await runCommand("pnpm", ["--dir", targetDir, "check"], tempRoot);
    expect(checkResult.code).toBe(0);
    expect(checkResult.stdout).toContain("/hello/[tenant]");
  });
});
