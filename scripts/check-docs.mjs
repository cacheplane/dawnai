import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")

const checks = [
  {
    file: "apps/web/app/docs/getting-started/page.tsx",
    patterns: ["supported dawn.config.ts subset", "appDir", "export default { appDir }"],
  },
  {
    file: "apps/web/app/docs/packages/page.tsx",
    patterns: ["publishable", "public package", "release channel"],
  },
  {
    file: "apps/web/app/docs/cli/page.tsx",
    patterns: ["CLI command scope", "bootstrap-local scaffolding", "published scaffolding"],
  },
]

const failures = []

for (const check of checks) {
  const filePath = resolve(repoRoot, check.file)
  const source = readFileSync(filePath, "utf8")

  for (const pattern of check.patterns) {
    if (!source.includes(pattern)) {
      failures.push(`${check.file} is missing required docs text: ${pattern}`)
    }
  }
}

if (failures.length > 0) {
  console.error("Docs completeness check failed.")
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log("Docs completeness check passed.")
