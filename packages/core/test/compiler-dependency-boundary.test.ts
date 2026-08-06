import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

type PackageManifest = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const corePackageUrl = new URL("../package.json", import.meta.url)
const rootPackageUrl = new URL("../../../package.json", import.meta.url)
const vitePackageUrl = new URL("../../vite-plugin/package.json", import.meta.url)

function readManifest(url: URL): PackageManifest {
  return JSON.parse(readFileSync(url, "utf8")) as PackageManifest
}

describe("compiler dependency boundary", () => {
  test("keeps the TypeScript 6 compiler API isolated in Core", () => {
    const core = readManifest(corePackageUrl)
    const vite = readManifest(vitePackageUrl)

    expect(core.dependencies?.typescript).toBe("npm:@typescript/typescript6@6.0.2")
    expect(core.dependencies?.["@typescript/old"]).toBe("npm:typescript@6.0.2")
    for (const dependencySection of [
      vite.dependencies,
      vite.devDependencies,
      vite.peerDependencies,
      vite.optionalDependencies,
    ]) {
      expect(dependencySection?.typescript).toBeUndefined()
    }

    const coreRequire = createRequire(corePackageUrl)
    const coreCompiler = coreRequire("typescript") as typeof import("typescript")
    expect(coreCompiler.version).toBe("6.0.2")
    expect(coreCompiler.createProgram).toBeTypeOf("function")
    expect(coreCompiler.createSourceFile).toBeTypeOf("function")
  })

  test("uses TypeScript 7 for workspace compilation", () => {
    const rootRequire = createRequire(rootPackageUrl)
    const rootTypeScriptPackage = rootRequire("typescript/package.json") as {
      version: string
    }
    expect(rootTypeScriptPackage.version).toBe("7.0.2")

    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
    const cliVersion = execFileSync("pnpm", ["exec", "tsc", "--version"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim()
    expect(cliVersion).toBe("Version 7.0.2")
  })
})
