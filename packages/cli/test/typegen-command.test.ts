import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createFixtureApp() {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-typegen-"));
  tempDirs.push(appRoot);

  const files = [
    "package.json",
    "dawn.config.ts",
    "src/app/page.tsx",
    "src/app/[tenant]/graph.ts",
  ];

  await Promise.all(
    files.map(async (relativePath) => {
      const filePath = join(appRoot, relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, relativePath.endsWith(".json") ? "{}" : "export default {};\n");
    }),
  );

  return appRoot;
}

describe("dawn typegen", () => {
  test("writes generated route types into the target app", async () => {
    const appRoot = await createFixtureApp();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await run(["typegen", "--cwd", appRoot], {
      stderr: (message) => {
        stderr.push(message);
      },
      stdout: (message) => {
        stdout.push(message);
      },
    });

    const outputPath = join(appRoot, "src/app/dawn.generated.d.ts");
    const output = await readFile(outputPath, "utf8");

    expect(exitCode).toBe(0);
    expect(stderr.join("")).toBe("");
    expect(stdout.join("")).toContain("Wrote route types");
    expect(output).toContain('export type DawnRoutePath = "/" | "/[tenant]";');
    expect(output).toContain('"/[tenant]": { tenant: string };');
  });
});
