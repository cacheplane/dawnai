const ACTS = ["author", "test", "close"];
export const GENERATED_PATHS = Object.freeze([
	"server/src/app/research/index.ts",
	"server/src/app/research/state.ts",
	"server/src/app/research/plan.md",
	"server/src/tools/searchCorpus.ts",
	"server/test/research.test.ts",
]);

function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function assertString(value, name) {
	if (typeof value !== "string")
		throw new TypeError(`${name} must be a string`);
}

function assertGeneratedTree(tree) {
	if (
		!Array.isArray(tree) ||
		tree.length !== GENERATED_PATHS.length ||
		tree.some((path, index) => path !== GENERATED_PATHS[index])
	) {
		throw new TypeError(
			`tree must contain exactly these generated paths in order: ${GENERATED_PATHS.join(", ")}`,
		);
	}
}

function page(content) {
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dawn demo</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #090b10; color: #f7f7f5; }
    main { width: 100vw; min-height: 100vh; padding: 52px 64px; display: grid; gap: 28px; align-content: center; }
    header { display: flex; align-items: center; gap: 14px; font-weight: 750; letter-spacing: -.02em; }
    .mark { width: 30px; height: 30px; border-radius: 9px; background: linear-gradient(135deg, #e6ff75, #68e0b8); }
    .grid { height: 640px; display: grid; grid-template-columns: minmax(310px, .72fr) 1.5fr; gap: 20px; }
    .stack { min-height: 0; display: grid; grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 20px; }
    .stack .panel { min-height: 0; }
    .stack pre { height: calc(100% - 44px); }
    .panel { overflow: hidden; border: 1px solid #2a3040; border-radius: 16px; background: #111520; box-shadow: 0 22px 80px #0008; }
    .bar { min-height: 44px; padding: 12px 18px; border-bottom: 1px solid #2a3040; color: #aab2c5; font-size: 13px; }
    pre { margin: 0; padding: 20px; overflow: hidden; white-space: pre-wrap; font: 14px/1.55 "SFMono-Regular", Consolas, monospace; color: #e4e8f1; }
    .terminal .bar::before { content: "●  ●  ●"; color: #7e879c; margin-right: 18px; letter-spacing: 4px; }
    .terminal pre { min-height: 420px; color: #dfffc9; }
    .close { text-align: center; justify-items: center; gap: 24px; }
    .category { color: #b7c0d6; font-size: 20px; }
    h1 { max-width: 920px; margin: 0; font-size: clamp(56px, 7vw, 92px); line-height: .98; letter-spacing: -.055em; }
    .command { border: 1px solid #364052; border-radius: 14px; background: #111520; }
  </style>
</head>
<body>${content}</body>
</html>`;
}

function brandHeader() {
	return '<header><span class="mark" aria-hidden="true"></span><span>Dawn</span></header>';
}

export function renderStage({
	act,
	tree,
	primarySource,
	secondarySource,
	testLog,
} = {}) {
	if (!ACTS.includes(act))
		throw new TypeError(`act must be one of: ${ACTS.join(", ")}`);

	if (act === "author") {
		assertGeneratedTree(tree);
		assertString(primarySource, "primarySource");
		assertString(secondarySource, "secondarySource");
		return page(`<main>
  ${brandHeader()}
  <section class="grid" aria-label="Generated Dawn application">
    <div class="panel"><div class="bar">Generated files</div><pre><code>${escapeHtml(tree.join("\n"))}</code></pre></div>
    <div class="stack">
      <div class="panel"><div class="bar">research/index.ts</div><pre><code>${escapeHtml(primarySource)}</code></pre></div>
      <div class="panel"><div class="bar">tools/searchCorpus.ts</div><pre><code>${escapeHtml(secondarySource)}</code></pre></div>
    </div>
  </section>
</main>`);
	}

	if (act === "test") {
		assertString(testLog, "testLog");
		return page(`<main>
  ${brandHeader()}
  <section class="panel terminal" aria-label="Dawn test run">
    <div class="bar">npm test</div>
    <pre><code>${escapeHtml(testLog)}</code></pre>
  </section>
</main>`);
	}

	return page(`<main class="close">
  ${brandHeader()}
  <p class="category">TypeScript meta-framework for LangGraph.js</p>
  <h1>Build LangGraph agents like Next.js apps</h1>
  <pre class="command"><code>npm create dawn-ai-app@latest my-agent</code></pre>
</main>`);
}
