import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
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
  test("creates the canonical basic app structure and produces an installable fixture app under repo tmp", async () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const tempRoot = join(repoRoot, "tmp");
    const targetDir = join(tempRoot, "dawn-smoke");

    await mkdir(tempRoot, { recursive: true });
    await rm(targetDir, { force: true, recursive: true });
    tempDirs.push(targetDir);

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
      readonly dependencies: Record<string, string>;
      readonly devDependencies: Record<string, string>;
    };

    expect(packageJson.name).toBe(basename(targetDir));
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");
    expect(packageJson.scripts.check).toBe("dawn check");
    expect(packageJson.dependencies["@dawn/core"]).toBe("file:../../packages/core");
    expect(packageJson.dependencies["@dawn/cli"]).toBe("file:../../packages/cli");
    expect(packageJson.dependencies["@dawn/langgraph"]).toBe("file:../../packages/langgraph");
    expect(packageJson.devDependencies["@dawn/config-typescript"]).toBe("file:../../packages/config-typescript");

    const buildResult = await runCommand("pnpm", ["--filter", "create-dawn-app", "build"], repoRoot);
    expect(buildResult.code).toBe(0);

    await expect(access(join(targetDir, "pnpm-workspace.yaml"), constants.F_OK)).rejects.toThrow();

    const installResult = await runCommand("pnpm", ["install", "--dir", targetDir], repoRoot);
    expect(installResult.code).toBe(0);
    expect(installResult.stderr).not.toContain("ERR_");

    const typecheckResult = await runCommand("pnpm", ["--dir", targetDir, "typecheck"], repoRoot);
    expect(typecheckResult.code).toBe(0);

    const checkResult = await runCommand("pnpm", ["--dir", targetDir, "check"], repoRoot);
    expect(checkResult.code).toBe(0);
    expect(checkResult.stdout).toContain("/hello/[tenant]");

    const builtTargetDir = join(tempRoot, "dawn-built-smoke");
    const templatesDir = join(repoRoot, "templates");
    const templatesBackupDir = join(repoRoot, "templates.task6-backup");

    await rm(builtTargetDir, { force: true, recursive: true });
    tempDirs.push(builtTargetDir);
    await rm(templatesBackupDir, { force: true, recursive: true });
    await rename(templatesDir, templatesBackupDir);

    try {
      const builtScaffoldResult = await runCommand(
        "node",
        [join(repoRoot, "packages/create-dawn-app/dist/index.js"), builtTargetDir, "--template", "basic"],
        repoRoot,
      );

      expect(builtScaffoldResult.code).toBe(0);
      await assertExists(join(builtTargetDir, "package.json"));
      await assertExists(join(builtTargetDir, "src/app/(public)/hello/[tenant]/workflow.ts"));
    } finally {
      await rename(templatesBackupDir, templatesDir);
    }
  });
});
