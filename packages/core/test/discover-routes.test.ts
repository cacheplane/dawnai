import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";

import { discoverRoutes } from "../src/discovery/discover-routes";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createFixtureApp() {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-core-discovery-"));
  tempDirs.push(appRoot);

  const files = [
    "package.json",
    "dawn.config.ts",
    "src/app/(public)/page.tsx",
    "src/app/(public)/[tenant]/graph.ts",
    "src/app/docs/[...path]/workflow.ts",
    "src/app/docs/[[...path]]/graph.ts",
    "src/app/_private/graph.ts",
    "src/app/internal/workflow.ts",
    "src/ignored/page.tsx",
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

async function createAppWithoutRoutesDir() {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-core-invalid-app-"));
  tempDirs.push(appRoot);

  await Promise.all([
    writeFile(join(appRoot, "package.json"), "{}"),
    writeFile(join(appRoot, "dawn.config.ts"), "export default {};\n"),
  ]);

  return appRoot;
}

async function createCustomAppDirFixture() {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-core-custom-appdir-"));
  tempDirs.push(appRoot);

  const files = [
    "package.json",
    "dawn.config.ts",
    "src/custom-app/page.tsx",
  ];

  await Promise.all(
    files.map(async (relativePath) => {
      const filePath = join(appRoot, relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        relativePath === "dawn.config.ts"
          ? 'const appDir = "src/custom-app";\nexport default { appDir };\n'
          : relativePath.endsWith(".json")
            ? "{}"
            : "export default {};\n",
      );
    }),
  );

  return appRoot;
}

async function createAppWithMissingConfiguredAppDir() {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-core-missing-configured-appdir-"));
  tempDirs.push(appRoot);

  await Promise.all([
    writeFile(join(appRoot, "package.json"), "{}"),
    writeFile(join(appRoot, "dawn.config.ts"), 'const appDir = "src/custom-app";\nexport default { appDir };\n'),
    mkdir(join(appRoot, "src", "app"), { recursive: true }),
  ]);

  return appRoot;
}

async function createAppWithNormalizedCollision() {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-core-route-collision-"));
  tempDirs.push(appRoot);

  const files = [
    "package.json",
    "dawn.config.ts",
    "src/app/(marketing)/about/page.tsx",
    "src/app/about/page.tsx",
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

describe("discoverRoutes", () => {
  test("detects the app root from dawn.config.ts and starts discovery at src/app", async () => {
    const appRoot = await createFixtureApp();

    const manifest = await discoverRoutes({ cwd: join(appRoot, "src", "app", "(public)") });

    expect(manifest.appRoot).toBe(appRoot);
    expect(manifest.routes.map((route) => route.pathname)).toEqual([
      "/",
      "/[tenant]",
      "/docs/[...path]",
      "/docs/[[...path]]",
      "/internal",
    ]);
  });

  test("ignores route groups in public paths, preserves dynamic metadata, excludes _private, and accepts graph/workflow entries", async () => {
    const appRoot = await createFixtureApp();

    const manifest = await discoverRoutes({ appRoot });

    expect(manifest.routes).toEqual([
      expect.objectContaining({
        pathname: "/",
        entryFile: join(appRoot, "src/app/(public)/page.tsx"),
        segments: [],
      }),
      expect.objectContaining({
        pathname: "/[tenant]",
        entryFile: join(appRoot, "src/app/(public)/[tenant]/graph.ts"),
        entryKind: "graph",
        segments: [{ raw: "[tenant]", name: "tenant", kind: "dynamic" }],
      }),
      expect.objectContaining({
        pathname: "/docs/[...path]",
        entryFile: join(appRoot, "src/app/docs/[...path]/workflow.ts"),
        entryKind: "workflow",
        segments: [
          { raw: "docs", kind: "static" },
          { raw: "[...path]", name: "path", kind: "catchall" },
        ],
      }),
      expect.objectContaining({
        pathname: "/docs/[[...path]]",
        entryFile: join(appRoot, "src/app/docs/[[...path]]/graph.ts"),
        entryKind: "graph",
        segments: [
          { raw: "docs", kind: "static" },
          { raw: "[[...path]]", name: "path", kind: "optional-catchall" },
        ],
      }),
      expect.objectContaining({
        pathname: "/internal",
        entryFile: join(appRoot, "src/app/internal/workflow.ts"),
        entryKind: "workflow",
      }),
    ]);
  });

  test("fails validation when the canonical src/app discovery root is missing", async () => {
    const appRoot = await createAppWithoutRoutesDir();

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(
      `Invalid Dawn app at ${appRoot}. Missing: ${join(appRoot, "src/app")}`,
    );
  });

  test("loads a configured appDir from a const-backed dawn.config.ts export", async () => {
    const appRoot = await createCustomAppDirFixture();

    const manifest = await discoverRoutes({ appRoot });

    expect(manifest.routes.map((route) => route.pathname)).toEqual(["/"]);
    expect(manifest.routes[0]?.entryFile).toBe(join(appRoot, "src/custom-app/page.tsx"));
  });

  test("fails validation when a configured appDir is missing", async () => {
    const appRoot = await createAppWithMissingConfiguredAppDir();

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(
      `Invalid Dawn app at ${appRoot}. Missing: ${join(appRoot, "src/custom-app")}`,
    );
  });

  test("fails with a Dawn-specific error when normalized route paths collide", async () => {
    const appRoot = await createAppWithNormalizedCollision();

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(
      `Duplicate Dawn route pathname "/about" detected`,
    );
  });
});
