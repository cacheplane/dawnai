import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  assertDisjointPackageTiers,
  resolvePublicPackageTiers,
  validatePackageDiscoveryMetadata,
  validatePackageReadme,
  validateRootReadme,
} from "./lib/readme-contracts.mjs"

const entryManifest = {
  name: "@dawn-ai/sdk",
  private: false,
  description: "Author-facing TypeScript SDK for defining Dawn agents.",
  keywords: ["dawn", "typescript", "langgraph"],
}

const entryReadme = `# @dawn-ai/sdk

Author-facing TypeScript SDK.

**Use this when:** You are authoring a Dawn route.

## Install

## Example

## Runtime and stability

## Related

## Maturity and support

## License

![Dawn product loop](https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif)`

const rootReadme = `# Dawn

## Quickstart

\`npm create dawn-ai-app@latest my-agent\`

## Why Dawn

## How Dawn fits

[Migrate from LangGraph](/docs/migrating-from-langgraph)

## What Dawn writes for you

## What are you building?

## When Dawn fits

## Build with a coding agent

## Run it live

![Dawn product loop](docs/brand/product-loop.gif)

[Read the demo transcript](docs/brand/demo/transcript.md)

## Maturity and support`

const actualRootReadme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
const actualEntryPackages = [
  {
    directory: "create-dawn-app",
    description: "Scaffold a Dawn TypeScript agent application with supported starter templates.",
    keywords: ["dawn", "typescript", "langgraph", "ai-agents", "scaffolding", "create-app"],
  },
  {
    directory: "sdk",
    description:
      "Author-facing TypeScript SDK for defining Dawn agents, tools, middleware, memory, and routes.",
    keywords: ["dawn", "typescript", "langgraph", "ai-agents", "sdk", "agent-framework"],
  },
  {
    directory: "cli",
    description:
      "Command-line development, testing, build, and runtime tools for Dawn applications.",
    keywords: ["dawn", "typescript", "langgraph", "cli", "ai-agents", "developer-tools"],
  },
].map(({ directory, description, keywords }) => {
  const packageRoot = new URL(`../packages/${directory}/`, import.meta.url)
  const actualManifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"))

  return {
    manifest: { ...actualManifest, description, keywords },
    readme: readFileSync(new URL("README.md", packageRoot), "utf8"),
  }
})
const actualCapabilityPackages = [
  {
    directory: "ag-ui",
    description: "AG-UI protocol adapters for streaming Dawn agent runs to compatible clients.",
    keywords: ["dawn", "typescript", "langgraph", "ag-ui", "ai-agents", "streaming"],
  },
  {
    directory: "evals",
    description: "Evaluation definitions, scorers, datasets, and runners for Dawn agents.",
    keywords: ["dawn", "typescript", "ai-agents", "evals", "testing", "llm"],
  },
  {
    directory: "inspector",
    description: "Browser inspector for reviewing memory and runtime state in a Dawn application.",
    keywords: ["dawn", "typescript", "ai-agents", "inspector", "memory", "developer-tools"],
  },
  {
    directory: "memory",
    description:
      "Long-term memory storage, ranking, recall, and distillation primitives for Dawn agents.",
    keywords: ["dawn", "typescript", "ai-agents", "memory", "retrieval", "llm"],
  },
  {
    directory: "memory-pgvector",
    description: "Postgres and pgvector storage for shared Dawn agent memory and vector retrieval.",
    keywords: ["dawn", "typescript", "ai-agents", "memory", "postgres", "pgvector"],
  },
  {
    directory: "permissions",
    description: "Permission matching, approval gates, and access-control stores for Dawn agents.",
    keywords: [
      "dawn",
      "typescript",
      "ai-agents",
      "permissions",
      "access-control",
      "human-in-the-loop",
    ],
  },
  {
    directory: "postgres-storage",
    description: "Postgres persistence for Dawn checkpoints, threads, and permission decisions.",
    keywords: ["dawn", "typescript", "langgraph", "postgres", "persistence", "ai-agents"],
  },
  {
    directory: "sandbox",
    description: "Docker and Kubernetes sandbox providers for isolated Dawn workspace execution.",
    keywords: ["dawn", "typescript", "ai-agents", "sandbox", "docker", "kubernetes"],
  },
  {
    directory: "sqlite-storage",
    description:
      "SQLite persistence for Dawn checkpoints, Agent Protocol threads, and local state.",
    keywords: ["dawn", "typescript", "langgraph", "sqlite", "persistence", "ai-agents"],
  },
  {
    directory: "testing",
    description:
      "Deterministic harnesses, fixtures, and matchers for testing Dawn agent applications.",
    keywords: ["dawn", "typescript", "ai-agents", "testing", "fixtures", "llm"],
  },
  {
    directory: "workspace",
    description: "Filesystem and shell workspace contracts and tools for Dawn agent applications.",
    keywords: ["dawn", "typescript", "ai-agents", "filesystem", "shell", "developer-tools"],
  },
].map(({ directory, description, keywords }) => {
  const packageRoot = new URL(`../packages/${directory}/`, import.meta.url)
  const actualManifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"))

  return {
    // Actual discovery metadata is intentionally deferred to Task 10.
    manifest: { ...actualManifest, description, keywords },
    readme: readFileSync(new URL("README.md", packageRoot), "utf8"),
  }
})
const relatedPackageDestinations = new Map([
  [
    "create-dawn-ai-app",
    ["https://www.npmjs.com/package/@dawn-ai/cli", "https://www.npmjs.com/package/@dawn-ai/sdk"],
  ],
  [
    "@dawn-ai/sdk",
    [
      "https://www.npmjs.com/package/@dawn-ai/cli",
      "https://www.npmjs.com/package/@dawn-ai/testing",
    ],
  ],
  [
    "@dawn-ai/cli",
    ["https://www.npmjs.com/package/@dawn-ai/sdk", "https://www.npmjs.com/package/@dawn-ai/core"],
  ],
])
const entryReadmeAssets = new Map([
  [
    "logo",
    "https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png",
  ],
  [
    "product loop",
    "https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif",
  ],
])
const entryReadmeBlocks = new Map([
  [
    "logo",
    `<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180">
</p>`,
  ],
  [
    "product loop",
    `<p align="center">
  <a href="https://dawnai.org/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif" alt="Dawn product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>`,
  ],
])
const entryReadmeBlockMutations = new Map([
  [
    "logo",
    [
      ["centered wrapper", (block) => block.replace('<p align="center">', "<p>")],
      ["alt text", (block) => block.replace('alt="Dawn"', 'alt="Dawn logo"')],
      ["width", (block) => block.replace('width="180"', 'width="181"')],
    ],
  ],
  [
    "product loop",
    [
      ["centered wrapper", (block) => block.replace('<p align="center">', "<p>")],
      [
        "anchor",
        (block) => block.replace("https://dawnai.org/#product-loop", "https://dawnai.org/docs"),
      ],
      [
        "alt text",
        (block) =>
          block.replace(
            "Dawn product loop: route, deterministic test, and Workbench",
            "Dawn product loop",
          ),
      ],
      ["width", (block) => block.replace('width="720"', 'width="721"')],
    ],
  ],
])
const canonicalHeroCommandBlock = `\`\`\`bash
npm create dawn-ai-app@latest my-agent
\`\`\``
const canonicalProductLoopBlock = `<p align="center">
  <a href="https://dawnai.org/#product-loop">
    <img src="docs/brand/product-loop.gif" alt="Animation showing an existing generated research workspace, a deterministic test, and the Dawn Workbench" width="900">
  </a>
</p>`
const canonicalQualifiedCredentials = `Credentials are provider-specific: the published research starter's OpenAI live
path requires \`OPENAI_API_KEY\`, while a local Ollama route requires no provider
key.`
const canonicalFinalCta = `Ready to start?

\`\`\`bash
npm create dawn-ai-app@latest my-agent
\`\`\``

