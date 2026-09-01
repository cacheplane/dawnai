import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	assertDisjointPackageTiers,
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

	it("accepts the planned raw HTML product-loop thumbnail", () => {
		const readme = entryReadme.replace(
			"![Dawn product loop](https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif)",
			`<p align="center">
  <a href="https://dawnai.org/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif" alt="Dawn product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>`,
		);
		assert.deepEqual(
			validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
			[],
		);
	});

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
			);
		assert.deepEqual(
			validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
			[],
		);
	});

	for (const [name, literal] of [
		["inline code", "`<!--`"],
		["a fenced block", "```md\n<!--\n```"],
	]) {
		it(`accepts an unmatched comment opener inside ${name} before package requirements`, () => {
			const readme = entryReadme.replace(
				"Author-facing TypeScript SDK.\n",
				`Author-facing TypeScript SDK.\n\n${literal}\n`,
			);
			assert.deepEqual(
				validatePackageReadme({
					tier: "entry",
					manifest: entryManifest,
					readme,
				}),
				[],
			);
		});
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
			);
		assert.deepEqual(
			validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
			[],
		);
	});

	it("does not accept Markdown image syntax inside a raw HTML block", () => {
		const readme = entryReadme.replace(
			/!\[Dawn product loop\].*$/u,
			"<p>\n    ![Loop](docs/brand/product-loop.gif)\n</p>",
		);
		assertFailure(
			validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
			/product-loop\.gif/,
		);
	});

	it("accepts visible purpose prose inside a raw HTML block", () => {
		const readme = entryReadme.replace(
			"Author-facing TypeScript SDK.",
			"<div>\nAuthor-facing TypeScript SDK.\n</div>",
		);
		assert.deepEqual(
			validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
			[],
		);
	});

	for (const tag of ["script", "style", "textarea"]) {
		it(`does not accept a Markdown image inside a <${tag}> raw-text block`, () => {
			const readme = entryReadme.replace(
				/!\[Dawn product loop\].*$/u,
				`<${tag}>\n![Loop](docs/brand/product-loop.gif)\n</${tag}>`,
			);
			assertFailure(
				validatePackageReadme({
					tier: "entry",
					manifest: entryManifest,
					readme,
				}),
				/product-loop\.gif/,
			);
		});
	}

	it("does not accept a Markdown image inside a generic HTML block", () => {
		const readme = entryReadme.replace(
			/!\[Dawn product loop\].*$/u,
			"<span>\n![Loop](docs/brand/product-loop.gif)\n</span>",
		);
		assertFailure(
			validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
			/product-loop\.gif/,
		);
	});

	it("does not accept an HTML image inside a raw-text block", () => {
		const readme = entryReadme.replace(
			/!\[Dawn product loop\].*$/u,
			'<script>\n<img src="docs/brand/product-loop.gif" alt="Decoy">\n</script>',
		);
		assertFailure(
			validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
			/product-loop\.gif/,
		);
	});

	it("accepts an HTML image inside a rendered generic HTML block", () => {
		const readme = entryReadme.replace(
			/!\[Dawn product loop\].*$/u,
			'<span>\n<img src="docs/brand/product-loop.gif" alt="Dawn product loop">\n</span>',
		);
		assert.deepEqual(
			validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
			[],
		);
	});

	it("does not count raw-text block content as purpose prose", () => {
		const readme = entryReadme.replace(
			"Author-facing TypeScript SDK.",
			"<textarea>\nAuthor-facing TypeScript SDK.\n</textarea>",
		);
		assertFailure(
			validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
			/purpose statement/,
		);
	});

	for (const tag of ["script", "style", "textarea"]) {
		it(`does not accept an HTML image nested in <div><${tag}>`, () => {
			const readme = entryReadme.replace(
				/!\[Dawn product loop\].*$/u,
				`<div>\n<${tag}>\n<img src="docs/brand/product-loop.gif" alt="Decoy">\n</${tag}>\n</div>`,
			);
			assertFailure(
				validatePackageReadme({
					tier: "entry",
					manifest: entryManifest,
					readme,
				}),
				/product-loop\.gif/,
			);
		});

		it(`does not count purpose prose nested in <div><${tag}>`, () => {
			const readme = entryReadme.replace(
				"Author-facing TypeScript SDK.",
				`<div>\n<${tag}>\nAuthor-facing TypeScript SDK.\n</${tag}>\n</div>`,
			);
			assertFailure(
				validatePackageReadme({
					tier: "entry",
					manifest: entryManifest,
					readme,
				}),
				/purpose statement/,
			);
		});
	}

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

	it("ignores package contract decoys inside a list-nested fence", () => {
		const readme = entryReadme
			.replace("# @dawn-ai/sdk\n\n", "")
			.replace(/!\[Dawn product loop\].*$/u, "")
			.concat(
				"\n- ```md\n  # @dawn-ai/sdk\n  ![Loop](docs/brand/product-loop.gif)\n  ```",
			);
		const failures = validatePackageReadme({
			tier: "entry",
			manifest: entryManifest,
			readme,
		});
		assertFailure(failures, /H1.*@dawn-ai\/sdk/i);
		assertFailure(failures, /product-loop\.gif/);
	});

	it("ignores package contract decoys inside a three-space-indented fence", () => {
		const readme = entryReadme
			.replace("# @dawn-ai/sdk\n\n", "")
			.replace(/!\[Dawn product loop\].*$/u, "")
			.concat(
				"\n   ```md\n# @dawn-ai/sdk\n![Loop](docs/brand/product-loop.gif)\n   ```",
			);
		const failures = validatePackageReadme({
			tier: "entry",
			manifest: entryManifest,
			readme,
		});
		assertFailure(failures, /H1.*@dawn-ai\/sdk/i);
		assertFailure(failures, /product-loop\.gif/);
	});

	it("ignores package contract decoys inside indented code", () => {
		const readme = entryReadme
			.replace("# @dawn-ai/sdk\n\n", "")
			.replace(/!\[Dawn product loop\].*$/u, "")
			.concat("\n    # @dawn-ai/sdk\n    ![Loop](docs/brand/product-loop.gif)");
		const failures = validatePackageReadme({
			tier: "entry",
			manifest: entryManifest,
			readme,
		});
		assertFailure(failures, /H1.*@dawn-ai\/sdk/i);
		assertFailure(failures, /product-loop\.gif/);
	});

	it("does not accept an HTML product-loop image inside indented code", () => {
		const readme = entryReadme.replace(
			/!\[Dawn product loop\].*$/u,
			'    <img src="docs/brand/product-loop.gif" alt="Decoy">',
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

	for (const [name, literal] of [
		["inline code", "`<!--`"],
		["a fenced block", "```md\n<!--\n```"],
	]) {
		it(`accepts an unmatched comment opener inside ${name} before root requirements`, () => {
			const source = rootReadme.replace("# Dawn\n", `# Dawn\n\n${literal}\n`);
			assert.deepEqual(validateRootReadme(source), []);
		});
	}

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

	it("reports order failures among present headings when another heading is missing", () => {
		const missingAndOutOfOrder = rootReadme
			.replace("## Why Dawn\n\n", "")
			.replace("## Quickstart", "## TEMP")
			.replace("## How Dawn fits", "## Quickstart")
			.replace("## TEMP", "## How Dawn fits");
		const failures = validateRootReadme(missingAndOutOfOrder);
		assertFailure(failures, /Why Dawn/);
		assertFailure(failures, /order/i);
	});

	it("ignores headings inside fenced code blocks when checking order", () => {
		const misleading = rootReadme
			.replace("## Quickstart\n", "")
			.replace("# Dawn\n", "# Dawn\n\n```md\n## Quickstart\n```\n");
		assertFailure(validateRootReadme(misleading), /Quickstart/);
	});

	it("ignores Markdown headings inside raw HTML blocks", () => {
		const misleading = rootReadme
			.replace("## Quickstart\n", "")
			.concat("\n\n<div>\n  ## Quickstart\n</div>");
		assertFailure(validateRootReadme(misleading), /Quickstart/);
	});

	it("ignores Markdown headings inside raw-text HTML blocks", () => {
		const misleading = rootReadme
			.replace("## Quickstart\n", "")
			.concat("\n\n<style>\n## Quickstart\n</style>");
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
			const source = rootReadme
				.replace(reference, "")
				.concat(`\n\n<div>\n    ${decoy}\n</div>`);
			assertFailure(validateRootReadme(source), expected);
		});
	}

	for (const tag of ["script", "style", "textarea", "span"]) {
		it(`does not accept Markdown links inside a <${tag}> HTML block`, () => {
			const source = rootReadme
				.replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
				.replace(
					"[Read the demo transcript](docs/brand/demo/transcript.md)",
					"",
				)
				.concat(
					`\n\n<${tag}>\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n</${tag}>`,
				);
			const failures = validateRootReadme(source);
			assertFailure(failures, /migrating-from-langgraph/);
			assertFailure(failures, /transcript\.md/);
		});
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
				.replace(
					"[Read the demo transcript](docs/brand/demo/transcript.md)",
					"",
				)
				.concat(`\n\n${block}`);
			const failures = validateRootReadme(source);
			assertFailure(failures, /migrating-from-langgraph/);
			assertFailure(failures, /transcript\.md/);
		});
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
			);
		const failures = validateRootReadme(inlineReferences);
		assertFailure(failures, /product-loop\.gif/);
		assertFailure(failures, /migrating-from-langgraph/);
		assertFailure(failures, /transcript\.md/);
	});

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
				.replace(
					"[Read the demo transcript](docs/brand/demo/transcript.md)",
					"",
				)
				.concat(`\n\n${decoy}`);
			const failures = validateRootReadme(source);
			assertFailure(failures, /Quickstart/);
			assertFailure(failures, /product-loop\.gif/);
			assertFailure(failures, /migrating-from-langgraph/);
			assertFailure(failures, /transcript\.md/);
		});
	}

	it("does not close a top-level fence on a list-prefixed fence marker", () => {
		const deceptiveClose = rootReadme
			.replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
			.replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
			.concat(
				"\n\n```md\n- ```\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n```",
			);
		const failures = validateRootReadme(deceptiveClose);
		assertFailure(failures, /migrating-from-langgraph/);
		assertFailure(failures, /transcript\.md/);
	});

	for (const [name, prefix] of [
		["tab-expanded indented code", " \t"],
		["blockquote-contained indented code", ">     "],
	]) {
		it(`ignores root links inside ${name}`, () => {
			const source = rootReadme
				.replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
				.replace(
					"[Read the demo transcript](docs/brand/demo/transcript.md)",
					"",
				)
				.concat(
					`\n\n${prefix}[Migration](/docs/migrating-from-langgraph)\n${prefix}[Transcript](docs/brand/demo/transcript.md)`,
				);
			const failures = validateRootReadme(source);
			assertFailure(failures, /migrating-from-langgraph/);
			assertFailure(failures, /transcript\.md/);
		});
	}

	it("ignores links inside list-container indented code", () => {
		const source = rootReadme
			.replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
			.replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
			.concat(
				"\n\n-     [Migration](/docs/migrating-from-langgraph)\n1.     [Transcript](docs/brand/demo/transcript.md)",
			);
		const failures = validateRootReadme(source);
		assertFailure(failures, /migrating-from-langgraph/);
		assertFailure(failures, /transcript\.md/);
	});

	it("ignores links inside tab-expanded list indented code", () => {
		const source = rootReadme
			.replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
			.replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
			.concat(
				"\n\n-\t  [Migration](/docs/migrating-from-langgraph)\n1.\t   [Transcript](docs/brand/demo/transcript.md)",
			);
		const failures = validateRootReadme(source);
		assertFailure(failures, /migrating-from-langgraph/);
		assertFailure(failures, /transcript\.md/);
	});

	it("ends an unclosed list fence when the list container ends", () => {
		const source = rootReadme
			.replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
			.replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
			.concat(
				"\n\n- ```md\n  code\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)",
			);
		assert.deepEqual(validateRootReadme(source), []);
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

	it("rejects arbitrary origins that copy canonical link paths", () => {
		const evilOrigins = rootReadme
			.replace(
				"/docs/migrating-from-langgraph",
				"https://evil.example/docs/migrating-from-langgraph",
			)
			.replace(
				"docs/brand/demo/transcript.md",
				"https://evil.example/docs/brand/demo/transcript.md",
			);
		const failures = validateRootReadme(evilOrigins);
		assertFailure(failures, /migrating-from-langgraph/);
		assertFailure(failures, /transcript\.md/);
	});

	it("does not treat linked-image destinations as enclosing documentation links", () => {
		const linkedImages = rootReadme
			.replace(
				"[Migrate from LangGraph](/docs/migrating-from-langgraph)",
				"[![Migration](/docs/migrating-from-langgraph)](https://evil.example)",
			)
			.replace(
				"[Read the demo transcript](docs/brand/demo/transcript.md)",
				"[![Transcript](docs/brand/demo/transcript.md)](https://evil.example)",
			);
		const failures = validateRootReadme(linkedImages);
		assertFailure(failures, /migrating-from-langgraph/);
		assertFailure(failures, /transcript\.md/);
	});

	it("does not treat outer destinations of nested ordinary links as rendered links", () => {
		const nestedLinks = rootReadme
			.replace(
				"[Migrate from LangGraph](/docs/migrating-from-langgraph)",
				"[Outer [inner](https://evil.example)](/docs/migrating-from-langgraph)",
			)
			.replace(
				"[Read the demo transcript](docs/brand/demo/transcript.md)",
				"[Outer [inner](https://evil.example)](docs/brand/demo/transcript.md)",
			);
		const failures = validateRootReadme(nestedLinks);
		assertFailure(failures, /migrating-from-langgraph/);
		assertFailure(failures, /transcript\.md/);
	});

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
				.replace(
					"[Migrate from LangGraph](/docs/migrating-from-langgraph)",
					migration,
				)
				.replace(
					"[Read the demo transcript](docs/brand/demo/transcript.md)",
					transcript,
				);
			const failures = validateRootReadme(source);
			assertFailure(failures, /migrating-from-langgraph/);
			assertFailure(failures, /transcript\.md/);
		});
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
			);
		assert.deepEqual(validateRootReadme(escapedImageMarkers), []);
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

	it("accepts disjoint package tier definitions", () => {
		assert.doesNotThrow(() =>
			assertDisjointPackageTiers({
				entry: ["entry-package"],
				capability: ["capability-package"],
				tooling: ["tooling-package"],
			}),
		);
	});

	it("rejects a package classified in multiple tiers", () => {
		assert.throws(
			() =>
				assertDisjointPackageTiers({
					entry: ["shared-package"],
					capability: ["shared-package"],
					tooling: [],
				}),
			/Multiple classifications.*shared-package/,
		);
	});

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

	it("does not let caller-supplied tiers disguise an unknown package", () => {
		const alteredDefinitions = {
			entry: [...entry, "@dawn-ai/unknown"],
			capability,
			tooling,
		};
		assert.throws(
			() =>
				resolvePublicPackageTiers(
					[...publicPackages, "@dawn-ai/unknown"],
					alteredDefinitions,
				),
			/Unknown public package.*@dawn-ai\/unknown/,
		);
	});

	it("does not let caller-supplied tiers swap known package classifications", () => {
		const swappedDefinitions = {
			entry: entry.map((name) =>
				name === "@dawn-ai/sdk" ? "@dawn-ai/core" : name,
			),
			capability,
			tooling: tooling.map((name) =>
				name === "@dawn-ai/core" ? "@dawn-ai/sdk" : name,
			),
		};
		const tiers = resolvePublicPackageTiers(publicPackages, swappedDefinitions);
		assert.equal(tiers["@dawn-ai/sdk"], "entry");
		assert.equal(tiers["@dawn-ai/core"], "tooling");
	});
});
