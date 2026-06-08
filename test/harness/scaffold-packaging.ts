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

  const swap = (deps: Record<string, string> | undefined): void => {
    if (!deps) return
    for (const name of Object.keys(deps)) {
      const tarball = options.tarballs[name]
      if (tarball) deps[name] = tarball
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
    if (tarball) overrides[name] = tarball
  }
  pkg.pnpm = { ...(pkg.pnpm ?? {}), overrides }

  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8")
}
