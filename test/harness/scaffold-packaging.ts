import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Canonical set of @dawn-ai/* workspace packages a generated app may depend on.
 * createPackagedInstaller additionally packs @dawn-ai/devkit + create-dawn-ai-app,
 * which are deliberately NOT in this list (they are never generated-app overrides).
 */
export const SCAFFOLD_PACKAGES: readonly string[] = [
  "@dawn-ai/cli",
  "@dawn-ai/config-typescript",
  "@dawn-ai/core",
  "@dawn-ai/evals",
  "@dawn-ai/langchain",
  "@dawn-ai/langgraph",
  "@dawn-ai/permissions",
  "@dawn-ai/sdk",
  "@dawn-ai/sqlite-storage",
  "@dawn-ai/testing",
  "@dawn-ai/workspace",
]

/**
 * `.npmrc` written into every externally-packaged generated app. A generated
 * app under test must resolve every `@dawn-ai/*` package from the locally
 * packed tarballs (direct deps + pnpm overrides), NEVER the public registry.
 *
 * Pinning the scope to an unreachable registry enforces that invariant: any
 * edge the local wiring fails to cover (a missing tarball, or a transitive dep
 * pnpm declines to apply an override to) fails loudly with an `@dawn-ai`
 * meta-fetch error on EVERY run, instead of silently fetching whatever happens
 * to be published. That silent registry fallback is exactly what hid the
 * missing `@dawn-ai/workspace` direct dep until it broke a release (see the
 * release-harness postmortem). Non-`@dawn-ai` deps still use the real registry.
 */
export const FAIL_CLOSED_NPMRC = [
  "# Test harness: @dawn-ai/* must resolve from local tarballs only. Pinning the",
  "# scope to an unreachable registry makes any missing local wiring fail loudly",
  "# instead of silently falling back to the public registry.",
  "@dawn-ai:registry=http://127.0.0.1:1/",
  "",
].join("\n")

export interface RewriteGeneratedAppDepsOptions {
  readonly appRoot: string
  readonly tarballs: Readonly<Record<string, string>>
  /** Forced deps to add (tarball paths for @dawn pkgs, or version strings e.g. @langchain/langgraph). */
  readonly extraDependencies?: Readonly<Record<string, string>>
  /** Dep keys to delete from deps+devDeps before rewriting (e.g. langchain, @langchain/openai). */
  readonly removeDependencies?: readonly string[]
}

interface MutablePackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  pnpm?: { overrides?: Record<string, string> }
}

export async function rewriteGeneratedAppDependencies(
  options: RewriteGeneratedAppDepsOptions,
): Promise<void> {
  const packageJsonPath = join(options.appRoot, "package.json")
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as MutablePackageJson

  for (const key of options.removeDependencies ?? []) {
    if (pkg.dependencies) delete pkg.dependencies[key]
    if (pkg.devDependencies) delete pkg.devDependencies[key]
  }

  // Fail loud, not silent: a `@dawn-ai/*` dependency with no packed tarball is a
  // harness wiring bug. Leaving it as a registry version spec is what let the
  // gap reach a release; throw here so it surfaces on the introducing change.
  const swap = (deps: Record<string, string> | undefined): void => {
    if (!deps) return
    for (const name of Object.keys(deps)) {
      const tarball = options.tarballs[name]
      if (tarball) {
        deps[name] = tarball
      } else if (name.startsWith("@dawn-ai/")) {
        throw new Error(
          `No packed tarball provided for @dawn-ai dependency "${name}". Every @dawn-ai/* dependency of a generated app must be pinned to a local tarball (add it to the createPackagedInstaller package set).`,
        )
      }
    }
  }
  swap(pkg.dependencies)
  swap(pkg.devDependencies)

  if (options.extraDependencies) {
    pkg.dependencies = { ...pkg.dependencies, ...options.extraDependencies }
  }

  const overrides: Record<string, string> = { ...(pkg.pnpm?.overrides ?? {}) }
  for (const name of SCAFFOLD_PACKAGES) {
    const tarball = options.tarballs[name]
    if (!tarball) {
      throw new Error(
        `No packed tarball for scaffold package "${name}". createPackagedInstaller must pack every SCAFFOLD_PACKAGES entry so its override pins to a local tarball.`,
      )
    }
    overrides[name] = tarball
  }
  pkg.pnpm = { ...(pkg.pnpm ?? {}), overrides }

  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8")
  // Enforce local-only @dawn-ai resolution (see FAIL_CLOSED_NPMRC).
  await writeFile(join(options.appRoot, ".npmrc"), FAIL_CLOSED_NPMRC, "utf8")
}
