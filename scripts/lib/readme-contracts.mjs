const DESCRIPTION_MINIMUM_LENGTH = 30;
const DESCRIPTION_MAXIMUM_LENGTH = 180;
const KEYWORD_MINIMUM_COUNT = 3;
const KEYWORD_MAXIMUM_COUNT = 8;
const KEYWORD_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const ROOT_HEADINGS = [
	"Quickstart",
	"Why Dawn",
	"How Dawn fits",
	"What Dawn writes for you",
	"What are you building?",
	"When Dawn fits",
	"Build with a coding agent",
	"Run it live",
	"Maturity and support",
];

const DEFAULT_PUBLIC_PACKAGE_TIERS = {
	entry: ["create-dawn-ai-app", "@dawn-ai/sdk", "@dawn-ai/cli"],
	capability: [
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
	],
	tooling: [
		"@dawn-ai/core",
		"@dawn-ai/langchain",
		"@dawn-ai/langgraph",
		"@dawn-ai/vite-plugin",
		"@dawn-ai/devkit",
		"@dawn-ai/config-biome",
		"@dawn-ai/config-typescript",
	],
};

const OLD_GIF_CAPTION =
	"Dawn quickstart — scaffold a route and invoke it in under a minute";

function maskText(value) {
	return value.replace(/[^\r\n]/gu, " ");
}