function assertFailure(failures, expected) {
  assert.ok(
    failures.some((failure) => expected.test(failure)),
    `Expected a failure matching ${expected}, received:\n${failures.join("\n")}`,
  )
}

function assertExactEntryBranding(packageName, readme) {
  for (const [blockName, block] of entryReadmeBlocks) {
    assert.ok(
      readme.includes(block),
      `${packageName} must use the exact canonical ${blockName} block`,
    )
  }
}

function relatedSection(readme) {
  const relatedStart = readme.indexOf("## Related")
  const relatedEnd = readme.indexOf("\n## ", relatedStart + 1)
  return readme.slice(relatedStart, relatedEnd === -1 ? undefined : relatedEnd)
}

function assertRelatedPackageDestinations(packageName, readme) {
  const expectedDestinations = relatedPackageDestinations.get(packageName) ?? []
  const related = relatedSection(readme)

  for (const destination of expectedDestinations) {
    assert.ok(
      related.includes(`](${destination})`),
      `${packageName} Related must link to ${destination}`,
    )
  }
}

describe("validatePackageReadme", () => {
  it("accepts a complete entry-package README and manifest", () => {
    assert.deepEqual(
      validatePackageReadme({
        tier: "entry",
        manifest: entryManifest,
        readme: entryReadme,
      }),
      [],
    )
  })

  it("accepts the planned raw HTML product-loop thumbnail", () => {
    const readme = entryReadme.replace(
      "![Dawn product loop](https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif)",
      `<p align="center">
  <a href="https://dawnai.org/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif" alt="Dawn product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>`,
    )
    assert.deepEqual(validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }), [])
  })

  it("accepts an inline raw-text tag before the planned HTML thumbnail", () => {
    const readme = entryReadme
      .replace(
        "Author-facing TypeScript SDK.",
        "Author-facing TypeScript SDK. Inline `<script>` is documentation text.",
      )
      .replace(
        "![Dawn product loop](https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif)",
        `<p align="center">
  <a href="https://dawnai.org/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif" alt="Dawn product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>`,
      )
    assert.deepEqual(validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }), [])
  })

  for (const [name, literal] of [
    ["inline code", "`<!--`"],
    ["a fenced block", "```md\n<!--\n```"],
  ]) {
    it(`accepts an unmatched comment opener inside ${name} before package requirements`, () => {
      const readme = entryReadme.replace(
        "Author-facing TypeScript SDK.\n",
        `Author-facing TypeScript SDK.\n\n${literal}\n`,
      )
      assert.deepEqual(
        validatePackageReadme({
          tier: "entry",
          manifest: entryManifest,
          readme,
        }),
        [],
      )
    })
  }

  it("accepts an escaped raw-text opener before the genuine thumbnail", () => {
    const readme = entryReadme
      .replace(
        "Author-facing TypeScript SDK.",
        "Author-facing TypeScript SDK. Escaped \\<script> is prose.",
      )
      .replace(
        "![Dawn product loop](https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif)",
        `<p align="center">
  <a href="https://dawnai.org/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif" alt="Dawn product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>`,
      )
    assert.deepEqual(validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }), [])
  })

  it("does not accept Markdown image syntax inside a raw HTML block", () => {
    const readme = entryReadme.replace(
      /!\[Dawn product loop\].*$/u,
      "<p>\n    ![Loop](docs/brand/product-loop.gif)\n</p>",
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /product-loop\.gif/,
    )
  })

  it("accepts visible purpose prose inside a raw HTML block", () => {
    const readme = entryReadme.replace(
      "Author-facing TypeScript SDK.",
      "<div>\nAuthor-facing TypeScript SDK.\n</div>",
    )
    assert.deepEqual(validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }), [])
  })

  for (const tag of ["script", "style", "textarea"]) {
    it(`does not accept a Markdown image inside a <${tag}> raw-text block`, () => {
      const readme = entryReadme.replace(
        /!\[Dawn product loop\].*$/u,
        `<${tag}>\n![Loop](docs/brand/product-loop.gif)\n</${tag}>`,
      )
      assertFailure(
        validatePackageReadme({
          tier: "entry",
          manifest: entryManifest,
          readme,
        }),
        /product-loop\.gif/,
      )
    })
  }

  it("does not accept a Markdown image inside a generic HTML block", () => {
    const readme = entryReadme.replace(
      /!\[Dawn product loop\].*$/u,
      "<span>\n![Loop](docs/brand/product-loop.gif)\n</span>",
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /product-loop\.gif/,
    )
  })

  it("does not accept an HTML image inside a raw-text block", () => {
    const readme = entryReadme.replace(
      /!\[Dawn product loop\].*$/u,
      '<script>\n<img src="docs/brand/product-loop.gif" alt="Decoy">\n</script>',
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /product-loop\.gif/,
    )
  })

  it("accepts an HTML image inside a rendered generic HTML block", () => {
    const readme = entryReadme.replace(
      /!\[Dawn product loop\].*$/u,
      '<span>\n<img src="docs/brand/product-loop.gif" alt="Dawn product loop">\n</span>',
    )
    assert.deepEqual(validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }), [])
  })

  it("does not count raw-text block content as purpose prose", () => {
    const readme = entryReadme.replace(
      "Author-facing TypeScript SDK.",
      "<textarea>\nAuthor-facing TypeScript SDK.\n</textarea>",
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /purpose statement/,
    )
  })

  for (const tag of ["script", "style", "textarea"]) {
    it(`does not accept an HTML image nested in <div><${tag}>`, () => {
      const readme = entryReadme.replace(
        /!\[Dawn product loop\].*$/u,
        `<div>\n<${tag}>\n<img src="docs/brand/product-loop.gif" alt="Decoy">\n</${tag}>\n</div>`,
      )
      assertFailure(
        validatePackageReadme({
          tier: "entry",
          manifest: entryManifest,
          readme,
        }),
        /product-loop\.gif/,
      )
    })

    it(`does not count purpose prose nested in <div><${tag}>`, () => {
      const readme = entryReadme.replace(
        "Author-facing TypeScript SDK.",
        `<div>\n<${tag}>\nAuthor-facing TypeScript SDK.\n</${tag}>\n</div>`,
      )
      assertFailure(
        validatePackageReadme({
          tier: "entry",
          manifest: entryManifest,
          readme,
        }),
        /purpose statement/,
      )
    })
  }

  for (const [name, source, expected] of [
    [
      "Use this when guidance",
      entryReadme.replace("**Use this when:** You are authoring a Dawn route.\n\n", ""),
      /Use this when/,
    ],
    [
      "install or invocation heading",
      entryReadme.replace("## Install", "## Setup"),
      /Install.*Invocation/i,
    ],
    ["example heading", entryReadme.replace("## Example", "## API"), /Example/],
    [
      "runtime boundary",
      entryReadme.replace("## Runtime and stability", "## Architecture"),
      /Runtime and stability/,
    ],
    ["related links", entryReadme.replace("## Related", "## Elsewhere"), /Related/],
    [
      "maturity guidance",
      entryReadme.replace("## Maturity and support", "## Status"),
      /Maturity and support/,
    ],
    ["license heading", entryReadme.replace("## License", "## Legal"), /License/],
    [
      "entry-tier product-loop image",
      entryReadme.replace("docs/brand/product-loop.gif", "docs/brand/other.gif"),
      /product-loop\.gif/,
    ],
    ["package-name H1", entryReadme.replace("# @dawn-ai/sdk", "# Dawn SDK"), /H1.*@dawn-ai\/sdk/i],
    ["purpose statement", entryReadme.replace("Author-facing TypeScript SDK.\n\n", ""), /purpose/i],
  ]) {
    it(`rejects a README missing its ${name}`, () => {
      assertFailure(
        validatePackageReadme({
          tier: "entry",
          manifest: entryManifest,
          readme: source,
        }),
        expected,
      )
    })
  }

  it("does not accept a package H1 hidden in a fenced code block", () => {
    const readme = entryReadme.replace(
      "# @dawn-ai/sdk",
      "```md\n# @dawn-ai/sdk\n```\n\n# Different package",
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /H1.*@dawn-ai\/sdk/i,
    )
  })

  it("does not accept an entry image hidden in a fenced code block", () => {
    const readme = entryReadme.replace(
      "![Dawn product loop](https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif)",
      "```md\n![Dawn product loop](docs/brand/product-loop.gif)\n```",
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /product-loop\.gif/,
    )
  })

  it("does not accept an entry image written as inline code", () => {
    const readme = entryReadme.replace(
      "![Dawn product loop](https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif)",
      "`![Dawn product loop](docs/brand/product-loop.gif)`",
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /product-loop\.gif/,
    )
  })

  it("ignores package contract decoys inside a list-nested fence", () => {
    const readme = entryReadme
      .replace("# @dawn-ai/sdk\n\n", "")
      .replace(/!\[Dawn product loop\].*$/u, "")
      .concat("\n- ```md\n  # @dawn-ai/sdk\n  ![Loop](docs/brand/product-loop.gif)\n  ```")
    const failures = validatePackageReadme({
      tier: "entry",
      manifest: entryManifest,
      readme,
    })
    assertFailure(failures, /H1.*@dawn-ai\/sdk/i)
    assertFailure(failures, /product-loop\.gif/)
  })

  it("ignores package contract decoys inside a three-space-indented fence", () => {
    const readme = entryReadme
      .replace("# @dawn-ai/sdk\n\n", "")
      .replace(/!\[Dawn product loop\].*$/u, "")
      .concat("\n   ```md\n# @dawn-ai/sdk\n![Loop](docs/brand/product-loop.gif)\n   ```")
    const failures = validatePackageReadme({
      tier: "entry",
      manifest: entryManifest,
      readme,
    })
    assertFailure(failures, /H1.*@dawn-ai\/sdk/i)
    assertFailure(failures, /product-loop\.gif/)
  })

  it("ignores package contract decoys inside indented code", () => {
    const readme = entryReadme
      .replace("# @dawn-ai/sdk\n\n", "")
      .replace(/!\[Dawn product loop\].*$/u, "")
      .concat("\n    # @dawn-ai/sdk\n    ![Loop](docs/brand/product-loop.gif)")
    const failures = validatePackageReadme({
      tier: "entry",
      manifest: entryManifest,
      readme,
    })
    assertFailure(failures, /H1.*@dawn-ai\/sdk/i)
    assertFailure(failures, /product-loop\.gif/)
  })

  it("does not accept an HTML product-loop image inside indented code", () => {
    const readme = entryReadme.replace(
      /!\[Dawn product loop\].*$/u,
      '    <img src="docs/brand/product-loop.gif" alt="Decoy">',
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /product-loop\.gif/,
    )
  })

  for (const structuralLine of [
    "---",
    "-",
    "1. First list entry",
    "[ci]: https://example.com/ci.svg",
    "![CI](https://example.com/ci.svg)",
    "`pnpm add @dawn-ai/sdk`",
    "`Dawn SDK`",
    "| Package | Purpose |",
  ]) {
    it(`does not count ${JSON.stringify(structuralLine)} as purpose prose`, () => {
      const readme = entryReadme.replace("Author-facing TypeScript SDK.", structuralLine)
      assertFailure(
        validatePackageReadme({
          tier: "entry",
          manifest: entryManifest,
          readme,
        }),
        /purpose/i,
      )
    })
  }

  it("requires examples for capability packages", () => {
    const failures = validatePackageReadme({
      tier: "capability",
      manifest: { ...entryManifest, name: "@dawn-ai/memory" },
      readme: entryReadme
        .replaceAll("@dawn-ai/sdk", "@dawn-ai/memory")
        .replace("## Example", "## Configuration"),
    })
    assertFailure(failures, /Example/)
  })

  it("allows tooling packages to use Configuration instead of Example", () => {
    assert.deepEqual(
      validatePackageReadme({
        tier: "tooling",
        manifest: { ...entryManifest, name: "@dawn-ai/core" },
        readme: entryReadme
          .replaceAll("@dawn-ai/sdk", "@dawn-ai/core")
          .replace("## Example", "## Configuration")
          .replace(/\n!\[Dawn product loop\].*$/u, ""),
      }),
      [],
    )
  })

  it("rejects unknown package tiers", () => {
    assert.throws(
      () =>
        validatePackageReadme({
          tier: "unknown",
          manifest: entryManifest,
          readme: entryReadme,
        }),
      /Unknown README tier/,
    )
  })
})

