import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { defineEntry, normalizeRouteModule } from "@dawn/langgraph";
import type { RouteModule } from "@dawn/langgraph/route-module";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createPackedConsumer(): Promise<{ readonly consumerDir: string; readonly tarballPath: string }> {
  const packageRoot = resolve(import.meta.dirname, "..");
  const tempRoot = await mkdtemp(join(tmpdir(), "dawn-langgraph-pack-"));
  const consumerDir = join(tempRoot, "consumer");
  tempDirs.push(tempRoot);

  await writeFile(join(tempRoot, "package.json"), JSON.stringify({ name: "pack-root", private: true }));
  await runCommand("pnpm", ["exec", "tsc", "-b", "tsconfig.json", "--force"], packageRoot);
  const packOutput = await runCommand("pnpm", ["pack", "--pack-destination", tempRoot], packageRoot);
  const tarballPath = resolveTarballPath(packOutput.stdout, tempRoot);
  await mkdir(consumerDir, { recursive: true });
  await writeFile(join(consumerDir, "package.json"), JSON.stringify({ name: "consumer", private: true }, null, 2));
  await runCommand("pnpm", ["add", tarballPath], consumerDir);

  return {
    consumerDir,
    tarballPath,
  };
}

async function runCommand(command: string, args: readonly string[], cwd: string): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await new Promise<{ readonly stdout: string; readonly stderr: string }>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "pipe",
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
      if (code === 0) {
        resolvePromise({ stderr, stdout });
        return;
      }

      rejectPromise(new Error([`${command} ${args.join(" ")} failed`, stdout, stderr].filter(Boolean).join("\n")));
    });
  });
}

function resolveTarballPath(packStdout: string, outputDir: string) {
  const tarballName = packStdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(".tgz"));

  if (!tarballName) {
    throw new Error("Could not determine @dawn/langgraph tarball name");
  }

  return join(outputDir, basename(tarballName));
}

describe("@dawn/langgraph defineEntry", () => {
  test("graph.ts modules can export a native-first entry and route config", () => {
    const graph = () => "graph";
    const module = {
      graph,
      config: {
        runtime: "node",
        streaming: true,
        tags: ["support"],
      },
    } as const;

    expect(defineEntry(module)).toBe(module);
    expect(normalizeRouteModule(module)).toEqual({
      kind: "graph",
      entry: graph,
      config: {
        runtime: "node",
        streaming: true,
        tags: ["support"],
      },
    });
  });

  test("workflow.ts modules are accepted as alternative executable route entries", () => {
    const workflow = () => "workflow";
    const module = {
      workflow,
      config: {
        runtime: "node",
        streaming: false,
      },
    } as const;

    expect(defineEntry(module)).toBe(module);
    expect(normalizeRouteModule(module)).toEqual({
      kind: "workflow",
      entry: workflow,
      config: {
        runtime: "node",
        streaming: false,
      },
    });
  });

  test("rejects modules that provide both graph and workflow", () => {
    const graph = () => "graph";
    const workflow = () => "workflow";
    // @ts-expect-error - route modules must not expose both executable entries
    const invalidModule: RouteModule<typeof graph> = { graph, workflow };

    expect(() =>
      defineEntry({
        graph,
        workflow,
      } as never),
    ).toThrow("Route modules must define exactly one primary executable entry: graph or workflow");

    expect(() =>
      normalizeRouteModule(invalidModule as never),
    ).toThrow("Route modules must define exactly one primary executable entry: graph or workflow");
  });

  test("packed consumers can import defineEntry from the published root export", async () => {
    const { consumerDir } = await createPackedConsumer();
    const scriptPath = join(consumerDir, "entry-check.mjs");

    await writeFile(
      scriptPath,
      [
        'import { defineEntry, normalizeRouteModule } from "@dawn/langgraph";',
        "const graph = () => 'graph';",
        "const entry = defineEntry({ graph, config: { streaming: true } });",
        "const normalized = normalizeRouteModule(entry);",
        "if (normalized.kind !== 'graph' || normalized.config.streaming !== true) {",
        "  throw new Error('packed root export failed');",
        "}",
      ].join("\n"),
    );

    await expect(runCommand("node", [scriptPath], consumerDir)).resolves.toEqual({
      stderr: "",
      stdout: "",
    });
  });
});
