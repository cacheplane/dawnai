import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	resolvePublicPackageTiers,
	validatePackageDiscoveryMetadata,
	validatePackageReadme,
	validateRootReadme,
} from "./lib/readme-contracts.mjs";

const entryManifest = {
	name: "@dawn-ai/sdk",
	private: false,
	description: "Author-facing TypeScript SDK for defining Dawn agents.",
	keywords: ["dawn", "typescript", "langgraph"],
};

const entryReadme = `# @dawn-ai/sdk

Author-facing TypeScript SDK.

**Use this when:** You are authoring a Dawn route.

## Install

## Example

## Runtime and stability

## Related

## Maturity and support

## License

![Dawn product loop](https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif)`;

const rootReadme = `# Dawn

## Quickstart

\`pnpm create dawn-ai-app my-app\`

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

## Maturity and support`;

function assertFailure(failures, expected) {
	assert.ok(
		failures.some((failure) => expected.test(failure)),
		`Expected a failure matching ${expected}, received:\n${failures.join("\n")}`,
	);
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
		);
	});

	for (const [name, source, expected] of [
		[
			"Use this when guidance",
			entryReadme.replace(
				"**Use this when:** You are authoring a Dawn route.\n\n",
				"",
			),
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
		[
			"related links",
			entryReadme.replace("## Related", "## Elsewhere"),
			/Related/,
		],
		[
			"maturity guidance",
			entryReadme.replace("## Maturity and support", "## Status"),
			/Maturity and support/,
		],
		[
			"license heading",
			entryReadme.replace("## License", "## Legal"),
			/License/,
		],
		[
			"entry-tier product-loop image",
			entryReadme.replace(
				"docs/brand/product-loop.gif",
				"docs/brand/other.gif",
			),
			/product-loop\.gif/,
		],
		[
			"package-name H1",
			entryReadme.replace("# @dawn-ai/sdk", "# Dawn SDK"),
			/H1.*@dawn-ai\/sdk/i,
		],
		[
			"purpose statement",
			entryReadme.replace("Author-facing TypeScript SDK.\n\n", ""),
			/purpose/i,
		],
	]) {
		it(`rejects a README missing its ${name}`, () => {
			assertFailure(
				validatePackageReadme({
					tier: "entry",
					manifest: entryManifest,
					readme: source,
				}),
				expected,
			);
		});
	}

	it("does not accept a package H1 hidden in a fenced code block", () => {
		const readme = entryReadme.replace(
			"# @dawn-ai/sdk",
			"```md\n# @dawn-ai/sdk\n```\n\n# Different package",
		);
		assertFailure(
			validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
			/H1.*@dawn-ai\/sdk/i,
		);
	});

	it("does not accept an entry image hidden in a fenced code block", () => {
		const readme = entryReadme.replace(
			"![Dawn product loop](https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif)",
			"```md\n![Dawn product loop](docs/brand/product-loop.gif)\n```",
		);
		assertFailure(
			validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
			/product-loop\.gif/,
		);
	});

	it("does not accept an entry image written as inline code", () => {
		const readme = entryReadme.replace(
			"![Dawn product loop](https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif)",
			"`![Dawn product loop](docs/brand/product-loop.gif)`",
		);
		assertFailure(
			validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
			/product-loop\.gif/,
		);
	});

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
			const readme = entryReadme.replace(
				"Author-facing TypeScript SDK.",
				structuralLine,
			);
			assertFailure(
				validatePackageReadme({
					tier: "entry",
					manifest: entryManifest,
					readme,
				}),
				/purpose/i,
			);
		});
	}

	it("requires examples for capability packages", () => {
		const failures = validatePackageReadme({
			tier: "capability",
			manifest: { ...entryManifest, name: "@dawn-ai/memory" },
			readme: entryReadme
				.replaceAll("@dawn-ai/sdk", "@dawn-ai/memory")
				.replace("## Example", "## Configuration"),
		});
		assertFailure(failures, /Example/);
	});

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
		);
	});

	it("rejects unknown package tiers", () => {
		assert.throws(
			() =>
				validatePackageReadme({
					tier: "unknown",
					manifest: entryManifest,
					readme: entryReadme,
				}),
			/Unknown README tier/,
		);
	});
});