describe("entry-package README contracts", () => {
  // Actual discovery metadata is intentionally deferred to the later actual-manifest tests.
  for (const { manifest, readme } of actualEntryPackages) {
    it(`accepts the actual ${manifest.name} README`, () => {
      assert.deepEqual(validatePackageReadme({ tier: "entry", manifest, readme }), [])
    })

    it(`uses npm-safe absolute assets in the actual ${manifest.name} README`, () => {
      assertExactEntryBranding(manifest.name, readme)
    })

    for (const [assetName, destination] of entryReadmeAssets) {
      it(`rejects a repository-relative ${assetName} in the actual ${manifest.name} README`, () => {
        const mutated = readme.replace(destination, destination.slice(destination.indexOf("docs/")))
        assert.notEqual(mutated, readme)
        assert.throws(() => assertExactEntryBranding(manifest.name, mutated))
      })
    }

    for (const [blockName, mutations] of entryReadmeBlockMutations) {
      it(`rejects noncanonical ${blockName} block fields in the actual ${manifest.name} README`, () => {
        const canonicalBlock = entryReadmeBlocks.get(blockName) ?? ""
        for (const [mutationName, mutate] of mutations) {
          const mutated = readme.replace(canonicalBlock, mutate(canonicalBlock))
          assert.notEqual(mutated, readme, `${manifest.name} ${mutationName} mutation must apply`)
          assert.throws(
            () => assertExactEntryBranding(manifest.name, mutated),
            `${manifest.name} ${mutationName} mutation must fail the asset contract`,
          )
        }
      })
    }

    it(`links the actual ${manifest.name} README to every intended Dawn package`, () => {
      assertRelatedPackageDestinations(manifest.name, readme)
    })

    for (const destination of relatedPackageDestinations.get(manifest.name) ?? []) {
      it(`rejects removing ${destination} from the actual ${manifest.name} Related section`, () => {
        const mutated = readme.replace(`](${destination})`, "](https://example.invalid)")
        assert.notEqual(mutated, readme)
        assert.throws(() => assertRelatedPackageDestinations(manifest.name, mutated))
      })
    }
  }

  it("keeps the actual create-dawn-ai-app release history valid after later publishes", () => {
    const createReadme = actualEntryPackages.find(
      ({ manifest }) => manifest.name === "create-dawn-ai-app",
    )?.readme

    assert.match(
      createReadme ?? "",
      /0\.8\.21[^\n]*single-package[^\n]*0\.8\.22[^\n]*`server`[^\n]*`web`/u,
    )
    assert.match(createReadme ?? "", /`npm view create-dawn-ai-app@latest version`/u)
    for (const selfInvalidatingPhrase of [
      "published `@latest` version was verified as 0.8.21",
      "current 0.8.22 repository source",
      "until that version is published",
    ]) {
      assert.equal(createReadme?.includes(selfInvalidatingPhrase), false)
    }
  })

  it("labels the actual @dawn-ai/cli/testing subpath as deprecated compatibility", () => {
    const cliReadme = actualEntryPackages.find(
      ({ manifest }) => manifest.name === "@dawn-ai/cli",
    )?.readme

    assert.doesNotMatch(
      cliReadme ?? "",
      /`@dawn-ai\/cli\/testing`[ \t]+is[ \t]+a[ \t]+supported\b/iu,
    )
    assert.match(
      cliReadme ?? "",
      /`@dawn-ai\/cli\/testing`[^\n]*\bdeprecated\b[^\n]*`@dawn-ai\/sdk\/testing`/iu,
    )
  })
})

