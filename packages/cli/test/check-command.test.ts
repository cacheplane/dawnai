import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createFixtureApp(files: readonly string[]) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-check-"));
  tempDirs.push(appRoot);

  await Promise.all(
    files.map(async (relativePath) => {
      const filePath = join(appRoot, relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, relativePath.endsWith(".json") ? "{}" : "export default {};\n");
    }),
  );

  return appRoot;
}

async function invoke(argv: readonly string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];

    const exitCode = await run([...argv], {
    stderr: (message: string) => {
      stderr.push(message);
    },
    stdout: (message: string) => {
      stdout.push(message);
    },
  });

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  };
}

async function buildCliExecutable() {
  const packageRoot = resolve(import.meta.dirname, "..");
  const distEntry = join(packageRoot, "dist", "index.js");

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("pnpm", ["exec", "tsc", "-b", "tsconfig.build.json", "--force"], {
      cwd: packageRoot,
      stdio: "inherit",
    });

    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`CLI build failed with exit code ${code ?? "unknown"}`));
    });
  });

  await chmod(distEntry, 0o755);

  return distEntry;
}

async function executeCli(entryPath: string, args: readonly string[]) {
  return await new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>(
    (resolvePromise, rejectPromise) => {
      const child = spawn(entryPath, [...args], {
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

describe("dawn check", () => {
  test("exits cleanly for a valid fixture app and reports validation success", async () => {
    const appRoot = await createFixtureApp([
      "package.json",
      "dawn.config.ts",
      "src/app/page.tsx",
      "src/app/[tenant]/graph.ts",
    ]);

    const result = await invoke(["check", "--cwd", appRoot]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Dawn app is valid");
    expect(result.stdout).toContain("/[tenant]");
    expect(result.stderr).toBe("");
  });

  test("exits non-zero for an invalid fixture app and reports the failing validation", async () => {
    const appRoot = await createFixtureApp([
      "package.json",
      "dawn.config.ts",
    ]);

    const result = await invoke(["check", "--cwd", appRoot]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Validation failed");
    expect(result.stderr).toContain("Missing:");
  });

  test("runs from the built dawn executable for direct and symlinked invocation paths", async () => {
    const appRoot = await createFixtureApp([
      "package.json",
      "dawn.config.ts",
      "src/app/page.tsx",
    ]);
    const builtCli = await buildCliExecutable();
    const builtSource = await readFile(builtCli, "utf8");
    const symlinkPath = join(appRoot, "dawn-link.js");

    await symlink(builtCli, symlinkPath);

    const directResult = await executeCli(builtCli, ["check", "--cwd", appRoot]);
    const symlinkResult = await executeCli(symlinkPath, ["check", "--cwd", appRoot]);

    expect(builtSource.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(directResult.code).toBe(0);
    expect(directResult.stderr).toBe("");
    expect(directResult.stdout).toContain("Dawn app is valid");
    expect(symlinkResult.code).toBe(0);
    expect(symlinkResult.stderr).toBe("");
    expect(symlinkResult.stdout).toContain("Dawn app is valid");
  });
});
