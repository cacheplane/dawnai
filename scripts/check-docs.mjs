import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const repoRoot = resolve(import.meta.dirname, "..")

const checks = [
  {
    file: "apps/web/content/docs/getting-started.mdx",
    patterns: ["dawn.config.ts"],
  },
  {
    file: "apps/web/content/docs/cli.mdx",
    patterns: ["dawn.config.ts", "appDir"],
  },
]

const failures = []

function walkFiles(dir, predicate, output = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next") continue
      walkFiles(full, predicate, output)
    } else if (predicate(full)) {
      output.push(full)
    }
  }
  return output
}

function relativeToRoot(filePath) {
  return filePath.replace(`${repoRoot}/`, "")
}

function isDraftBlogPost(filePath, source) {
  return filePath.includes("/apps/web/content/blog/") && /^draft:\s*true$/m.test(source)
}

function frontmatterDate(source) {
  const match = source.match(/^date:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})$/m)
  return match?.[1] ?? null
}

for (const check of checks) {
  const filePath = resolve(repoRoot, check.file)
  const source = readFileSync(filePath, "utf8")

  for (const pattern of check.patterns) {
    if (!source.includes(pattern)) {
      failures.push(`${check.file} is missing required docs text: ${pattern}`)
    }
  }
}

// CLI surface check — drive from the commander registry to catch docs drift.
// Every user-facing command name and every long option must be referenced in
// cli.mdx. The internal `dev-child` command is excluded (not user-facing).
const cliMdxPath = resolve(repoRoot, "apps/web/content/docs/cli.mdx")
const cliMdx = readFileSync(cliMdxPath, "utf8")

const cliEntryUrl = pathToFileURL(resolve(repoRoot, "packages/cli/dist/index.js")).href
const cliEntry = await import(cliEntryUrl).catch((error) => {
  failures.push(
    `CLI surface check could not import packages/cli/dist/index.js — did you run pnpm build? (${error.message})`,
  )
  return null
})

if (cliEntry?.createProgram) {
  const noopIo = {
    stdout: () => undefined,
    stderr: () => undefined,
  }
  const program = cliEntry.createProgram(noopIo)

  const HIDDEN_COMMANDS = new Set(["__dev-child"])

  for (const command of program.commands) {
    const name = command.name()
    if (HIDDEN_COMMANDS.has(name)) {
      continue
    }

    if (!cliMdx.includes(`dawn ${name}`)) {
      failures.push(
        `apps/web/content/docs/cli.mdx is missing reference to command \`dawn ${name}\``,
      )
    }

    for (const option of command.options) {
      const flag = option.long ?? option.short
      if (!flag) {
        continue
      }
      if (!cliMdx.includes(flag)) {
        failures.push(
          `apps/web/content/docs/cli.mdx is missing reference to \`${flag}\` (option of \`dawn ${name}\`)`,
        )
      }
    }
  }
}

const userFacingRoots = [
  "README.md",
  "CONTRIBUTING.md",
  "CONTRIBUTORS.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "apps/web/app",
  "apps/web/content",
  "docs",
  "packages",
]

const forbiddenContent = [
  {
    pattern: /dawn-ai\.org/,
    message: "uses the retired dawn-ai.org domain",
  },
  {
    pattern:
      /dawn run ['"](?:\/hello\/acme|hello\/\[tenant\]|\/support\/acme|\/support\/\[tenant\]\/research)['"]/,
    message: "uses a concrete dynamic route instead of the parameterized route id with JSON input",
  },
  {
    pattern: /export default (?:graph|chain)\b/,
    message: "uses a default graph/chain route export instead of named route exports",
  },
  {
    pattern: /route_path["']?\s*:\s*["']\/[^"']+/,
    message: "uses a route_path value that is not the source entry file path",
  },
  {
    pattern: /(^|[^/.])dawn\.generated\.d\.ts/,
    message: "references dawn.generated.d.ts without the .dawn/ directory",
    shouldCheck: (filePath) => /\.(md|mdx|tape)$/.test(filePath),
  },
  {
    pattern: /dawn test --url/,
    message: "uses the removed command-level dawn test --url flag",
  },
  {
    pattern: /agent\.bindTools/,
    message: "describes generated agent entries with the old bindTools path",
  },
  {
    pattern: /\.dawn\/generated/,
    message: "references the old generated types directory",
  },
  {
    pattern: /openai:gpt/,
    message: "uses provider-prefixed OpenAI model ids in Dawn agent examples",
  },
  {
    pattern:
      /speaks the LangSmith protocol natively|What works locally works in production|without translation|byte-identical/,
    message: "overstates local/prod protocol or deployment parity",
  },
  {
    pattern: /auto-bound|auto-registered/,
    message: "uses old tool auto-binding wording",
  },
]

const userFacingFiles = []
for (const root of userFacingRoots) {
  const full = resolve(repoRoot, root)
  const stat = statSync(full)
  if (stat.isDirectory()) {
    walkFiles(
      full,
      (file) =>
        /\.(md|mdx|ts|tsx|mjs|js|json|tape)$/.test(file) &&
        !file.includes("/docs/superpowers/") &&
        !file.includes("/packages/create-dawn-app/dist/"),
      userFacingFiles,
    )
  } else {
    userFacingFiles.push(full)
  }
}

const today = new Date().toISOString().slice(0, 10)
for (const filePath of userFacingFiles) {
  const source = readFileSync(filePath, "utf8")
  if (isDraftBlogPost(filePath, source)) {
    continue
  }

  for (const { pattern, message, shouldCheck } of forbiddenContent) {
    if (typeof shouldCheck === "function" && !shouldCheck(filePath)) {
      continue
    }
    if (pattern.test(source)) {
      failures.push(`${relativeToRoot(filePath)} ${message}`)
    }
  }

  if (filePath.includes("/apps/web/content/blog/")) {
    const date = frontmatterDate(source)
    if (date && date > today) {
      failures.push(
        `${relativeToRoot(filePath)} is future-dated (${date}) but is not marked draft: true`,
      )
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
