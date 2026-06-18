import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  FAIL_CLOSED_NPMRC,
  rewriteGeneratedAppDependencies,
  SCAFFOLD_PACKAGES,
} from "./scaffold-packaging.js"

async function makePkg(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scaffold-pkg-"))
  await writeFile(join(dir, "package.json"), JSON.stringify(contents), "utf8")
  return dir
}
// biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary package.json shape
async function readPkg(dir: string): Promise<any> {
  return JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
}

// Mirrors createPackagedInstaller: a tarball for every SCAFFOLD_PACKAGES entry
// plus devkit + create-dawn-ai-app. The fail-loud override loop requires the
// full set, so an incomplete map would (correctly) throw.
const tarballs = {
  "@dawn-ai/cli": "/packs/cli.tgz",
  "@dawn-ai/config-typescript": "/packs/config-ts.tgz",
  "@dawn-ai/core": "/packs/core.tgz",
  "@dawn-ai/evals": "/packs/evals.tgz",
  "@dawn-ai/langchain": "/packs/langchain.tgz",
  "@dawn-ai/langgraph": "/packs/langgraph.tgz",
  "@dawn-ai/permissions": "/packs/permissions.tgz",
  "@dawn-ai/sdk": "/packs/sdk.tgz",
  "@dawn-ai/sqlite-storage": "/packs/sqlite.tgz",
  "@dawn-ai/testing": "/packs/testing.tgz",
  "@dawn-ai/workspace": "/packs/workspace.tgz",
  "@dawn-ai/devkit": "/packs/devkit.tgz",
  "create-dawn-ai-app": "/packs/create.tgz",
}

describe("SCAFFOLD_PACKAGES", () => {
  it("lists @dawn-ai workspace packages, excluding devkit/create-dawn-ai-app", () => {
    expect(SCAFFOLD_PACKAGES).toContain("@dawn-ai/cli")
    expect(SCAFFOLD_PACKAGES).toContain("@dawn-ai/evals")
    expect(SCAFFOLD_PACKAGES).toContain("@dawn-ai/testing")
    expect(SCAFFOLD_PACKAGES).not.toContain("@dawn-ai/devkit")
    expect(SCAFFOLD_PACKAGES).not.toContain("create-dawn-ai-app")
  })
})

describe("rewriteGeneratedAppDependencies", () => {
  it("swaps existing deps/devDeps that are in the tarball map, leaves unknown deps untouched", async () => {
    const dir = await makePkg({
      dependencies: { "@dawn-ai/cli": "next", "@dawn-ai/core": "next", zod: "^3.24.0" },
      devDependencies: { "@dawn-ai/config-typescript": "next", vitest: "4.1.4" },
    })
    await rewriteGeneratedAppDependencies({ appRoot: dir, tarballs })
    const pkg = await readPkg(dir)
    expect(pkg.dependencies["@dawn-ai/cli"]).toBe("/packs/cli.tgz")
    expect(pkg.dependencies["@dawn-ai/core"]).toBe("/packs/core.tgz")
    expect(pkg.dependencies.zod).toBe("^3.24.0")
    expect(pkg.devDependencies["@dawn-ai/config-typescript"]).toBe("/packs/config-ts.tgz")
    expect(pkg.devDependencies.vitest).toBe("4.1.4")
  })

  it("sets pnpm.overrides for every packed SCAFFOLD package (not devkit/create-app)", async () => {
    const dir = await makePkg({ dependencies: { "@dawn-ai/cli": "next" } })
    await rewriteGeneratedAppDependencies({ appRoot: dir, tarballs })
    const pkg = await readPkg(dir)
    expect(pkg.pnpm.overrides["@dawn-ai/cli"]).toBe("/packs/cli.tgz")
    expect(pkg.pnpm.overrides["@dawn-ai/permissions"]).toBe("/packs/permissions.tgz")
    expect(pkg.pnpm.overrides["@dawn-ai/devkit"]).toBeUndefined()
    expect(pkg.pnpm.overrides["create-dawn-ai-app"]).toBeUndefined()
  })

  it("applies extraDependencies (forced direct deps + version strings) and removeDependencies", async () => {
    const dir = await makePkg({
      dependencies: { "@dawn-ai/cli": "next", langchain: "0.3.0", "@langchain/openai": "0.3.0" },
    })
    await rewriteGeneratedAppDependencies({
      appRoot: dir,
      tarballs,
      extraDependencies: {
        "@dawn-ai/permissions": tarballs["@dawn-ai/permissions"],
        "@dawn-ai/sqlite-storage": tarballs["@dawn-ai/sqlite-storage"],
        "@dawn-ai/workspace": tarballs["@dawn-ai/workspace"],
        "@langchain/langgraph": "1.3.0",
      },
      removeDependencies: ["langchain", "@langchain/openai"],
    })
    const pkg = await readPkg(dir)
    expect(pkg.dependencies.langchain).toBeUndefined()
    expect(pkg.dependencies["@langchain/openai"]).toBeUndefined()
    expect(pkg.dependencies["@dawn-ai/permissions"]).toBe("/packs/permissions.tgz")
    expect(pkg.dependencies["@langchain/langgraph"]).toBe("1.3.0")
  })

  it("writes the fail-closed .npmrc pinning @dawn-ai to an unreachable registry", async () => {
    const dir = await makePkg({ dependencies: { "@dawn-ai/cli": "next" } })
    await rewriteGeneratedAppDependencies({ appRoot: dir, tarballs })
    const npmrc = await readFile(join(dir, ".npmrc"), "utf8")
    expect(npmrc).toBe(FAIL_CLOSED_NPMRC)
    expect(npmrc).toContain("@dawn-ai:registry=http://127.0.0.1:1/")
  })

  it("throws when a SCAFFOLD package has no packed tarball (silent override skip → loud)", async () => {
    const { "@dawn-ai/workspace": _omitted, ...incomplete } = tarballs
    const dir = await makePkg({ dependencies: { "@dawn-ai/cli": "next" } })
    await expect(
      rewriteGeneratedAppDependencies({ appRoot: dir, tarballs: incomplete }),
    ).rejects.toThrow(/@dawn-ai\/workspace/)
  })

  it("throws when a direct @dawn-ai dependency has no packed tarball", async () => {
    const dir = await makePkg({ dependencies: { "@dawn-ai/not-packed": "next" } })
    await expect(rewriteGeneratedAppDependencies({ appRoot: dir, tarballs })).rejects.toThrow(
      /@dawn-ai\/not-packed/,
    )
  })
})