describe("validatePackageDiscoveryMetadata", () => {
	it("accepts a trimmed 30-180 character description and 3-8 discovery keywords", () => {
		assert.deepEqual(validatePackageDiscoveryMetadata(entryManifest), []);
		assert.deepEqual(
			validatePackageDiscoveryMetadata({
				...entryManifest,
				description: "x".repeat(30),
				keywords: Array.from({ length: 8 }, (_, index) => `keyword-${index}`),
			}),
			[],
		);
		assert.deepEqual(
			validatePackageDiscoveryMetadata({
				...entryManifest,
				description: "x".repeat(180),
			}),
			[],
		);
	});

	for (const [name, patch, expected] of [
		[
			"missing description",
			{ description: undefined },
			/description.*30.*180/i,
		],
		[
			"untrimmed description",
			{ description: ` ${"x".repeat(30)}` },
			/description.*trimmed/i,
		],
		[
			"short description",
			{ description: "Too short" },
			/description.*30.*180/i,
		],
		[
			"long description",
			{ description: "x".repeat(181) },
			/description.*30.*180/i,
		],
		["empty keywords", { keywords: [] }, /keywords.*3.*8/i],
		[
			"too few keywords",
			{ keywords: ["dawn", "typescript"] },
			/keywords.*3.*8/i,
		],
		[
			"too many keywords",
			{ keywords: Array.from({ length: 9 }, (_, index) => `keyword-${index}`) },
			/keywords.*3.*8/i,
		],
		[
			"duplicate keywords",
			{ keywords: ["dawn", "dawn", "typescript"] },
			/unique/i,
		],
		[
			"uppercase keywords",
			{ keywords: ["Dawn", "typescript", "langgraph"] },
			/lowercase/i,
		],
		[
			"invalid keywords",
			{ keywords: ["dawn", "type_script", "langgraph"] },
			/lowercase/i,
		],
		[
			"empty keyword values",
			{ keywords: ["dawn", "", "langgraph"] },
			/lowercase/i,
		],
	]) {
		it(`rejects ${name}`, () => {
			assertFailure(
				validatePackageDiscoveryMetadata({ ...entryManifest, ...patch }),
				expected,
			);
		});
	}

	it("includes discovery metadata failures in the package README contract", () => {
		assertFailure(
			validatePackageReadme({
				tier: "entry",
				manifest: { ...entryManifest, description: "Too short" },
				readme: entryReadme,
			}),
			/description.*30.*180/i,
		);
	});
});

