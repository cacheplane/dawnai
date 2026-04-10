import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const rootDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(rootDir, "..");
const forwardedArgs = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));

if (forwardedArgs.length > 0) {
  console.error(
    [
      "The root test wrapper does not forward extra arguments.",
      "Use `pnpm exec vitest --run --config vitest.workspace.ts ...` while the bootstrap smoke test is active,",
      "or `pnpm turbo run test -- ...` once package-level tests are wired.",
    ].join(" "),
  );
  process.exit(1);
}

const bootstrapTargets = [
  "packages/core",
  "packages/cli",
  "packages/create-dawn-app",
];

// Keep the repo red until the initial package test surfaces exist, then hand off
// to the normal Turbo-managed package test flow.
const hasRunnablePackageTests = bootstrapTargets.every((target) => {
  const packageJsonPath = resolve(repoRoot, target, "package.json");
  const vitestConfigPath = resolve(repoRoot, target, "vitest.config.ts");

  if (!existsSync(packageJsonPath) || !existsSync(vitestConfigPath)) {
    return false;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  return typeof packageJson?.scripts?.test === "string";
});

const command = hasRunnablePackageTests
  ? ["pnpm", ["turbo", "run", "test"]]
  : ["pnpm", ["exec", "vitest", "--run", "--config", "vitest.workspace.ts"]];

const result = spawnSync(command[0], command[1], {
  cwd: repoRoot,
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