function maskFencedCode(source) {
	let fence = null;
	return source
		.split(/(?<=\n)/u)
		.map((line) => {
			const content = line.replace(/\r?\n$/u, "");
			if (fence) {
				const closing = /^[ \t]{0,3}([`~]+)[ \t]*$/u.exec(content)?.[1];
				if (
					closing &&
					closing.length >= fence.length &&
					[...closing].every((character) => character === fence.character)
				) {
					fence = null;
				}
				return maskText(line);
			}

			const openingMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u.exec(content);
			const opening = openingMatch?.[1];
			if (
				opening &&
				!(opening[0] === "`" && openingMatch?.[2]?.includes("`"))
			) {
				fence = { character: opening[0], length: opening.length };
				return maskText(line);
			}
			return line;
		})
		.join("");
}

function maskHtmlComments(source) {
	return source.replace(/<!--[\s\S]*?(?:-->|$)/gu, (comment) =>
		maskText(comment),
	);
}

function codeSpanDelimiterLength(source, start) {
	let end = start;
	while (source[end] === "`") end++;
	return end - start;
}

function inlineCodeEnd(source, start, delimiterLength) {
	let index = start + delimiterLength;
	while (
		index < source.length &&
		source[index] !== "\r" &&
		source[index] !== "\n"
	) {
		if (source[index] !== "`") {
			index++;
			continue;
		}
		const candidateLength = codeSpanDelimiterLength(source, index);
		if (candidateLength === delimiterLength) return index + delimiterLength;
		index += candidateLength;
	}
	return -1;
}

function maskInlineCode(source) {
	const characters = source.split("");
	let index = 0;
	while (index < source.length) {
		if (source[index] !== "`") {
			index++;
			continue;
		}
		const delimiterLength = codeSpanDelimiterLength(source, index);
		const end = inlineCodeEnd(source, index, delimiterLength);
		if (end === -1) {
			index += delimiterLength;
			continue;
		}
		for (let characterIndex = index; characterIndex < end; characterIndex++) {
			characters[characterIndex] = " ";
		}
		index = end;
	}
	return characters.join("");
}

function maskNonRenderedMarkdown(source) {
	return maskInlineCode(maskHtmlComments(maskFencedCode(source)));
}

function markdownHeadings(source) {
	const visible = maskHtmlComments(maskFencedCode(source));
	return [...visible.matchAll(/^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/gmu)].map(
		(match) => ({
			index: match.index,
			level: match[1].length,
			text: match[2].replace(/[ \t]+#+[ \t]*$/u, "").trim(),
		}),
	);
}

function hasHeading(headings, names) {
	const accepted = new Set(names.map((name) => name.toLowerCase()));
	return headings.some((heading) => accepted.has(heading.text.toLowerCase()));
}

function hasPurposeStatement(readme, firstH1, headings) {
	if (!firstH1) return false;
	const nextHeading = headings.find((heading) => heading.index > firstH1.index);
	const h1LineEnd = readme.indexOf("\n", firstH1.index);
	const body = readme.slice(
		h1LineEnd === -1 ? readme.length : h1LineEnd + 1,
		nextHeading?.index,
	);
	const visible = maskNonRenderedMarkdown(body);
	return visible
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.some(
			(line) =>
				/[\p{L}\p{N}][\p{L}\p{N}-]*\s+[\p{L}\p{N}]/u.test(line) &&
				!line.startsWith("**Use this when:**") &&
				!/^[-*_]{3,}$/u.test(line) &&
				!/^[-*+>]?(?:\s*$|\s+)/u.test(line) &&
				!/^\d+[.)]\s+/u.test(line) &&
				!/^\|/u.test(line) &&
				!/^\[[^\]]+\]:/u.test(line) &&
				!/^<?(?:img|picture|source)\b/iu.test(line) &&
				!/^!?\[[^\]]*\]/u.test(line) &&
				!/^</u.test(line),
		);
}

function productLoopImagePresent(source) {
	return (
		/!\[[^\]]*\]\([^\r\n)]*docs\/brand\/product-loop\.gif(?:[?#][^\r\n)]*)?\)/iu.test(
			source,
		) ||
		/<img\b[^>]*\bsrc=["'][^"']*docs\/brand\/product-loop\.gif(?:[?#][^"']*)?["'][^>]*>/iu.test(
			source,
		)
	);
}

function markdownLinkPresent(source, href) {
	const links = source.matchAll(
		/(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/giu,
	);
	for (const match of links) {
		const destination = match[1].replace(/^<|>$/gu, "");
		if (/^https?:\/\//iu.test(destination)) {
			try {
				const pathname = new URL(destination).pathname;
				if (
					(href.startsWith("/") && pathname === href) ||
					(!href.startsWith("/") && pathname.endsWith(`/${href}`))
				) {
					return true;
				}
			} catch {
				continue;
			}
			continue;
		}

		const relativeDestination = destination.split(/[?#]/u, 1)[0];
		if (
			relativeDestination === href ||
			(!href.startsWith("/") && relativeDestination === `./${href}`)
		) {
			return true;
		}
	}
	return false;
}

function canonicalScaffoldCommandPresent(source) {
	return /(?:^|[\s`$>])pnpm create dawn-ai-app my-app(?=$|[\s`'";|&])/mu.test(
		source,
	);
}

export function validatePackageDiscoveryMetadata(manifest) {
	const failures = [];
	const packageName =
		typeof manifest?.name === "string" ? manifest.name : "package";
	const description = manifest?.description;

	if (
		typeof description !== "string" ||
		description.length < DESCRIPTION_MINIMUM_LENGTH ||
		description.length > DESCRIPTION_MAXIMUM_LENGTH
	) {
		failures.push(
			`${packageName}: package.json description must be a string of ${DESCRIPTION_MINIMUM_LENGTH}-${DESCRIPTION_MAXIMUM_LENGTH} characters`,
		);
	} else if (description !== description.trim()) {
		failures.push(`${packageName}: package.json description must be trimmed`);
	}

	const keywords = manifest?.keywords;
	if (
		!Array.isArray(keywords) ||
		keywords.length < KEYWORD_MINIMUM_COUNT ||
		keywords.length > KEYWORD_MAXIMUM_COUNT
	) {
		failures.push(
			`${packageName}: package.json keywords must contain ${KEYWORD_MINIMUM_COUNT}-${KEYWORD_MAXIMUM_COUNT} values`,
		);
	}

	if (Array.isArray(keywords)) {
		if (new Set(keywords).size !== keywords.length) {
			failures.push(`${packageName}: package.json keywords must be unique`);
		}
		if (
			keywords.some(
				(keyword) =>
					typeof keyword !== "string" || !KEYWORD_PATTERN.test(keyword),
			)
		) {
			failures.push(
				`${packageName}: package.json keywords must be lowercase kebab-case strings`,
			);
		}
	}

	return failures;
}

export function validatePackageReadme({ tier, manifest, readme }) {
	if (!Object.hasOwn(DEFAULT_PUBLIC_PACKAGE_TIERS, tier)) {
		throw new Error(`Unknown README tier "${tier}"`);
	}

	const failures = validatePackageDiscoveryMetadata(manifest);
	const packageName = manifest?.name;
	const source = typeof readme === "string" ? readme : "";
	const headings = markdownHeadings(source);
	const firstH1 = headings.find((heading) => heading.level === 1);

	if (typeof packageName !== "string" || firstH1?.text !== packageName) {
		failures.push(
			`${packageName ?? "package"}: README H1 must be the package name ${packageName ?? ""}`.trim(),
		);
	}
	if (!hasPurposeStatement(source, firstH1, headings)) {
		failures.push(
			`${packageName ?? "package"}: README must begin with a purpose statement`,
		);
	}

	const visibleSource = maskNonRenderedMarkdown(source);
	if (!/^\*\*Use this when:\*\*[ \t]+\S/mu.test(visibleSource)) {
		failures.push(
			`${packageName ?? "package"}: README is missing **Use this when:** guidance`,
		);
	}
	if (!hasHeading(headings, ["Install", "Installation", "Invocation"])) {
		failures.push(
			`${packageName ?? "package"}: README needs an Install or Invocation heading`,
		);
	}

	if (tier === "entry" || tier === "capability") {
		if (!hasHeading(headings, ["Example"])) {
			failures.push(
				`${packageName ?? "package"}: ${tier} README needs an Example heading`,
			);
		}
	} else if (!hasHeading(headings, ["Example", "Configuration"])) {
		failures.push(
			`${packageName ?? "package"}: tooling README needs an Example or Configuration heading`,
		);
	}

	for (const heading of [
		"Runtime and stability",
		"Related",
		"Maturity and support",
		"License",
	]) {
		if (!hasHeading(headings, [heading])) {
			failures.push(
				`${packageName ?? "package"}: README is missing the ${heading} heading`,
			);
		}
	}

	if (tier === "entry" && !productLoopImagePresent(visibleSource)) {
		failures.push(
			`${packageName ?? "package"}: entry README is missing the docs/brand/product-loop.gif image`,
		);
	}

	return failures;
}

export function validateRootReadme(source) {
	const failures = [];
	const readme = typeof source === "string" ? source : "";
	const headings = markdownHeadings(readme);
	const rootHeadings = headings.filter((heading) => heading.level === 2);
	const requiredIndexes = [];

	for (const required of ROOT_HEADINGS) {
		const matches = rootHeadings
			.map((heading, index) => ({ heading, index }))
			.filter(({ heading }) => heading.text === required);
		if (matches.length === 0) {
			failures.push(`README is missing the ${required} H2 heading`);
			requiredIndexes.push(null);
			continue;
		}
		if (matches.length > 1) {
			failures.push(`README must contain exactly one ${required} H2 heading`);
		}
		requiredIndexes.push(matches[0].index);
	}

	if (
		requiredIndexes.some(
			(index, position) =>
				index !== null &&
				position > 0 &&
				requiredIndexes[position - 1] !== null &&
				index <= requiredIndexes[position - 1],
		)
	) {
		failures.push("README required headings are out of order");
	}

	const withoutComments = maskHtmlComments(readme);
	const visibleSource = maskInlineCode(maskFencedCode(withoutComments));
	if (!canonicalScaffoldCommandPresent(withoutComments)) {
		failures.push(
			"README is missing the canonical scaffold command: pnpm create dawn-ai-app my-app",
		);
	}
	if (!productLoopImagePresent(visibleSource)) {
		failures.push("README is missing the docs/brand/product-loop.gif image");
	}
	if (!markdownLinkPresent(visibleSource, "/docs/migrating-from-langgraph")) {
		failures.push(
			"README is missing the /docs/migrating-from-langgraph migration link",
		);
	}
	if (!markdownLinkPresent(visibleSource, "docs/brand/demo/transcript.md")) {
		failures.push("README is missing the docs/brand/demo/transcript.md link");
	}
	if (readme.includes(OLD_GIF_CAPTION)) {
		failures.push("README still contains the old GIF caption");
	}

	return failures;
}

export function resolvePublicPackageTiers(publicPackageNames) {
	if (!Array.isArray(publicPackageNames)) {
		throw new TypeError("Public package names must be an array");
	}

	const inventorySeen = new Set();
	for (const packageName of publicPackageNames) {
		if (inventorySeen.has(packageName)) {
			throw new Error(`Duplicate public package: ${packageName}`);
		}
		inventorySeen.add(packageName);
	}

	const classifications = new Map();
	for (const tier of ["entry", "capability", "tooling"]) {
		const packages = DEFAULT_PUBLIC_PACKAGE_TIERS[tier];
		for (const packageName of packages) {
			if (classifications.has(packageName)) {
				throw new Error(
					`Multiple classifications for public package: ${packageName}`,
				);
			}
			classifications.set(packageName, tier);
		}
	}

	for (const packageName of publicPackageNames) {
		if (!classifications.has(packageName)) {
			throw new Error(`Unknown public package: ${packageName}`);
		}
	}
	for (const packageName of classifications.keys()) {
		if (!inventorySeen.has(packageName)) {
			throw new Error(`Missing known public package: ${packageName}`);
		}
	}

	return Object.fromEntries(
		publicPackageNames.map((packageName) => [
			packageName,
			classifications.get(packageName),
		]),
	);
}