describe("validateRootReadme", () => {
	it("accepts the required root README structure and references", () => {
		assert.deepEqual(validateRootReadme(rootReadme), []);
	});

	it("accepts the product-loop GIF as an HTML image", () => {
		const htmlImage = rootReadme.replace(
			"![Dawn product loop](docs/brand/product-loop.gif)",
			'<img src="docs/brand/product-loop.gif" alt="Dawn product loop" />',
		);
		assert.deepEqual(validateRootReadme(htmlImage), []);
	});

	it("accepts the canonical scaffold command in a fenced shell example", () => {
		const fencedCommand = rootReadme.replace(
			"`pnpm create dawn-ai-app my-app`",
			"```bash\npnpm create dawn-ai-app my-app\n```",
		);
		assert.deepEqual(validateRootReadme(fencedCommand), []);
	});

	it("allows unrelated headings between required root sections", () => {
		assert.deepEqual(
			validateRootReadme(
				rootReadme.replace("## Why Dawn", "## Note\n\n## Why Dawn"),
			),
			[],
		);
	});

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
				validateRootReadme(
					rootReadme.replace(`## ${heading}`, `## Other ${heading}`),
				),
				new RegExp(heading.replace(/[?]/g, "\\?"), "i"),
			);
		});
	}

	it("requires the headings in canonical order", () => {
		const outOfOrder = rootReadme
			.replace("## Quickstart", "## TEMP")
			.replace("## Why Dawn", "## Quickstart")
			.replace("## TEMP", "## Why Dawn");
		assertFailure(validateRootReadme(outOfOrder), /order/i);
	});

	it("ignores headings inside fenced code blocks when checking order", () => {
		const misleading = rootReadme
			.replace("## Quickstart\n", "")
			.replace("# Dawn\n", "# Dawn\n\n```md\n## Quickstart\n```\n");
		assertFailure(validateRootReadme(misleading), /Quickstart/);
	});

	it("requires exact H2 spelling for root section headings", () => {
		assertFailure(
			validateRootReadme(rootReadme.replace("## Quickstart", "### quickstart")),
			/Quickstart/,
		);
	});

	it("rejects duplicate required root headings", () => {
		assertFailure(
			validateRootReadme(
				rootReadme.replace("## Why Dawn", "## Quickstart\n\n## Why Dawn"),
			),
			/Quickstart/,
		);
	});

	it("does not accept root assets and links hidden in fenced examples", () => {
		const hiddenReferences = rootReadme
			.replace("![Dawn product loop](docs/brand/product-loop.gif)", "")
			.replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
			.replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
			.concat(
				"\n\n```md\n![Loop](docs/brand/product-loop.gif)\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n```",
			);
		const failures = validateRootReadme(hiddenReferences);
		assertFailure(failures, /product-loop\.gif/);
		assertFailure(failures, /migrating-from-langgraph/);
		assertFailure(failures, /transcript\.md/);
	});

	it("does not accept root references hidden in HTML comments", () => {
		const hiddenReferences = rootReadme
			.replace("![Dawn product loop](docs/brand/product-loop.gif)", "")
			.replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
			.replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
			.concat(
				"\n\n<!-- ![Loop](docs/brand/product-loop.gif) [Migration](/docs/migrating-from-langgraph) [Transcript](docs/brand/demo/transcript.md) -->",
			);
		const failures = validateRootReadme(hiddenReferences);
		assertFailure(failures, /product-loop\.gif/);
		assertFailure(failures, /migrating-from-langgraph/);
		assertFailure(failures, /transcript\.md/);
	});

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
			);
		const failures = validateRootReadme(inlineReferences);
		assertFailure(failures, /product-loop\.gif/);
		assertFailure(failures, /migrating-from-langgraph/);
		assertFailure(failures, /transcript\.md/);
	});

	it("does not count a Markdown image as the required migration link", () => {
		const imageOnly = rootReadme.replace(
			"[Migrate from LangGraph](/docs/migrating-from-langgraph)",
			"![Migration diagram](/docs/migrating-from-langgraph)",
		);
		assertFailure(validateRootReadme(imageOnly), /migrating-from-langgraph/);
	});

	it("requires exact relative link destinations", () => {
		const prefixedLinks = rootReadme
			.replace(
				"/docs/migrating-from-langgraph",
				"PREFIX/docs/migrating-from-langgraph",
			)
			.replace(
				"docs/brand/demo/transcript.md",
				"PREFIXdocs/brand/demo/transcript.md",
			);
		const failures = validateRootReadme(prefixedLinks);
		assertFailure(failures, /migrating-from-langgraph/);
		assertFailure(failures, /transcript\.md/);
	});

	it("accepts canonical absolute documentation links", () => {
		const absoluteLinks = rootReadme
			.replace(
				"/docs/migrating-from-langgraph",
				"https://dawnai.org/docs/migrating-from-langgraph",
			)
			.replace(
				"docs/brand/demo/transcript.md",
				"https://github.com/cacheplane/dawnai/blob/main/docs/brand/demo/transcript.md",
			);
		assert.deepEqual(validateRootReadme(absoluteLinks), []);
	});

	it("requires a boundary after the canonical scaffold command", () => {
		assertFailure(
			validateRootReadme(
				rootReadme.replace(
					"pnpm create dawn-ai-app my-app",
					"pnpm create dawn-ai-app my-app-extra",
				),
			),
			/pnpm create dawn-ai-app my-app/,
		);
	});

	for (const [name, source, expected] of [
		[
			"canonical scaffold command",
			rootReadme.replace(
				"pnpm create dawn-ai-app my-app",
				"npm create dawn-ai-app@latest my-app",
			),
			/pnpm create dawn-ai-app my-app/,
		],
		[
			"product-loop GIF",
			rootReadme.replace(
				"docs/brand/product-loop.gif",
				"docs/brand/quickstart.gif",
			),
			/docs\/brand\/product-loop\.gif/,
		],
		[
			"migration link",
			rootReadme.replace(
				"/docs/migrating-from-langgraph",
				"/docs/getting-started",
			),
			/migrating-from-langgraph/,
		],
		[
			"transcript link",
			rootReadme.replace(
				"docs/brand/demo/transcript.md",
				"docs/brand/demo/notes.md",
			),
			/docs\/brand\/demo\/transcript\.md/,
		],
	]) {
		it(`requires the ${name}`, () => {
			assertFailure(validateRootReadme(source), expected);
		});
	}

	it("rejects the retired quickstart GIF caption", () => {
		assertFailure(
			validateRootReadme(
				`${rootReadme}\n\nDawn quickstart — scaffold a route and invoke it in under a minute`,
			),
			/old GIF caption/i,
		);
	});
});