describe("capability-package README contracts", () => {
  for (const { manifest, readme } of actualCapabilityPackages) {
    it(`accepts the actual ${manifest.name} README`, () => {
      assert.deepEqual(validatePackageReadme({ tier: "capability", manifest, readme }), [])
    })
  }
})

describe("validatePackageDiscoveryMetadata", () => {
  it("accepts a trimmed 30-180 character description and 3-8 discovery keywords", () => {
    assert.deepEqual(validatePackageDiscoveryMetadata(entryManifest), [])
    assert.deepEqual(
      validatePackageDiscoveryMetadata({
        ...entryManifest,
        description: "x".repeat(30),
        keywords: Array.from({ length: 8 }, (_, index) => `keyword-${index}`),
      }),
      [],
    )
    assert.deepEqual(
      validatePackageDiscoveryMetadata({
        ...entryManifest,
        description: "x".repeat(180),
      }),
      [],
    )
  })

  for (const [name, patch, expected] of [
    ["missing description", { description: undefined }, /description.*30.*180/i],
    ["untrimmed description", { description: ` ${"x".repeat(30)}` }, /description.*trimmed/i],
    ["short description", { description: "Too short" }, /description.*30.*180/i],
    ["long description", { description: "x".repeat(181) }, /description.*30.*180/i],
    ["empty keywords", { keywords: [] }, /keywords.*3.*8/i],
    ["too few keywords", { keywords: ["dawn", "typescript"] }, /keywords.*3.*8/i],
    [
      "too many keywords",
      { keywords: Array.from({ length: 9 }, (_, index) => `keyword-${index}`) },
      /keywords.*3.*8/i,
    ],
    ["duplicate keywords", { keywords: ["dawn", "dawn", "typescript"] }, /unique/i],
    ["uppercase keywords", { keywords: ["Dawn", "typescript", "langgraph"] }, /lowercase/i],
    ["invalid keywords", { keywords: ["dawn", "type_script", "langgraph"] }, /lowercase/i],
    ["empty keyword values", { keywords: ["dawn", "", "langgraph"] }, /lowercase/i],
  ]) {
    it(`rejects ${name}`, () => {
      assertFailure(validatePackageDiscoveryMetadata({ ...entryManifest, ...patch }), expected)
    })
  }

  it("includes discovery metadata failures in the package README contract", () => {
    assertFailure(
      validatePackageReadme({
        tier: "entry",
        manifest: { ...entryManifest, description: "Too short" },
        readme: entryReadme,
      }),
      /description.*30.*180/i,
    )
  })
})

