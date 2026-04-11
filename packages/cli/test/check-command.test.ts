import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/index";

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
    stderr: (message) => {
      stderr.push(message);
    },
    stdout: (message) => {
      stdout.push(message);
    },
  });

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  };
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
});