describe("resolvePublicPackageTiers", () => {
	const entry = ["create-dawn-ai-app", "@dawn-ai/sdk", "@dawn-ai/cli"];
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
	];
	const tooling = [
		"@dawn-ai/core",
		"@dawn-ai/langchain",
		"@dawn-ai/langgraph",
		"@dawn-ai/vite-plugin",
		"@dawn-ai/devkit",
		"@dawn-ai/config-biome",
		"@dawn-ai/config-typescript",
	];
	const publicPackages = [...entry, ...capability, ...tooling];

	it("classifies the complete public release inventory", () => {
		assert.deepEqual(
			resolvePublicPackageTiers(publicPackages),
			Object.fromEntries([
				...entry.map((name) => [name, "entry"]),
				...capability.map((name) => [name, "capability"]),
				...tooling.map((name) => [name, "tooling"]),
			]),
		);
	});

	it("rejects unknown public packages", () => {
		assert.throws(
			() => resolvePublicPackageTiers([...publicPackages, "@dawn-ai/unknown"]),
			/Unknown public package.*@dawn-ai\/unknown/,
		);
	});

	it("rejects duplicate public packages", () => {
		assert.throws(
			() => resolvePublicPackageTiers([...publicPackages, "@dawn-ai/sdk"]),
			/Duplicate public package.*@dawn-ai\/sdk/,
		);
	});

	it("rejects an incomplete public release inventory", () => {
		assert.throws(
			() =>
				resolvePublicPackageTiers(
					publicPackages.filter((name) => name !== "@dawn-ai/sdk"),
				),
			/Missing known public package.*@dawn-ai\/sdk/,
		);
	});

	it("rejects package tier definitions with multiple classifications", () => {
		const overlappingDefinitions = {
			entry,
			capability: [...capability, "@dawn-ai/sdk"],
			tooling,
		};
		assert.throws(
			() => resolvePublicPackageTiers(publicPackages, overlappingDefinitions),
			/Multiple classifications.*@dawn-ai\/sdk/,
		);
	});
});