describe("validateRootReadme", () => {
  it("accepts the actual root README", () => {
    assert.deepEqual(validateRootReadme(actualRootReadme, { canonical: true }), [])
  })

  it("documents the working published latest run path before current-source commands", () => {
    const publishedStart = actualRootReadme.indexOf("### Published `@latest` (0.8.21)")
    const currentSourceStart = actualRootReadme.indexOf("### Current source (unreleased 0.8.22)")
    assert.ok(publishedStart !== -1 && publishedStart < currentSourceStart)
    const published = actualRootReadme.slice(publishedStart, currentSourceStart)
    assert.match(published, /OPENAI_API_KEY/)
    assert.match(published, /npm run dev(?:\s|$)/)
    assert.match(published, /npm run build/)
    assert.match(published, /\/docs\/dev-server\/agent-protocol/)
    assert.match(published, /\/docs\/recipes\/research-web-ui/)
    assert.doesNotMatch(published, /^npm (?:run dev:(?:server|web)|start)$/mu)
  })

  it("labels unreleased current-source server, Workbench, build, and start commands", () => {
    const currentSourceStart = actualRootReadme.indexOf("### Current source (unreleased 0.8.22)")
    const maturityStart = actualRootReadme.indexOf("## Maturity and support")
    assert.ok(currentSourceStart !== -1 && currentSourceStart < maturityStart)
    const currentSource = actualRootReadme.slice(currentSourceStart, maturityStart)
    for (const command of ["npm run dev:server", "npm run dev:web", "npm run build", "npm start"]) {
      assert.match(currentSource, new RegExp(command.replaceAll(" ", "\\s+")))
    }
    for (const deployment of ["node", "langsmith", "edge", "kubernetes"]) {
      assert.match(currentSource, new RegExp(`/docs/deployment/${deployment}`))
    }
  })

  it("accepts the required root README structure and references", () => {
    assert.deepEqual(validateRootReadme(rootReadme), [])
  })

  it("requires the exact canonical hero", () => {
    const source = actualRootReadme.replace(
      "# Build LangGraph agents like Next.js apps.",
      "# Build LangGraph agents with fewer conventions.",
    )
    assertFailure(validateRootReadme(source, { canonical: true }), /exact canonical hero/i)
  })

  it("rejects a sixth hero badge", () => {
    const source = actualRootReadme.replace(
      '</p>\n\n<p align="center">\n  <a href="https://dawnai.org/docs/getting-started">',
      '  <a href="https://example.com"><img src="https://example.com/sixth.svg" alt="Sixth badge"></a>\n</p>\n\n<p align="center">\n  <a href="https://dawnai.org/docs/getting-started">',
    )
    assertFailure(validateRootReadme(source, { canonical: true }), /exactly five approved badges/i)
  })

  it("rejects a sixth hero badge in an adjacent first-scroll block", () => {
    const source = actualRootReadme.replace(
      '<p align="center">\n  <a href="https://dawnai.org/docs/getting-started">',
      '<p align="center">\n  <a href="https://example.com"><img src="https://example.com/sixth.svg" alt="Sixth badge"></a>\n</p>\n\n<p align="center">\n  <a href="https://dawnai.org/docs/getting-started">',
    )
    assertFailure(validateRootReadme(source, { canonical: true }), /exactly five approved badges/i)
  })

  it("rejects a sixth Markdown hero badge before Quickstart", () => {
    const source = actualRootReadme.replace(
      canonicalHeroCommandBlock,
      `[![Sixth](https://example.com/sixth.svg)](https://example.com)\n\n${canonicalHeroCommandBlock}`,
    )
    assertFailure(validateRootReadme(source, { canonical: true }), /exactly five approved badges/i)
  })

  it("rejects a sixth reference-style linked GFM badge before Quickstart", () => {
    const source = actualRootReadme
      .replace(
        canonicalHeroCommandBlock,
        `[![Sixth][sixth-image]][sixth-link]\n\n${canonicalHeroCommandBlock}`,
      )
      .replace(
        "## License",
        "[sixth-image]: https://example.com/sixth.svg\n[sixth-link]: https://example.com\n\n## License",
      )
    assertFailure(validateRootReadme(source, { canonical: true }), /exactly five approved badges/i)
  })

  it("rejects a sixth raw HTML badge with unquoted attributes before Quickstart", () => {
    const source = actualRootReadme.replace(
      canonicalHeroCommandBlock,
      `<a href=https://example.com><img src=https://example.com/sixth.svg alt=Sixth></a>\n\n${canonicalHeroCommandBlock}`,
    )
    assertFailure(validateRootReadme(source, { canonical: true }), /exactly five approved badges/i)
  })

  for (const [name, source] of [
    [
      "missing hero navigation link",
      actualRootReadme.replace('  <a href="https://dawnai.org/docs">Documentation</a> ·\n', ""),
    ],
    [
      "extra hero navigation link",
      actualRootReadme.replace(
        '  <a href="https://dawnai.org/docs">Documentation</a> ·\n',
        '  <a href="https://dawnai.org/docs">Documentation</a> ·\n  <a href="https://example.com">Extra</a> ·\n',
      ),
    ],
  ]) {
    it(`rejects a ${name}`, () => {
      assertFailure(
        validateRootReadme(source, { canonical: true }),
        /exactly four canonical hero navigation links/i,
      )
    })
  }

  it("rejects a fifth hero navigation link in an adjacent first-scroll block", () => {
    const source = actualRootReadme.replace(
      canonicalHeroCommandBlock,
      `<p align="center"><a href="https://example.com">Fifth link</a></p>\n\n${canonicalHeroCommandBlock}`,
    )
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /exactly four canonical hero navigation links/i,
    )
  })

  it("rejects a fifth Markdown hero navigation link before Quickstart", () => {
    const source = actualRootReadme.replace(
      canonicalHeroCommandBlock,
      `[Fifth link](https://example.com)\n\n${canonicalHeroCommandBlock}`,
    )
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /exactly four canonical hero navigation links/i,
    )
  })

  it("rejects a fifth reference-style GFM navigation link before Quickstart", () => {
    const source = actualRootReadme
      .replace(
        canonicalHeroCommandBlock,
        `[Fifth link][fifth-link]\n\n${canonicalHeroCommandBlock}`,
      )
      .replace("## License", "[fifth-link]: https://example.com\n\n## License")
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /exactly four canonical hero navigation links/i,
    )
  })

  it("rejects a fifth GFM autolink before Quickstart", () => {
    const source = actualRootReadme.replace(
      canonicalHeroCommandBlock,
      `<https://example.com>\n\n${canonicalHeroCommandBlock}`,
    )
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /exactly four canonical hero navigation links/i,
    )
  })

  for (const [name, autolink] of [
    ["bare URL", "https://example.com"],
    ["bare www URL", "www.example.com"],
    ["bare email", "extra@example.com"],
    ["angle-bracket email autolink", "<extra@example.com>"],
  ]) {
    it(`rejects a fifth ${name} GFM link before Quickstart`, () => {
      const source = actualRootReadme.replace(
        canonicalHeroCommandBlock,
        `${autolink}\n\n${canonicalHeroCommandBlock}`,
      )
      assertFailure(
        validateRootReadme(source, { canonical: true }),
        /exactly four canonical hero navigation links/i,
      )
    })
  }

  it("does not count body-only GFM bare and angle-bracket autolinks", () => {
    const source = actualRootReadme.replace(
      "## Why Dawn",
      "## Why Dawn\n\nhttps://example.com\n\nwww.example.com\n\nextra@example.com\n\n<extra@example.com>",
    )
    assert.deepEqual(validateRootReadme(source, { canonical: true }), [])
  })

  for (const [name, hiddenLinks] of [
    [
      "fenced code",
      "```text\nhttps://example.com\nwww.example.com\nextra@example.com\n<extra@example.com>\n```",
    ],
    [
      "HTML comment",
      "<!-- https://example.com www.example.com extra@example.com <extra@example.com> -->",
    ],
    [
      "raw-text HTML",
      "<script>const links = 'https://example.com www.example.com extra@example.com <extra@example.com>'</script>",
    ],
  ]) {
    it(`does not count GFM autolinks inside ${name}`, () => {
      const source = actualRootReadme.replace(
        canonicalHeroCommandBlock,
        `${hiddenLinks}\n\n${canonicalHeroCommandBlock}`,
      )
      assert.deepEqual(validateRootReadme(source, { canonical: true }), [])
    })
  }

  it("does not count body-only reference-style GFM badges and links", () => {
    const source = actualRootReadme
      .replace(
        "## Why Dawn",
        "## Why Dawn\n\n[![Body badge][body-image]][body-link]\n\n[Body link][body-nav]",
      )
      .replace(
        "## License",
        "[body-image]: https://example.com/body.svg\n[body-link]: https://example.com/badge\n[body-nav]: https://example.com/nav\n\n## License",
      )
    assert.deepEqual(validateRootReadme(source, { canonical: true }), [])
  })

  it("requires the first scaffold command before the product-loop GIF", () => {
    const source = actualRootReadme
      .replace(`${canonicalHeroCommandBlock}\n\n`, "")
      .replace(
        "[Read the product-loop transcript]",
        `${canonicalHeroCommandBlock}\n\n[Read the product-loop transcript]`,
      )
    assertFailure(validateRootReadme(source, { canonical: true }), /before the product-loop GIF/i)
  })

  for (const [name, source] of [
    [
      "unlinked product-loop GIF",
      actualRootReadme.replace(
        canonicalProductLoopBlock,
        '<p align="center">\n  <img src="docs/brand/product-loop.gif" alt="Animation showing an existing generated research workspace, a deterministic test, and the Dawn Workbench" width="900">\n</p>',
      ),
    ],
    [
      "wrong product-loop anchor",
      actualRootReadme.replace("https://dawnai.org/#product-loop", "https://dawnai.org/docs"),
    ],
    [
      "wrong product-loop alt text",
      actualRootReadme.replace(
        "Animation showing an existing generated research workspace, a deterministic test, and the Dawn Workbench",
        "Dawn product loop",
      ),
    ],
  ]) {
    it(`rejects a ${name}`, () => {
      assertFailure(
        validateRootReadme(source, { canonical: true }),
        /linked product-loop GIF with canonical anchor and alt text/i,
      )
    })
  }

  it("requires the complete no-key Quickstart sequence", () => {
    const source = actualRootReadme.replace(
      "cd my-agent\nnpm install\nnpm test",
      "cd my-agent\nnpm install",
    )
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /complete no-key Quickstart sequence/i,
    )
  })

  it("requires the canonical transcript link in the actual README", () => {
    const source = actualRootReadme.replace(
      "[Read the product-loop transcript](docs/brand/demo/transcript.md).",
      "",
    )
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /canonical product-loop transcript link/i,
    )
  })

  it("requires a final scaffold CTA", () => {
    const source = actualRootReadme.replace(canonicalFinalCta, "Ready to start?")
    assertFailure(validateRootReadme(source, { canonical: true }), /final scaffold CTA/i)
  })

  it("requires the canonical License section", () => {
    const source = actualRootReadme.replace("## License\n\nMIT. See [LICENSE](./LICENSE).", "")
    assertFailure(validateRootReadme(source, { canonical: true }), /canonical License section/i)
  })

  it("requires canonical provider-specific credential guidance", () => {
    assertFailure(
      validateRootReadme(actualRootReadme.replace(canonicalQualifiedCredentials, ""), {
        canonical: true,
      }),
      /canonical provider-specific credential guidance/i,
    )
  })

  for (const universal of [
    "Every live model call needs an API key.",
    "All live model calls require credentials.",
    "Live provider runs always need credentials.",
  ]) {
    it(`rejects the universal credentials paraphrase ${JSON.stringify(universal)}`, () => {
      const source = actualRootReadme.replace(
        "## Run it live\n\n",
        `## Run it live\n\n${universal}\n\n`,
      )
      assertFailure(
        validateRootReadme(source, { canonical: true }),
        /not every live model call requires credentials/i,
      )
    })
  }

  it("does not reject explicit negation of the universal credentials claim", () => {
    const source = actualRootReadme.replace(
      "## Run it live\n\n",
      "## Run it live\n\nNot all live model calls require credentials.\n\n",
    )
    assert.deepEqual(validateRootReadme(source, { canonical: true }), [])
  })

  it("accepts a negated universal live-provider credentials claim", () => {
    const source = actualRootReadme.replace(
      "## Run it live\n\n",
      "## Run it live\n\nNot all live provider runs always need credentials.\n\n",
    )
    assert.deepEqual(validateRootReadme(source, { canonical: true }), [])
  })

  it("rejects an each-quantified singular credential claim", () => {
    const source = actualRootReadme.replace(
      "## Run it live\n\n",
      "## Run it live\n\nEach live model call requires a credential.\n\n",
    )
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /not every live model call requires credentials/i,
    )
  })

  for (const [name, literal] of [
    ["inline code", "`<!--`"],
    ["a fenced block", "```md\n<!--\n```"],
  ]) {
    it(`accepts an unmatched comment opener inside ${name} before root requirements`, () => {
      const source = rootReadme.replace("# Dawn\n", `# Dawn\n\n${literal}\n`)
      assert.deepEqual(validateRootReadme(source), [])
    })
  }

  it("accepts the product-loop GIF as an HTML image", () => {
    const htmlImage = rootReadme.replace(
      "![Dawn product loop](docs/brand/product-loop.gif)",
      '<img src="docs/brand/product-loop.gif" alt="Dawn product loop" />',
    )
    assert.deepEqual(validateRootReadme(htmlImage), [])
  })

  it("accepts the canonical scaffold command in a fenced shell example", () => {
    const fencedCommand = rootReadme.replace(
      "`npm create dawn-ai-app@latest my-agent`",
      "```bash\nnpm create dawn-ai-app@latest my-agent\n```",
    )
    assert.deepEqual(validateRootReadme(fencedCommand), [])
  })

  it("allows unrelated headings between required root sections", () => {
    assert.deepEqual(
      validateRootReadme(rootReadme.replace("## Why Dawn", "## Note\n\n## Why Dawn")),
      [],
    )
  })

  for (const heading of [
    "Quickstart",
    "Why Dawn",
    "How Dawn fits",
    "What Dawn writes for you",
    "What are you building?",
    "When Dawn fits",
    "Build with a coding agent",
    "Run it live",
    "Maturity and support",
  ]) {
    it(`requires the ${heading} heading`, () => {
      assertFailure(
        validateRootReadme(rootReadme.replace(`## ${heading}`, `## Other ${heading}`)),
        new RegExp(heading.replace(/[?]/g, "\\?"), "i"),
      )
    })
  }

  it("requires the headings in canonical order", () => {
    const outOfOrder = rootReadme
      .replace("## Quickstart", "## TEMP")
      .replace("## Why Dawn", "## Quickstart")
      .replace("## TEMP", "## Why Dawn")
    assertFailure(validateRootReadme(outOfOrder), /order/i)
  })

  it("reports order failures among present headings when another heading is missing", () => {
    const missingAndOutOfOrder = rootReadme
      .replace("## Why Dawn\n\n", "")
      .replace("## Quickstart", "## TEMP")
      .replace("## How Dawn fits", "## Quickstart")
      .replace("## TEMP", "## How Dawn fits")
    const failures = validateRootReadme(missingAndOutOfOrder)
    assertFailure(failures, /Why Dawn/)
    assertFailure(failures, /order/i)
  })

  it("ignores headings inside fenced code blocks when checking order", () => {
    const misleading = rootReadme
      .replace("## Quickstart\n", "")
      .replace("# Dawn\n", "# Dawn\n\n```md\n## Quickstart\n```\n")
    assertFailure(validateRootReadme(misleading), /Quickstart/)
  })

  it("ignores Markdown headings inside raw HTML blocks", () => {
    const misleading = rootReadme
      .replace("## Quickstart\n", "")
      .concat("\n\n<div>\n  ## Quickstart\n</div>")
    assertFailure(validateRootReadme(misleading), /Quickstart/)
  })

  it("ignores Markdown headings inside raw-text HTML blocks", () => {
    const misleading = rootReadme
      .replace("## Quickstart\n", "")
      .concat("\n\n<style>\n## Quickstart\n</style>")
    assertFailure(validateRootReadme(misleading), /Quickstart/)
  })

  it("requires exact H2 spelling for root section headings", () => {
    assertFailure(
      validateRootReadme(rootReadme.replace("## Quickstart", "### quickstart")),
      /Quickstart/,
    )
  })

  it("rejects duplicate required root headings", () => {
    assertFailure(
      validateRootReadme(rootReadme.replace("## Why Dawn", "## Quickstart\n\n## Why Dawn")),
      /Quickstart/,
    )
  })

  it("does not accept root assets and links hidden in fenced examples", () => {
    const hiddenReferences = rootReadme
      .replace("![Dawn product loop](docs/brand/product-loop.gif)", "")
      .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
      .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
      .concat(
        "\n\n```md\n![Loop](docs/brand/product-loop.gif)\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n```",
      )
    const failures = validateRootReadme(hiddenReferences)
    assertFailure(failures, /product-loop\.gif/)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  it("does not accept root references hidden in HTML comments", () => {
    const hiddenReferences = rootReadme
      .replace("![Dawn product loop](docs/brand/product-loop.gif)", "")
      .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
      .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
      .concat(
        "\n\n<!-- ![Loop](docs/brand/product-loop.gif) [Migration](/docs/migrating-from-langgraph) [Transcript](docs/brand/demo/transcript.md) -->",
      )
    const failures = validateRootReadme(hiddenReferences)
    assertFailure(failures, /product-loop\.gif/)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  for (const [name, reference, decoy, expected] of [
    [
      "migration",
      "[Migrate from LangGraph](/docs/migrating-from-langgraph)",
      "[Migration](/docs/migrating-from-langgraph)",
      /migrating-from-langgraph/,
    ],
    [
      "transcript",
      "[Read the demo transcript](docs/brand/demo/transcript.md)",
      "[Transcript](docs/brand/demo/transcript.md)",
      /transcript\.md/,
    ],
  ]) {
    it(`does not accept a Markdown ${name} link inside a raw HTML block`, () => {
      const source = rootReadme.replace(reference, "").concat(`\n\n<div>\n    ${decoy}\n</div>`)
      assertFailure(validateRootReadme(source), expected)
    })
  }

  for (const tag of ["script", "style", "textarea", "span"]) {
    it(`does not accept Markdown links inside a <${tag}> HTML block`, () => {
      const source = rootReadme
        .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
        .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
        .concat(
          `\n\n<${tag}>\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n</${tag}>`,
        )
      const failures = validateRootReadme(source)
      assertFailure(failures, /migrating-from-langgraph/)
      assertFailure(failures, /transcript\.md/)
    })
  }

  for (const [name, block] of [
    [
      "processing-instruction",
      "<?dawn\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n?>",
    ],
    [
      "declaration",
      "<!DECLARATION dawn\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n>",
    ],
    [
      "CDATA",
      "<![CDATA[\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n]]>",
    ],
    [
      "pre block containing a blank line",
      "<pre>\ncode\n\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n</pre>",
    ],
  ]) {
    it(`does not accept Markdown links inside a ${name}`, () => {
      const source = rootReadme
        .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
        .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
        .concat(`\n\n${block}`)
      const failures = validateRootReadme(source)
      assertFailure(failures, /migrating-from-langgraph/)
      assertFailure(failures, /transcript\.md/)
    })
  }

  it("does not accept root assets and links written as inline code", () => {
    const inlineReferences = rootReadme
      .replace(
        "![Dawn product loop](docs/brand/product-loop.gif)",
        "`![Dawn product loop](docs/brand/product-loop.gif)`",
      )
      .replace(
        "[Migrate from LangGraph](/docs/migrating-from-langgraph)",
        "`[Migrate from LangGraph](/docs/migrating-from-langgraph)`",
      )
      .replace(
        "[Read the demo transcript](docs/brand/demo/transcript.md)",
        "`[Read the demo transcript](docs/brand/demo/transcript.md)`",
      )
    const failures = validateRootReadme(inlineReferences)
    assertFailure(failures, /product-loop\.gif/)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  for (const [name, decoy] of [
    [
      "a list-nested fence",
      "- ```md\n  ## Quickstart\n  ![Loop](docs/brand/product-loop.gif)\n  [Migration](/docs/migrating-from-langgraph)\n  [Transcript](docs/brand/demo/transcript.md)\n  ```",
    ],
    [
      "indented code",
      "    ## Quickstart\n    ![Loop](docs/brand/product-loop.gif)\n    [Migration](/docs/migrating-from-langgraph)\n    [Transcript](docs/brand/demo/transcript.md)",
    ],
  ]) {
    it(`ignores root contract decoys inside ${name}`, () => {
      const source = rootReadme
        .replace("## Quickstart\n", "")
        .replace("![Dawn product loop](docs/brand/product-loop.gif)", "")
        .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
        .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
        .concat(`\n\n${decoy}`)
      const failures = validateRootReadme(source)
      assertFailure(failures, /Quickstart/)
      assertFailure(failures, /product-loop\.gif/)
      assertFailure(failures, /migrating-from-langgraph/)
      assertFailure(failures, /transcript\.md/)
    })
  }

  it("does not close a top-level fence on a list-prefixed fence marker", () => {
    const deceptiveClose = rootReadme
      .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
      .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
      .concat(
        "\n\n```md\n- ```\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n```",
      )
    const failures = validateRootReadme(deceptiveClose)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  for (const [name, prefix] of [
    ["tab-expanded indented code", " \t"],
    ["blockquote-contained indented code", ">     "],
  ]) {
    it(`ignores root links inside ${name}`, () => {
      const source = rootReadme
        .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
        .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
        .concat(
          `\n\n${prefix}[Migration](/docs/migrating-from-langgraph)\n${prefix}[Transcript](docs/brand/demo/transcript.md)`,
        )
      const failures = validateRootReadme(source)
      assertFailure(failures, /migrating-from-langgraph/)
      assertFailure(failures, /transcript\.md/)
    })
  }

  it("ignores links inside list-container indented code", () => {
    const source = rootReadme
      .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
      .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
      .concat(
        "\n\n-     [Migration](/docs/migrating-from-langgraph)\n1.     [Transcript](docs/brand/demo/transcript.md)",
      )
    const failures = validateRootReadme(source)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  it("ignores links inside tab-expanded list indented code", () => {
    const source = rootReadme
      .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
      .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
      .concat(
        "\n\n-\t  [Migration](/docs/migrating-from-langgraph)\n1.\t   [Transcript](docs/brand/demo/transcript.md)",
      )
    const failures = validateRootReadme(source)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  it("ends an unclosed list fence when the list container ends", () => {
    const source = rootReadme
      .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
      .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
      .concat(
        "\n\n- ```md\n  code\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)",
      )
    assert.deepEqual(validateRootReadme(source), [])
  })

  it("does not count a Markdown image as the required migration link", () => {
    const imageOnly = rootReadme.replace(
      "[Migrate from LangGraph](/docs/migrating-from-langgraph)",
      "![Migration diagram](/docs/migrating-from-langgraph)",
    )
    assertFailure(validateRootReadme(imageOnly), /migrating-from-langgraph/)
  })

  it("requires exact relative link destinations", () => {
    const prefixedLinks = rootReadme
      .replace("/docs/migrating-from-langgraph", "PREFIX/docs/migrating-from-langgraph")
      .replace("docs/brand/demo/transcript.md", "PREFIXdocs/brand/demo/transcript.md")
    const failures = validateRootReadme(prefixedLinks)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  it("accepts canonical absolute documentation links", () => {
    const absoluteLinks = rootReadme
      .replace("/docs/migrating-from-langgraph", "https://dawnai.org/docs/migrating-from-langgraph")
      .replace(
        "docs/brand/demo/transcript.md",
        "https://github.com/cacheplane/dawnai/blob/main/docs/brand/demo/transcript.md",
      )
    assert.deepEqual(validateRootReadme(absoluteLinks), [])
  })

  it("rejects arbitrary origins that copy canonical link paths", () => {
    const evilOrigins = rootReadme
      .replace(
        "/docs/migrating-from-langgraph",
        "https://evil.example/docs/migrating-from-langgraph",
      )
      .replace(
        "docs/brand/demo/transcript.md",
        "https://evil.example/docs/brand/demo/transcript.md",
      )
    const failures = validateRootReadme(evilOrigins)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  it("does not treat linked-image destinations as enclosing documentation links", () => {
    const linkedImages = rootReadme
      .replace(
        "[Migrate from LangGraph](/docs/migrating-from-langgraph)",
        "[![Migration](/docs/migrating-from-langgraph)](https://evil.example)",
      )
      .replace(
        "[Read the demo transcript](docs/brand/demo/transcript.md)",
        "[![Transcript](docs/brand/demo/transcript.md)](https://evil.example)",
      )
    const failures = validateRootReadme(linkedImages)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  it("does not treat outer destinations of nested ordinary links as rendered links", () => {
    const nestedLinks = rootReadme
      .replace(
        "[Migrate from LangGraph](/docs/migrating-from-langgraph)",
        "[Outer [inner](https://evil.example)](/docs/migrating-from-langgraph)",
      )
      .replace(
        "[Read the demo transcript](docs/brand/demo/transcript.md)",
        "[Outer [inner](https://evil.example)](docs/brand/demo/transcript.md)",
      )
    const failures = validateRootReadme(nestedLinks)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  for (const [name, migration, transcript] of [
    [
      "escaped link openers",
      "\\[Migration](/docs/migrating-from-langgraph)",
      "\\[Transcript](docs/brand/demo/transcript.md)",
    ],
    [
      "garbage after angle-bracket destinations",
      "[Migration](</docs/migrating-from-langgraph>evil)",
      "[Transcript](<docs/brand/demo/transcript.md>evil)",
    ],
    [
      "unquoted garbage after destinations",
      "[Migration](/docs/migrating-from-langgraph nope)",
      "[Transcript](docs/brand/demo/transcript.md nope)",
    ],
    [
      "titles without separating whitespace",
      '[Migration](</docs/migrating-from-langgraph>"title")',
      '[Transcript](<docs/brand/demo/transcript.md>"title")',
    ],
  ]) {
    it(`rejects ${name} as documentation links`, () => {
      const source = rootReadme
        .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", migration)
        .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", transcript)
      const failures = validateRootReadme(source)
      assertFailure(failures, /migrating-from-langgraph/)
      assertFailure(failures, /transcript\.md/)
    })
  }

  it("accepts real links after escaped image markers", () => {
    const escapedImageMarkers = rootReadme
      .replace(
        "[Migrate from LangGraph](/docs/migrating-from-langgraph)",
        "\\![Migration](/docs/migrating-from-langgraph)",
      )
      .replace(
        "[Read the demo transcript](docs/brand/demo/transcript.md)",
        "\\![Transcript](docs/brand/demo/transcript.md)",
      )
    assert.deepEqual(validateRootReadme(escapedImageMarkers), [])
  })

  it("requires a boundary after the canonical scaffold command", () => {
    assertFailure(
      validateRootReadme(
        rootReadme.replace(
          "npm create dawn-ai-app@latest my-agent",
          "npm create dawn-ai-app@latest my-agent-extra",
        ),
      ),
      /npm create dawn-ai-app@latest my-agent/,
    )
  })

  for (const [name, source, expected] of [
    [
      "canonical scaffold command",
      rootReadme.replace(
        "npm create dawn-ai-app@latest my-agent",
        "pnpm create dawn-ai-app my-app",
      ),
      /npm create dawn-ai-app@latest my-agent/,
    ],
    [
      "product-loop GIF",
      rootReadme.replace("docs/brand/product-loop.gif", "docs/brand/quickstart.gif"),
      /docs\/brand\/product-loop\.gif/,
    ],
    [
      "migration link",
      rootReadme.replace("/docs/migrating-from-langgraph", "/docs/getting-started"),
      /migrating-from-langgraph/,
    ],
    [
      "transcript link",
      rootReadme.replace("docs/brand/demo/transcript.md", "docs/brand/demo/notes.md"),
      /docs\/brand\/demo\/transcript\.md/,
    ],
  ]) {
    it(`requires the ${name}`, () => {
      assertFailure(validateRootReadme(source), expected)
    })
  }

  it("rejects the retired quickstart GIF caption", () => {
    assertFailure(
      validateRootReadme(
        `${rootReadme}\n\nDawn quickstart — scaffold a route and invoke it in under a minute`,
      ),
      /old GIF caption/i,
    )
  })
})

describe("resolvePublicPackageTiers", () => {
  const entry = ["create-dawn-ai-app", "@dawn-ai/sdk", "@dawn-ai/cli"]
  const capability = [
    "@dawn-ai/ag-ui",
    "@dawn-ai/evals",
    "@dawn-ai/inspector",
    "@dawn-ai/memory",
    "@dawn-ai/memory-pgvector",
    "@dawn-ai/permissions",
    "@dawn-ai/postgres-storage",
    "@dawn-ai/sandbox",
    "@dawn-ai/sqlite-storage",
    "@dawn-ai/testing",
    "@dawn-ai/workspace",
  ]
  const tooling = [
    "@dawn-ai/core",
    "@dawn-ai/langchain",
    "@dawn-ai/langgraph",
    "@dawn-ai/vite-plugin",
    "@dawn-ai/devkit",
    "@dawn-ai/config-biome",
    "@dawn-ai/config-typescript",
  ]
  const publicPackages = [...entry, ...capability, ...tooling]

  it("accepts disjoint package tier definitions", () => {
    assert.doesNotThrow(() =>
      assertDisjointPackageTiers({
        entry: ["entry-package"],
        capability: ["capability-package"],
        tooling: ["tooling-package"],
      }),
    )
  })

  it("rejects a package classified in multiple tiers", () => {
    assert.throws(
      () =>
        assertDisjointPackageTiers({
          entry: ["shared-package"],
          capability: ["shared-package"],
          tooling: [],
        }),
      /Multiple classifications.*shared-package/,
    )
  })

  it("classifies the complete public release inventory", () => {
    assert.deepEqual(
      resolvePublicPackageTiers(publicPackages),
      Object.fromEntries([
        ...entry.map((name) => [name, "entry"]),
        ...capability.map((name) => [name, "capability"]),
        ...tooling.map((name) => [name, "tooling"]),
      ]),
    )
  })

  it("rejects unknown public packages", () => {
    assert.throws(
      () => resolvePublicPackageTiers([...publicPackages, "@dawn-ai/unknown"]),
      /Unknown public package.*@dawn-ai\/unknown/,
    )
  })

  it("rejects duplicate public packages", () => {
    assert.throws(
      () => resolvePublicPackageTiers([...publicPackages, "@dawn-ai/sdk"]),
      /Duplicate public package.*@dawn-ai\/sdk/,
    )
  })

  it("rejects an incomplete public release inventory", () => {
    assert.throws(
      () => resolvePublicPackageTiers(publicPackages.filter((name) => name !== "@dawn-ai/sdk")),
      /Missing known public package.*@dawn-ai\/sdk/,
    )
  })

  it("does not let caller-supplied tiers disguise an unknown package", () => {
    const alteredDefinitions = {
      entry: [...entry, "@dawn-ai/unknown"],
      capability,
      tooling,
    }
    assert.throws(
      () => resolvePublicPackageTiers([...publicPackages, "@dawn-ai/unknown"], alteredDefinitions),
      /Unknown public package.*@dawn-ai\/unknown/,
    )
  })

  it("does not let caller-supplied tiers swap known package classifications", () => {
    const swappedDefinitions = {
      entry: entry.map((name) => (name === "@dawn-ai/sdk" ? "@dawn-ai/core" : name)),
      capability,
      tooling: tooling.map((name) => (name === "@dawn-ai/core" ? "@dawn-ai/sdk" : name)),
    }
    const tiers = resolvePublicPackageTiers(publicPackages, swappedDefinitions)
    assert.equal(tiers["@dawn-ai/sdk"], "entry")
    assert.equal(tiers["@dawn-ai/core"], "tooling")
  })
})
