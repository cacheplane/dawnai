import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	lstat,
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rename as renameFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { script } from "../../../packages/testing/dist/index.js";
import {
	assertLoopbackModelBaseUrl,
	buildChildEnvironment,
	captureDemo,
	closeBrowserResources,
	createBrowserResources,
	createManagedChildRegistry,
	createManagedServiceMonitor,
	fillActiveWorkbenchComposer,
	generatedInstallCommand,
	generatedTestCommand,
	installCaptureSignalHandlers,
	openReadyWorkbench,
	parseCaptureArguments,
	raceCapturePhase,
	restoreWorkbenchThread,
	runManagedCommand,
	sanitizeOperationalEnvironment,
	startHttpService,
	startWithAssignedPort,
	validateRunId,
	validateToolchainVersions,
	waitForWorkbenchRunCompletion,
} from "./capture.mjs";
import {
	checkLocalMedia,
	checkRemoteMedia,
	MEDIA_CAPTIONS,
	MEDIA_CONTRACTS,
	parseMediaCheckArguments,
	probeFile,
	runBoundedRemoteOperation,
	validateDemoMediaCatalog,
	validateMediaManifestLayout,
	validateLocalMediaContract,
	validateStagedMediaManifest,
} from "./check-media.mjs";
import {
	buildTimelineFilter,
	createTimelinePlan,
	encodeCaptureArtifacts,
	encodeGif,
	encodePoster,
	encodeVideo,
	publishFixedAssets,
	runEncoderCommand,
} from "./encode.mjs";
import { normalizeLog } from "./normalize-log.mjs";
import {
	getAvailableLoopbackPort,
	spawnManaged,
	stopManaged,
	waitForHttp,
} from "./processes.mjs";
import { DEMO_FIXTURES, DEMO_PROMPT } from "./scenario.mjs";
import { renderStage } from "./stage.mjs";
import {
	buildDemoMediaCatalog,
	createUploadPlan,
	MEDIA_UPLOAD_PATHS,
	parseUploadArguments,
	uploadReadmeMedia,
	validatePublicBaseUrl,
	validateUploadPathname,
	writeDemoMediaCatalog,
} from "./upload.mjs";

function videoProbe({
	codecName,
	duration,
	width = 1440,
	height = 810,
	frameRate = "30/1",
	reportedFrameRate = frameRate,
}) {
	return {
		streams: [
		{
			codec_name: codecName,
			codec_type: "video",
			width,
			height,
			avg_frame_rate: frameRate,
			r_frame_rate: reportedFrameRate,
		},
		],
		format: { duration: String(duration) },
	};
}

function validMediaFixtures() {
	const files = new Map();
	for (const contract of MEDIA_CONTRACTS) {
		files.set(contract.mp4, {
			size: 1_200_000,
			probe: videoProbe({
				codecName: "h264",
				duration: contract.name === "product-loop" ? 24 : 10,
			}),
		});
		files.set(contract.webm, {
			size: 1_100_000,
			probe: videoProbe({
				codecName: "vp9",
				duration: contract.name === "product-loop" ? 24 : 10,
			}),
		});
		files.set(contract.poster, {
			size: 80_000,
			probe: videoProbe({ codecName: "webp", duration: 0 }),
		});
	}
	files.set("docs/brand/product-loop.gif", {
		size: 3_500_000,
		probe: videoProbe({ codecName: "gif", duration: 24 }),
	});
	files.set("docs/brand/demo/transcript.md", {
		size: 2_000,
		text: "Exact static walkthrough",
	});
	return files;
}

async function validateMedia(overrides = new Map()) {
	const files = validMediaFixtures();
	for (const [path, value] of overrides) files.set(path, value);
	return validateLocalMediaContract({
		files,
		captions: {
			"product-loop":
				"Author a route, run its offline test, use the Workbench, and restore the same thread after a browser reload.",
			author: "Inspect the generated research route and shared tool.",
			test: "Run the deterministic research scenario with npm test.",
			run: "Complete a Workbench run, reload, and restore the same thread.",
		},
	});
}

test("media contracts accept the exact flagship and derivative formats", async () => {
	assert.deepEqual(await validateMedia(), []);
});

test("media contracts accept GIF centisecond timing reported as 30 fps", async () => {
	const files = validMediaFixtures();
	files.set("docs/brand/product-loop.gif", {
		size: 3_000_000,
		probe: videoProbe({
			codecName: "gif",
			duration: 24.03,
			frameRate: "100/3",
			reportedFrameRate: "30/1",
		}),
	});
	const failures = await validateLocalMediaContract({
		files,
		captions: {
			"product-loop": "Author, test, run, reload, and restore.",
			author: "Generated route and shared tool.",
			test: "Offline test passes.",
			run: "Browser reload restores the thread.",
		},
	});
	assert.deepEqual(failures, []);
});

test("media contracts reject wrong dimensions and aspect ratio", async () => {
	const failures = await validateMedia(
		new Map([
			[
				"docs/brand/demo/artifacts/output/author.mp4",
				{
					size: 1_200_000,
					probe: videoProbe({
						codecName: "h264",
						duration: 10,
						width: 1280,
						height: 800,
					}),
				},
			],
		]),
	);
	assert.ok(failures.some((failure) => /1440x810/.test(failure)));
});

test("media contracts reject durations outside each clip window", async () => {
	const failures = await validateMedia(
		new Map([
			[
				"docs/brand/demo/artifacts/output/product-loop.mp4",
				{
					size: 1_200_000,
					probe: videoProbe({ codecName: "h264", duration: 19.99 }),
				},
			],
			[
				"docs/brand/demo/artifacts/output/run.webm",
				{
					size: 1_100_000,
					probe: videoProbe({ codecName: "vp9", duration: 12.01 }),
				},
			],
		]),
	);
	assert.ok(failures.some((failure) => /product-loop.*20-30 seconds/.test(failure)));
	assert.ok(failures.some((failure) => /run.*8-12 seconds/.test(failure)));
});

test("media contracts reject files over their byte budgets", async () => {
	const failures = await validateMedia(
		new Map([
			[
				"docs/brand/demo/artifacts/output/test.mp4",
				{
					size: 2_000_001,
					probe: videoProbe({ codecName: "h264", duration: 10 }),
				},
			],
			[
				"docs/brand/product-loop.gif",
				{
					size: 4_000_001,
					probe: videoProbe({ codecName: "gif", duration: 24 }),
				},
			],
		]),
	);
	assert.ok(failures.some((failure) => /test\.mp4.*2,000,000 bytes/.test(failure)));
	assert.ok(
		failures.some((failure) => /product-loop\.gif.*4,000,000 bytes/.test(failure)),
	);
});

test("media contracts require every poster and the transcript", async () => {
	const files = validMediaFixtures();
	files.delete("apps/web/public/demo/run-poster.webp");
	files.delete("docs/brand/demo/transcript.md");
	const failures = await validateLocalMediaContract({
		files,
		captions: Object.fromEntries(
			MEDIA_CONTRACTS.map(({ name }) => [name, "Accurate static description"]),
		),
	});
	assert.ok(failures.some((failure) => /run.*poster/.test(failure)));
	assert.ok(failures.some((failure) => /transcript/.test(failure)));
});

test("media contracts require 1440x810 WebP posters", async () => {
	const files = validMediaFixtures();
	files.set("apps/web/public/demo/test-poster.webp", {
		size: 80_000,
		probe: videoProbe({
			codecName: "png",
			duration: 0,
			width: 1280,
			height: 720,
		}),
	});
	const failures = await validateLocalMediaContract({
		files,
		captions: Object.fromEntries(
			MEDIA_CONTRACTS.map(({ name }) => [name, "Accurate static description"]),
		),
	});
	assert.ok(failures.some((failure) => /test-poster\.webp.*WebP/.test(failure)));
	assert.ok(failures.some((failure) => /test-poster\.webp.*1440x810/.test(failure)));
});

test("media contracts reject captions that claim scaffolding is visible", async () => {
	const files = validMediaFixtures();
	const failures = await validateLocalMediaContract({
		files,
		captions: {
			"product-loop": "Scaffold a Dawn app, then run it.",
			author: "Generated route and shared tool.",
			test: "Offline test passes.",
			run: "Browser reload restores the thread.",
		},
	});
	assert.ok(failures.some((failure) => /caption.*scaffold/i.test(failure)));
});

test("media contracts require H.264 MP4, VP9 WebM, and 30 fps", async () => {
	const failures = await validateMedia(
		new Map([
			[
				"docs/brand/demo/artifacts/output/author.mp4",
				{
					size: 1_200_000,
					probe: videoProbe({ codecName: "hevc", duration: 10 }),
				},
			],
			[
				"docs/brand/demo/artifacts/output/author.webm",
				{
					size: 1_100_000,
					probe: videoProbe({
						codecName: "vp8",
						duration: 10,
						frameRate: "25/1",
					}),
				},
			],
		]),
	);
	assert.ok(failures.some((failure) => /author\.mp4.*H\.264/.test(failure)));
	assert.ok(failures.some((failure) => /author\.webm.*VP9/.test(failure)));
	assert.ok(failures.some((failure) => /author\.webm.*30 fps/.test(failure)));
});

function validManifestLayout(repoRoot = "/repo", runId = "run-a") {
	const runRoot = `${repoRoot}/docs/brand/demo/artifacts/runs/${runId}`;
	const outputRoot = `${runRoot}/output`;
	const publicationRoot = `${runRoot}/publication`;
	return {
		pointer: {
			schemaVersion: 1,
			runId,
			manifestPath: `${runRoot}/media-manifest.json`,
		},
		manifest: {
			schemaVersion: 1,
			runId,
			outputRoot,
			clips: Object.fromEntries(
				MEDIA_CONTRACTS.map(({ name }) => [
					name,
					{
						mp4: `${outputRoot}/${name}.mp4`,
						webm: `${outputRoot}/${name}.webm`,
						poster: `${publicationRoot}/${name}-poster.webp`,
					},
				]),
			),
			gif: `${publicationRoot}/product-loop.gif`,
			assetHashes: {
				gif: "a".repeat(64),
				posters: Object.fromEntries(
					MEDIA_CONTRACTS.map(({ name }) => [name, "b".repeat(64)]),
				),
			},
		},
	};
}

test("media manifest layout rejects stale identity and cross-run paths", () => {
	const repoRoot = "/repo";
	const { pointer, manifest } = validManifestLayout(repoRoot);
	assert.doesNotThrow(() =>
		validateMediaManifestLayout({ repoRoot, pointer, manifest }),
	);
	assert.throws(
		() =>
			validateMediaManifestLayout({
				repoRoot,
				pointer: {
					...pointer,
					runId: "stale-run",
					manifestPath:
						"/repo/docs/brand/demo/artifacts/runs/stale-run/media-manifest.json",
				},
				manifest,
			}),
		/pointer and manifest run IDs differ/,
	);
	assert.throws(
		() =>
			validateMediaManifestLayout({
				repoRoot,
				pointer,
				manifest: {
					...manifest,
					clips: {
						...manifest.clips,
						run: {
							...manifest.clips.run,
							mp4: "/tmp/other-run/run.mp4",
						},
					},
				},
			}),
		/run\.mp4.*expected run output root/,
	);
	assert.throws(
		() =>
			validateMediaManifestLayout({
				repoRoot,
				pointer: { ...pointer, schemaVersion: 2 },
				manifest,
			}),
		/unsupported latest-media schema/,
	);
});

test("local checker adapters surface manifest, probe, and CLI failures", async () => {
	await assert.rejects(
		checkLocalMedia({
			repoRoot: "/repo",
			async readFile() {
				throw new Error("manifest read failed");
			},
		}),
		/manifest read failed/,
	);
	const unsafeReads = [];
	await assert.rejects(
		checkLocalMedia({
			repoRoot: "/repo",
			async readFile(path) {
				unsafeReads.push(path);
				if (path.endsWith("latest-media.json")) {
					return JSON.stringify({
						schemaVersion: 1,
						runId: "run-a",
						manifestPath: "/tmp/untrusted-manifest.json",
					});
				}
				throw new Error("unsafe manifest read");
			},
		}),
		/manifest path.*expected run output root/,
	);
	assert.deepEqual(unsafeReads, [
		"/repo/docs/brand/demo/artifacts/latest-media.json",
	]);
	const repoRoot = "/repo";
	const { pointer, manifest } = validManifestLayout(repoRoot);
	await assert.rejects(
		checkLocalMedia({
			repoRoot,
			async readFile(path) {
				if (path.endsWith("latest-media.json")) return JSON.stringify(pointer);
				if (path.endsWith("media-manifest.json")) return JSON.stringify(manifest);
				if (path.endsWith("transcript.md")) return "transcript";
				throw new Error(`unexpected read: ${path}`);
			},
			async stat(path) {
				return {
					size: path.endsWith(".gif")
						? 3_500_000
						: path.endsWith(".mp4")
							? 1_200_000
							: 80_000,
				};
			},
			async access() {},
			async probe() {
				throw new Error("probe failed");
			},
			async hash(path) {
				return path.endsWith(".gif") ? "a".repeat(64) : "b".repeat(64);
			},
			log() {},
		}),
		/probe failed/,
	);
	assert.deepEqual(parseMediaCheckArguments(["--", "--local"]), {
		local: true,
	});
	assert.throws(
		() => parseMediaCheckArguments(["--invalid"]),
		/Usage:.*--local.*--remote/,
	);
});

test("local checker rejects a fixed asset that differs from its selected run", async () => {
	const repoRoot = "/repo";
	const { pointer, manifest } = validManifestLayout(repoRoot);
	const fixedProductPoster = join(
		repoRoot,
		MEDIA_CONTRACTS[0].poster,
	);
	await assert.rejects(
		checkLocalMedia({
			repoRoot,
			async readFile(path) {
				if (path.endsWith("latest-media.json")) return JSON.stringify(pointer);
				if (path.endsWith("media-manifest.json")) return JSON.stringify(manifest);
				throw new Error(`unexpected read: ${path}`);
			},
			async hash(path) {
				if (path === fixedProductPoster) return "c".repeat(64);
				return path.endsWith(".gif") ? "a".repeat(64) : "b".repeat(64);
			},
			log() {},
		}),
		/product-loop fixed poster does not correspond to run run-a/,
	);
});

test("staged validation aborts and joins ffprobe before caller cleanup", async () => {
	const repoRoot = "/repo";
	const { pointer, manifest } = validManifestLayout(repoRoot);
	const controller = new AbortController();
	const reason = new Error("cancel staged validation");
	const events = [];
	let markStarted;
	const started = new Promise((resolve) => {
		markStarted = resolve;
	});
	const validation = validateStagedMediaManifest({
		repoRoot,
		manifest,
		manifestPath: pointer.manifestPath,
		signal: controller.signal,
		async hash(path) {
			return path.endsWith(".gif") ? "a".repeat(64) : "b".repeat(64);
		},
		async stat(path) {
			return { size: path.endsWith(".mp4") ? 1_200_000 : 1_100_000 };
		},
		async access() {},
		async readFile() {
			return "transcript";
		},
		probe(path, options) {
			return probeFile(path, {
				...options,
				exec: async (_command, _args, { signal }) => {
					events.push("ffprobe started");
					markStarted();
					return new Promise((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() => {
								events.push("ffprobe abort received");
								setImmediate(() => {
									events.push("ffprobe child settled");
									reject(new Error("native child abort"));
								});
							},
							{ once: true },
						);
					});
				},
			});
		},
	});
	await started;
	controller.abort(reason);
	await assert.rejects(validation, (error) => error === reason);
	events.push("encoding cleanup");
	assert.deepEqual(events, [
		"ffprobe started",
		"ffprobe abort received",
		"ffprobe child settled",
		"encoding cleanup",
	]);
});

test("encoding plan builds the four honest capture timelines", () => {
	const plan = createTimelinePlan({
		videoTimeline: {
			unit: "milliseconds",
			scenes: {
				author: { startMs: 0, endMs: 1_500 },
				test: { startMs: 1_500, endMs: 3_000 },
				"workbench-run": { startMs: 3_000, endMs: 7_000 },
				"pre-reload-complete": { startMs: 7_000, endMs: 8_200 },
				restoration: { startMs: 8_200, endMs: 12_000 },
				close: { startMs: 12_000, endMs: 13_500 },
			},
		},
	});

	assert.deepEqual(Object.keys(plan), ["product-loop", "author", "test", "run"]);
	assert.equal(plan["product-loop"].duration, 24);
	assert.equal(plan.author.duration, 9);
	assert.equal(plan.test.duration, 9);
	assert.equal(plan.run.duration, 10);
	assert.deepEqual(
		plan["product-loop"].segments.map(({ scene }) => scene),
		["author", "test", "workbench", "close"],
	);
	assert.deepEqual(
		plan.run.segments.map(({ scene }) => scene),
		["run-completed", "reload-and-restoration"],
	);
	assert.deepEqual(
		plan["product-loop"].segments.map(({ actLabel }) => actLabel ?? null),
		["Author", "Prove", "Run", null],
		"the encoded flagship must visibly identify its three acts",
	);
	assert.deepEqual(
		[plan.author.actLabel, plan.test.actLabel, plan.run.actLabel],
		["Author", "Prove", "Run"],
		"derivative encodes must preserve the matching visual act label",
	);
	assert.equal(plan["product-loop"].segments[0].sourceEnd, 1.3);
	assert.equal(plan.author.segments[0].sourceEnd, 1.3);
	assert.equal(plan.test.segments[0].sourceEnd, 2.8);
	assert.equal(plan.run.segments[0].sourceEnd, 8);
	assert.equal(plan.run.segments[1].sourceEnd, 11.8);
	const flagshipFilter = buildTimelineFilter(plan["product-loop"], {
		labelInputIndexes: [1, 2, 3, undefined],
	}).filter;
	assert.match(flagshipFilter, /\[segment0base\]\[1:v\]overlay=/);
	assert.match(flagshipFilter, /\[segment1base\]\[2:v\]overlay=/);
	assert.match(flagshipFilter, /\[segment2base\]\[3:v\]overlay=/);
	assert.match(flagshipFilter, /\[segment3base\]null\[segment3\]/);
	assert.throws(
		() => buildTimelineFilter(plan["product-loop"]),
		/Author act label has no visual input/,
	);
});

test("encoding refuses to truncate an overlong Workbench restoration endpoint", () => {
	const plan = createTimelinePlan({
		videoTimeline: {
			unit: "milliseconds",
			scenes: {
				author: { startMs: 0, endMs: 1_500 },
				test: { startMs: 1_500, endMs: 3_000 },
				"workbench-run": { startMs: 3_000, endMs: 8_000 },
				"pre-reload-complete": { startMs: 8_000, endMs: 9_000 },
				restoration: { startMs: 9_000, endMs: 13_500 },
				close: { startMs: 13_500, endMs: 15_000 },
			},
		},
	});

	assert.throws(
		() =>
			buildTimelineFilter(plan["product-loop"], {
				labelInputIndexes: [1, 2, 3, undefined],
			}),
		/workbench.*restored endpoint.*10\.3.*9 seconds/i,
	);
});

test("poster encoding extracts a real frame before WebP conversion", async () => {
	const calls = [];
	await encodePoster({
		source: "/capture/raw.webm",
		destination: "/repo/apps/web/public/demo/author-poster.webp",
		time: 0.75,
		async run(command, args) {
			calls.push({ command, args });
		},
		async convert(source, destination) {
			calls.push({ convert: [source, destination] });
		},
		async rename(source, destination) {
			calls.push({ rename: [source, destination] });
		},
		async remove(path) {
			calls.push({ remove: path });
		},
	});

	assert.equal(calls[0].command, "ffmpeg");
	assert.ok(calls[0].args.includes("/capture/raw.webm"));
	assert.ok(calls[0].args.at(-1).endsWith(".tmp.png"));
	assert.equal(calls[0].args.includes("libwebp"), false);
	assert.deepEqual(calls[1], {
		convert: [
			"/repo/apps/web/public/demo/author-poster.webp.tmp.png",
			"/repo/apps/web/public/demo/author-poster.webp.tmp.webp",
		],
	});
	assert.deepEqual(calls[2], {
		rename: [
			"/repo/apps/web/public/demo/author-poster.webp.tmp.webp",
			"/repo/apps/web/public/demo/author-poster.webp",
		],
	});
	assert.deepEqual(calls[3], {
		remove: "/repo/apps/web/public/demo/author-poster.webp.tmp.png",
	});
});

test("video and GIF encoders recheck abort before rename and clean their temps", async () => {
	const plan = {
		duration: 2,
		segments: [
			{
				scene: "author",
				sourceStart: 0,
				sourceEnd: 1,
				duration: 2,
				actLabel: "Author",
			},
		],
	};
	const labelAssets = new Map([["Author", "/run/labels/author.png"]]);
	for (const [name, encode, destination, expectedTemporaryPath] of [
		[
			"video",
			encodeVideo,
			"/run/output/author.mp4",
			"/run/output/author.mp4.tmp.mp4",
		],
		[
			"GIF",
			encodeGif,
			"/run/publication/product-loop.gif",
			"/run/publication/product-loop.gif.tmp.gif",
		],
	]) {
		const controller = new AbortController();
		const calls = [];
		await assert.rejects(
			encode({
				source: "/run/raw.webm",
				destination,
				plan,
				...(name === "video" ? { format: "mp4" } : {}),
				labelAssets,
				signal: controller.signal,
				async run() {
					controller.abort(new Error(`abort ${name}`));
				},
				async rename(...args) {
					calls.push(["rename", ...args]);
				},
				async remove(path) {
					calls.push(["remove", path]);
				},
			}),
			new RegExp(`abort ${name}`),
		);
		assert.deepEqual(calls, [["remove", expectedTemporaryPath]]);
	}
});

test("fixed media publication rolls back every prior asset and pointer", async () => {
	const root = await mkdtemp(join(tmpdir(), "dawn-media-publish-"));
	try {
		for (const failureAt of ["poster", "gif", "pointer"]) {
			const caseRoot = join(root, failureAt);
			const stagedRoot = join(caseRoot, "staged");
			const fixedRoot = join(caseRoot, "fixed");
			await Promise.all([
				mkdir(stagedRoot, { recursive: true }),
				mkdir(fixedRoot, { recursive: true }),
			]);
			const entries = ["poster", "gif", "pointer"].map((name) => ({
				name,
				stagedPath: join(stagedRoot, name),
				targetPath: join(fixedRoot, name),
			}));
			for (const entry of entries) {
				await writeFile(entry.stagedPath, `new-${entry.name}`);
				await writeFile(entry.targetPath, `old-${entry.name}`);
			}

			await assert.rejects(
				publishFixedAssets({
					entries,
					transactionId: `run-${failureAt}`,
					async afterPublish(name) {
						if (name === failureAt) throw new Error(`fail after ${name}`);
					},
				}),
				new RegExp(`fail after ${failureAt}`),
			);
			for (const entry of entries) {
				assert.equal(
					await readFile(entry.targetPath, "utf8"),
					`old-${entry.name}`,
				);
			}
			assert.deepEqual((await readdir(fixedRoot)).sort(), ["gif", "pointer", "poster"]);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("failed backup restoration preserves and reports the recovery file", async () => {
	const root = await mkdtemp(join(tmpdir(), "dawn-media-recovery-"));
	try {
		const stagedPath = join(root, "staged");
		const targetPath = join(root, "fixed");
		const transactionId = "run-recovery";
		const backupPath = `${targetPath}.backup-${transactionId}`;
		await writeFile(stagedPath, "new bytes");
		await writeFile(targetPath, "old recoverable bytes");
		let thrown;
		try {
			await publishFixedAssets({
				entries: [{ name: "gif", stagedPath, targetPath }],
				transactionId,
				afterPublish() {
					throw new Error("publish failed");
				},
				rename(source, destination) {
					if (source === backupPath && destination === targetPath) {
						throw new Error("restore rename failed");
					}
					return renameFile(source, destination);
				},
			});
		} catch (error) {
			thrown = error;
		}
		assert.ok(thrown instanceof AggregateError);
		assert.match(thrown.message, new RegExp(backupPath.replaceAll("/", "\\/")));
		await assert.rejects(readFile(targetPath), { code: "ENOENT" });
		assert.equal(await readFile(backupPath, "utf8"), "old recoverable bytes");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("publication preflight preserves and reports every existing recovery backup", async () => {
	const root = await mkdtemp(join(tmpdir(), "dawn-media-preflight-"));
	try {
		const transactionId = "run-preflight";
		const entries = ["manifest", "pointer"].map((name) => ({
			name,
			stagedPath: join(root, `${name}.staged`),
			targetPath: join(root, `${name}.fixed`),
		}));
		for (const entry of entries) {
			await writeFile(entry.stagedPath, `new:${entry.name}`);
			await writeFile(entry.targetPath, `old:${entry.name}`);
			await writeFile(
				`${entry.targetPath}.backup-${transactionId}`,
				`recovery:${entry.name}`,
			);
			await writeFile(
				`${entry.targetPath}.next-${transactionId}`,
				`candidate:${entry.name}`,
			);
		}
		let thrown;
		try {
			await publishFixedAssets({ entries, transactionId });
		} catch (error) {
			thrown = error;
		}
		assert.ok(thrown instanceof Error);
		for (const entry of entries) {
			const backupPath = `${entry.targetPath}.backup-${transactionId}`;
			assert.match(thrown.message, new RegExp(backupPath.replaceAll("/", "\\/")));
			assert.equal(await readFile(entry.targetPath, "utf8"), `old:${entry.name}`);
			assert.equal(await readFile(backupPath, "utf8"), `recovery:${entry.name}`);
			assert.equal(
				await readFile(`${entry.targetPath}.next-${transactionId}`, "utf8"),
				`candidate:${entry.name}`,
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("encoding failures never mix fixed assets or the latest pointer across runs", async () => {
	const root = await mkdtemp(join(tmpdir(), "dawn-media-encode-"));
	try {
		for (const failureAt of ["video", "poster", "gif", "pointer"]) {
			const repoRoot = join(root, failureAt);
			const runId = `run-${failureAt}`;
			const artifactsDir = join(
				repoRoot,
				"docs/brand/demo/artifacts/runs",
				runId,
			);
			const recordingsDir = join(
				repoRoot,
				"docs/brand/demo/raw-recordings/runs",
				runId,
			);
			const source = join(recordingsDir, "raw.webm");
			const summaryPath = join(artifactsDir, "capture-summary.json");
			const fixedPaths = [
				join(artifactsDir, "media-manifest.json"),
				...MEDIA_CONTRACTS.map(({ name }) =>
					join(repoRoot, `apps/web/public/demo/${name}-poster.webp`),
				),
				join(repoRoot, "docs/brand/product-loop.gif"),
				join(repoRoot, "docs/brand/demo/artifacts/latest-media.json"),
			];
			await Promise.all([
				mkdir(recordingsDir, { recursive: true }),
				mkdir(artifactsDir, { recursive: true }),
				mkdir(join(repoRoot, "apps/web/public/demo"), { recursive: true }),
				mkdir(join(repoRoot, "docs/brand"), { recursive: true }),
				mkdir(join(repoRoot, "docs/brand/demo/artifacts"), { recursive: true }),
			]);
			await writeFile(source, "raw");
			for (const path of fixedPaths) await writeFile(path, `old:${path}`);
			const summary = {
				runId,
				videoPath: source,
				videoTimeline: {
					unit: "milliseconds",
					scenes: {
						author: { startMs: 0, endMs: 1_500 },
						test: { startMs: 1_500, endMs: 3_000 },
						"workbench-run": { startMs: 3_000, endMs: 7_000 },
						"pre-reload-complete": { startMs: 7_000, endMs: 8_200 },
						restoration: { startMs: 8_200, endMs: 12_000 },
						close: { startMs: 12_000, endMs: 13_500 },
					},
				},
			};
			const controller = new AbortController();

			await assert.rejects(
				encodeCaptureArtifacts({
					repoRoot,
					artifactsDir,
					recordingsDir,
					summary,
					summaryPath,
					signal: controller.signal,
					dependencies: {
						async encodeVideo({ destination }) {
							await writeFile(destination, "video");
						},
						async encodePoster({ destination }) {
							await writeFile(destination, "poster");
						},
						async encodeGif({ destination }) {
							await writeFile(destination, "gif");
						},
						async validateStagedMedia(options) {
							assert.equal(options.signal, controller.signal);
						},
						async afterPhase(phase) {
							if (phase === failureAt) throw new Error(`fail after ${phase}`);
						},
					},
				}),
				new RegExp(`fail after ${failureAt}`),
			);
			for (const path of fixedPaths) {
				assert.equal(await readFile(path, "utf8"), `old:${path}`);
			}
			const fixedNames = await readdir(join(repoRoot, "apps/web/public/demo"));
			assert.equal(
				fixedNames.some((name) => /\.(?:next|backup|tmp)-/u.test(name)),
				false,
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

const GENERATED_TREE = [
	"server/src/app/research/index.ts",
	"server/src/app/research/state.ts",
	"server/src/app/research/plan.md",
	"server/src/tools/searchCorpus.ts",
	"server/test/research.test.ts",
];

test("scenario exports the canonical prompt and deterministic research fixture", () => {
	assert.equal(DEMO_PROMPT, "What are common agent architectures?");
	assert.deepEqual(
		DEMO_FIXTURES,
		script()
			.user("What are common agent architectures?")
			.callsTool("searchCorpus", { query: "agent architectures" })
			.callsTool("readDoc", { path: "corpus/agent-architectures.md" })
			.replies(
				"ReAct and plan-and-execute are common. [corpus/agent-architectures.md]",
			)
			.build(),
	);
});

test("normalizeLog narrowly removes capture instability", () => {
	const temporaryRoot = "/tmp/dawn-demo-[42]";
	const raw = [
		`\u001B[32mPASS\u001B[39m ${temporaryRoot}/server/test/research.test.ts 143ms`,
		"✓ searches the corpus and writes a cited answer 1.27s",
		"command: npm test -- --seed=42",
		"7 passed, score 98.6, port 3002",
		"FAIL preserves this test name and exit code 17",
		"/tmp/dawn-demo-other/server 143widgets v1.27stable",
	].join("\n");

	assert.equal(
		normalizeLog(raw, { temporaryRoot }),
		[
			"PASS <workspace>/server/test/research.test.ts <time>",
			"✓ searches the corpus and writes a cited answer <time>",
			"command: npm test -- --seed=42",
			"7 passed, score 98.6, port 3002",
			"FAIL preserves this test name and exit code 17",
			"/tmp/dawn-demo-other/server 143widgets v1.27stable",
		].join("\n"),
	);
});

test("normalizeLog validates meaningful inputs", () => {
	assert.throws(
		() => normalizeLog(42, { temporaryRoot: "/tmp/demo" }),
		/log must be a string/,
	);
	assert.throws(
		() => normalizeLog("PASS", { temporaryRoot: "" }),
		/temporaryRoot/,
	);
});

test("stage exports a frozen canonical generated-path inventory", async () => {
	const { GENERATED_PATHS } = await import("./stage.mjs");
	assert.deepEqual(GENERATED_PATHS, [
		"server/src/app/research/index.ts",
		"server/src/app/research/state.ts",
		"server/src/app/research/plan.md",
		"server/src/tools/searchCorpus.ts",
		"server/test/research.test.ts",
	]);
	assert.equal(Object.isFrozen(GENERATED_PATHS), true);
});

test("author stage renders exactly the generated tree and escaped source", () => {
	const html = renderStage({
		act: "author",
		tree: GENERATED_TREE,
		primarySource: `const route = "<research>" && value > 1`,
		secondarySource: `return "<tool>" & result`,
		testLog: "unused",
	});

	assert.match(html, /^<!doctype html>/);
	assert.match(html, /Dawn/);
	for (const path of GENERATED_TREE)
		assert.match(html, new RegExp(path.replaceAll("/", "\\/")));
	assert.equal((html.match(/server\//g) ?? []).length, GENERATED_TREE.length);
	assert.match(html, /&lt;research&gt;/);
	assert.match(html, /value &gt; 1/);
	assert.match(html, /&lt;tool&gt;&quot; &amp; result/);
	assert.doesNotMatch(html, /<research>|<tool>/);
});

test("author stage keeps both real source panels in the 16:9 viewport", () => {
	const html = renderStage({
		act: "author",
		tree: GENERATED_TREE,
		primarySource: "export default agent({\n  model: 'gpt-5-mini',\n})",
		secondarySource: "export const searchCorpus = tool({})",
		testLog: "unused",
	});

	assert.match(
		html,
		/\.stack \{[^}]*grid-template-rows: repeat\(2, minmax\(0, 1fr\)\)/,
	);
	assert.match(html, /\.stack \.panel \{ min-height: 0; \}/);
	assert.match(html, /\.stack pre \{ height: calc\(100% - 44px\); \}/);
});

test("test stage renders escaped normalized npm test output", () => {
	const html = renderStage({
		act: "test",
		tree: GENERATED_TREE,
		primarySource: "unused",
		secondarySource: "unused",
		testLog: "PASS research <suite> & 7 tests",
	});

	assert.match(html, /Dawn/);
	assert.match(html, /npm test/);
	assert.match(
		html,
		/<pre><code>PASS research &lt;suite&gt; &amp; 7 tests<\/code><\/pre>/,
	);
	assert.doesNotMatch(html, /<suite>/);
});

test("close stage renders Dawn category, headline, and scaffold command", () => {
	const html = renderStage({
		act: "close",
		tree: GENERATED_TREE,
		primarySource: "unused",
		secondarySource: "unused",
		testLog: "unused",
	});

	assert.match(html, /TypeScript meta-framework for LangGraph\.js/);
	assert.match(html, /Build LangGraph agents like Next\.js apps/);
	assert.match(html, /npm create dawn-ai-app@latest my-agent/);
});

test("renderStage rejects unsupported acts and incomplete author input", () => {
	assert.throws(
		() =>
			renderStage({
				act: "intro",
				tree: GENERATED_TREE,
				primarySource: "a",
				secondarySource: "b",
			}),
		/act must be one of: author, test, close/,
	);
	assert.throws(
		() =>
			renderStage({
				act: "author",
				tree: [],
				primarySource: "a",
				secondarySource: "b",
			}),
		/tree must contain exactly/,
	);
});

class FakeChild extends EventEmitter {
	constructor(pid = 4321) {
		super();
		this.pid = pid;
		this.exitCode = null;
		this.signalCode = null;
	}

	exit(code = 0) {
		this.exitCode = code;
		this.emit("exit", code, null);
	}
}

class ExitDuringListenerChild extends FakeChild {
	once(event, listener) {
		if (event === "exit" && this.exitCode === null) this.exitCode = 23;
		return super.once(event, listener);
	}
}

test("encoder command owns and joins an aborted ffmpeg child", async () => {
	const child = new FakeChild(7654);
	const controller = new AbortController();
	const stopped = [];
	const command = runEncoderCommand("ffmpeg", ["-version"], {
		signal: controller.signal,
		spawn: () => child,
		stop: async (ownedChild) => {
			stopped.push(ownedChild.pid);
			ownedChild.exit(0);
		},
	});
	controller.abort(new Error("encoding cancelled"));
	await assert.rejects(command, /encoding cancelled/);
	assert.deepEqual(stopped, [7654]);
});

function manualTimers() {
	const scheduled = [];
	return {
		scheduled,
		timers: {
			setTimeout(callback, delay) {
				const handle = { callback, delay, cleared: false };
				scheduled.push(handle);
				return handle;
			},
			clearTimeout(handle) {
				handle.cleared = true;
			},
		},
	};
}

test("spawnManaged delegates one command to the injected spawn function", () => {
	const child = new FakeChild();
	const calls = [];
	const result = spawnManaged("npm", ["test"], {
		spawn(command, args, options) {
			calls.push({ command, args, options });
			return child;
		},
		options: { cwd: "/tmp/demo" },
	});

	assert.equal(result, child);
	assert.deepEqual(calls, [
		{
			command: "npm",
			args: ["test"],
			options: { cwd: "/tmp/demo", stdio: "pipe" },
		},
	]);
});

test("waitForHttp resolves when the injected fetch reports readiness", async () => {
	const child = new FakeChild();
	const { timers } = manualTimers();
	const calls = [];
	await waitForHttp("http://127.0.0.1:3002/health", child, {
		fetch: async (url) => {
			calls.push(url);
			return { ok: true };
		},
		timers,
		timeoutMs: 500,
		intervalMs: 10,
	});
	assert.deepEqual(calls, ["http://127.0.0.1:3002/health"]);
});

test("waitForHttp rejects when the managed child exits before readiness", async () => {
	const child = new FakeChild();
	const { timers } = manualTimers();
	const readiness = waitForHttp("http://127.0.0.1:3002/health", child, {
		fetch: async () => {
			throw new Error("not ready");
		},
		timers,
		timeoutMs: 500,
		intervalMs: 10,
	});
	child.exit(1);
	await assert.rejects(readiness, /exited before .* became ready.*code 1/);
});

test("waitForHttp rejects when the managed child already exited by signal", async () => {
	const child = new FakeChild();
	child.signalCode = "SIGTERM";
	let fetchCalls = 0;
	await assert.rejects(
		waitForHttp("http://127.0.0.1:3002/health", child, {
			fetch: async () => {
				fetchCalls += 1;
				return { ok: true };
			},
		}),
		/already exited with signal SIGTERM/,
	);
	assert.equal(fetchCalls, 0);
});

test("waitForHttp catches exit state that changes while its listener is installed", async () => {
	const child = new ExitDuringListenerChild();
	let fetchCalls = 0;
	await assert.rejects(
		waitForHttp("http://127.0.0.1:3002/health", child, {
			fetch: async () => {
				fetchCalls += 1;
				return { ok: true };
			},
		}),
		/already exited with code 23/,
	);
	assert.equal(fetchCalls, 0);
});

test("waitForHttp rejects on the injected readiness timeout", async () => {
	const child = new FakeChild();
	const { scheduled, timers } = manualTimers();
	const readiness = waitForHttp("http://127.0.0.1:3002/health", child, {
		fetch: async () => {
			throw new Error("not ready");
		},
		timers,
		timeoutMs: 500,
		intervalMs: 10,
	});
	const timeout = scheduled.find(({ delay }) => delay === 500);
	assert.ok(timeout);
	timeout.callback();
	await assert.rejects(readiness, /Timed out after 500ms waiting for/);
});

test("waitForHttp aborts an in-flight probe and removes readiness listeners", async () => {
	const child = new FakeChild();
	const { timers } = manualTimers();
	const controller = new AbortController();
	const cancellation = new Error("cancel readiness probe");
	let probeAborted = false;
	const readiness = waitForHttp("http://127.0.0.1:3002/health", child, {
		fetch: (_url, options) =>
			new Promise((_, reject) => {
				assert.equal(options.signal, controller.signal);
				options.signal.addEventListener(
					"abort",
					() => {
						probeAborted = true;
						reject(options.signal.reason);
					},
					{ once: true },
				);
			}),
		timers,
		timeoutMs: 500,
		intervalMs: 10,
		signal: controller.signal,
	});
	controller.abort(cancellation);

	await assert.rejects(readiness, (error) => error === cancellation);
	assert.equal(probeAborted, true);
	assert.equal(child.listenerCount("exit"), 0);
	assert.equal(child.listenerCount("error"), 0);
});

test("stopManaged sends SIGTERM and clears its timeout when the child exits", async () => {
	const child = new FakeChild(4321);
	const { scheduled, timers } = manualTimers();
	const signals = [];
	const stopped = stopManaged(child, {
		kill(pid, signal) {
			signals.push([pid, signal]);
		},
		timers,
		timeoutMs: 250,
	});
	assert.deepEqual(signals, [[4321, "SIGTERM"]]);
	child.exit(0);
	await stopped;
	assert.equal(scheduled[0]?.cleared, true);
	assert.deepEqual(signals, [[4321, "SIGTERM"]]);
});

test("stopManaged does not signal a child that already exited by signal", async () => {
	const child = new FakeChild(4321);
	child.signalCode = "SIGTERM";
	const signals = [];
	await stopManaged(child, {
		kill(pid, signal) {
			signals.push([pid, signal]);
		},
	});
	assert.deepEqual(signals, []);
});

test("stopManaged catches exit state that changes while its listener is installed", async () => {
	const child = new ExitDuringListenerChild(4321);
	const signals = [];
	await stopManaged(child, {
		kill(pid, signal) {
			signals.push([pid, signal]);
		},
	});
	assert.deepEqual(signals, []);
});

test("stopManaged waits for confirmed child close after escalating its known PID", async () => {
	const child = new FakeChild(9876);
	const { scheduled, timers } = manualTimers();
	const signals = [];
	let settled = false;
	const stopped = stopManaged(child, {
		kill(pid, signal) {
			signals.push([pid, signal]);
		},
		timers,
		timeoutMs: 250,
		confirmationTimeoutMs: 100,
	});
	void stopped.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	assert.equal(scheduled[0]?.delay, 250);
	scheduled[0].callback();
	await Promise.resolve();
	assert.deepEqual(signals, [
		[9876, "SIGTERM"],
		[9876, "SIGKILL"],
	]);
	assert.equal(settled, false);
	assert.equal(scheduled[1]?.delay, 100);
	child.emit("close", null, "SIGKILL");
	await stopped;
	assert.equal(settled, true);
});

test("stopManaged rejects when SIGKILL termination is not confirmed in time", async () => {
	const child = new FakeChild(9876);
	const { scheduled, timers } = manualTimers();
	const stopped = stopManaged(child, {
		kill() {},
		timers,
		timeoutMs: 250,
		confirmationTimeoutMs: 100,
	});
	scheduled[0].callback();
	assert.equal(scheduled[1]?.delay, 100);
	scheduled[1].callback();
	await assert.rejects(
		stopped,
		/Managed child PID 9876 did not exit within 100ms after SIGKILL/,
	);
});

const EXPECTED_ANSWER =
	"ReAct and plan-and-execute are common. [corpus/agent-architectures.md]";

function orchestrationFixture({ failAt } = {}) {
	const operations = [];
	const writes = [];
	const renames = [];
	const stopped = [];
	const childEnvironments = [];
	const workspaceRoot = "/tmp/dawn-demo-unit-abc123";
	const appRoot = `${workspaceRoot}/my-agent`;
	const server = { name: "server" };
	const workbench = { name: "workbench" };
	const aimock = {
		baseUrl: "http://127.0.0.1:4040/v1",
		async close() {
			operations.push("close aimock");
		},
	};
	let assignedPort = 4100;
	let monotonicNow = 0;

	const adapters = {
		commands: {
			async checkToolchain() {
				operations.push("check toolchain");
				return { node: "v24.19.0", pnpm: "10.33.0" };
			},
			async build() {
				operations.push("build");
			},
			async scaffold(options) {
				operations.push("scaffold --mode internal");
				assert.equal(options.appRoot, appRoot);
			},
			async install(options) {
				operations.push("install");
				assert.equal(options.appRoot, appRoot);
			},
			async test(options) {
				operations.push("npm test");
				assert.equal(options.appRoot, appRoot);
				return {
					stdout: [
						`\u001B[32mPASS\u001B[39m ${appRoot}/server/test/research.test.ts 143ms`,
						"\u2713 searches the corpus and writes a cited answer 1.27s",
						"Tests 7 passed",
					].join("\n"),
					stderr: "",
					exitCode: 0,
				};
			},
		},
		filesystem: {
			async mkdtemp() {
				return workspaceRoot;
			},
			async mkdir() {},
			async writeFile(path, contents) {
				writes.push({ path, contents });
				if (path.endsWith("capture-summary.json")) {
					operations.push("write summary");
				}
			},
			async rename(from, to) {
				renames.push({ from, to });
				operations.push("publish summary");
			},
			async readFile(path) {
				if (path.endsWith("server/src/app/research/index.ts")) {
					return "export default agent({ tools: [searchCorpus] })";
				}
				if (path.endsWith("server/src/tools/searchCorpus.ts")) {
					return "export default searchCorpus";
				}
				throw new Error(`unexpected read: ${path}`);
			},
			async rm(path) {
				operations.push(`remove ${path}`);
			},
		},
		processes: {
			async startAimock(fixtures) {
				operations.push("start aimock");
				assert.deepEqual(fixtures, DEMO_FIXTURES);
				return aimock;
			},
			async getPort(excluded) {
				const port = assignedPort++;
				assert.equal(excluded.has(port), false);
				operations.push(`assign port ${port}`);
				return port;
			},
			async startDawn(options) {
				operations.push("start Dawn server");
				assert.equal(options.cwd, `${appRoot}/server`);
				childEnvironments.push({ service: "server", env: options.env });
				return server;
			},
			async startWorkbench(options) {
				operations.push("start Workbench");
				assert.equal(options.cwd, `${appRoot}/web`);
				childEnvironments.push({ service: "workbench", env: options.env });
				return workbench;
			},
			async stop(child) {
				stopped.push(child);
				operations.push(`stop ${child.name}`);
			},
		},
		browser: {
			async open(options) {
				assert.deepEqual(options.viewport, { width: 1440, height: 810 });
				assert.match(
					options.recordingsDir,
					/docs\/brand\/demo\/raw-recordings\/runs\/[A-Za-z0-9_-]+$/,
				);
				return {
					async recordStage({ act, html }) {
						operations.push(`record ${act}`);
						if (act === "author") {
							for (const path of GENERATED_TREE)
								assert.match(html, new RegExp(path));
							assert.match(html, /export default agent\(\{/);
							assert.match(html, /searchCorpus/);
						}
						if (act === "test") {
							assert.match(
								html,
								/searches the corpus and writes a cited answer/,
							);
							assert.match(html, /Tests 7 passed/);
							assert.match(html, /&lt;workspace&gt;/);
							assert.doesNotMatch(html, /dawn-demo-unit-abc123/);
							assert.equal(html.includes("\u001B"), false);
						}
					},
					async runScenario(options) {
						operations.push("run Workbench scenario");
						assert.equal(options.prompt, DEMO_PROMPT);
						assert.deepEqual(options.tools, ["searchCorpus", "readDoc"]);
						assert.equal(options.answer, EXPECTED_ANSWER);
						if (failAt === "scenario") throw new Error("scenario failed");
						return { threadId: "thread-unit-1" };
					},
					async reloadAndRestore(options) {
						operations.push("reload");
						assert.equal(options.threadId, "thread-unit-1");
						assert.equal(options.answer, EXPECTED_ANSWER);
					},
					async recordRun() {
						operations.push("record run");
					},
					async close() {
						operations.push("close browser");
						return { videoPath: `${options.recordingsDir}/demo.webm` };
					},
				};
			},
		},
		timing: {
			now() {
				monotonicNow += 1;
				return monotonicNow;
			},
			async sleep() {},
		},
	};

	return {
		adapters,
		aimock,
		appRoot,
		childEnvironments,
		operations,
		renames,
		stopped,
		workspaceRoot,
		writes,
	};
}

test("capture orchestrates the real-product phases in exact order and cleans up", async () => {
	const fixture = orchestrationFixture();
	const result = await captureDemo({
		repoRoot: "/repo",
		parentEnv: { PATH: "/bin", HOME: "/home/test", LANG: "en_US.UTF-8" },
		adapters: fixture.adapters,
		recordOnly: true,
	});

	assert.deepEqual(fixture.operations, [
		"check toolchain",
		"build",
		"scaffold --mode internal",
		"install",
		"npm test",
		"start aimock",
		"assign port 4100",
		"start Dawn server",
		"assign port 4101",
		"start Workbench",
		"record author",
		"record test",
		"run Workbench scenario",
		"reload",
		"record run",
		"record close",
		"close browser",
		"publish summary",
		"stop workbench",
		"stop server",
		"close aimock",
		`remove ${fixture.workspaceRoot}`,
	]);
	assert.deepEqual(fixture.stopped, [
		{ name: "workbench" },
		{ name: "server" },
	]);
	assert.equal(result.threadId, "thread-unit-1");
	assert.equal(result.serverPort, 4100);
	assert.equal(result.workbenchPort, 4101);
});

test("capture stores raw test output only in ignored artifacts and stages normalized output", async () => {
	const fixture = orchestrationFixture();
	await captureDemo({
		repoRoot: "/repo",
		adapters: fixture.adapters,
		recordOnly: true,
	});

	const rawWrites = fixture.writes.filter(({ path }) =>
		/test\.(stdout|stderr|result)/.test(path),
	);
	assert.equal(rawWrites.length, 3);
	for (const write of rawWrites) {
		assert.match(write.path, /^\/repo\/docs\/brand\/demo\/artifacts\//);
	}
	assert.equal(
		fixture.writes.some(
			({ path }) => path.includes("raw-recordings") && path.endsWith(".log"),
		),
		false,
	);
});

test("capture finally closes owned resources and removes only its exact mkdtemp workspace", async () => {
	const fixture = orchestrationFixture({ failAt: "scenario" });
	await assert.rejects(
		captureDemo({
			repoRoot: "/repo",
			adapters: fixture.adapters,
			recordOnly: true,
		}),
		/scenario failed/,
	);
	assert.deepEqual(fixture.stopped, [
		{ name: "workbench" },
		{ name: "server" },
	]);
	assert.deepEqual(fixture.operations.slice(-5), [
		"close browser",
		"stop workbench",
		"stop server",
		"close aimock",
		`remove ${fixture.workspaceRoot}`,
	]);
	assert.equal(
		fixture.operations.some(
			(operation) =>
				operation.includes("/tmp") &&
				operation !== `remove ${fixture.workspaceRoot}`,
		),
		false,
	);
});

test("operational environment copies only the documented local-toolchain allowlist", () => {
	assert.deepEqual(
		sanitizeOperationalEnvironment({
			PATH: "/toolchain/bin",
			HOME: "/home/test",
			LANG: "en_US.UTF-8",
			LC_ALL: "C.UTF-8",
			LC_CTYPE: "C.UTF-8",
			TMPDIR: "/tmp/unit",
			TMP: "/tmp",
			TEMP: "/var/tmp",
			CI: "1",
			PNPM_HOME: "/cache/pnpm",
			COREPACK_HOME: "/cache/corepack",
			XDG_CACHE_HOME: "/cache/xdg",
			npm_config_cache: "/cache/npm",
			npm_config_store_dir: "/cache/pnpm-store",
			npm_config_userconfig: "/home/test/.npmrc",
			GITHUB_TOKEN: "github-secret",
			DATABASE_URL: "postgres://secret",
			CUSTOM_DEPLOY_SECRET: "custom-secret",
			OPENAI_API_KEY: "provider-secret",
		}),
		{
			PATH: "/toolchain/bin",
			HOME: "/home/test",
			LANG: "en_US.UTF-8",
			LC_ALL: "C.UTF-8",
			LC_CTYPE: "C.UTF-8",
			TMPDIR: "/tmp/unit",
			TMP: "/tmp",
			TEMP: "/var/tmp",
			CI: "1",
			PNPM_HOME: "/cache/pnpm",
			COREPACK_HOME: "/cache/corepack",
			XDG_CACHE_HOME: "/cache/xdg",
			npm_config_cache: "/cache/npm",
			npm_config_store_dir: "/cache/pnpm-store",
			npm_config_userconfig: "/home/test/.npmrc",
		},
	);
});

test("child environment allowlists operations before applying exact server overrides", () => {
	const environment = buildChildEnvironment(
		{
			PATH: "/toolchain/bin",
			HOME: "/home/test",
			LANG: "en_US.UTF-8",
			LC_ALL: "C.UTF-8",
			TMPDIR: "/tmp/unit",
			npm_config_cache: "/cache/npm",
			PNPM_HOME: "/cache/pnpm",
			GITHUB_TOKEN: "github-secret",
			DATABASE_URL: "postgres://secret",
			CUSTOM_DEPLOY_SECRET: "custom-secret",
			OPENAI_API_KEY: "openai-parent",
			OPENAI_BASE_URL: "https://api.openai.com/v1",
			ANTHROPIC_API_KEY: "anthropic-parent",
			ANTHROPIC_BASE_URL: "https://api.anthropic.com",
			GOOGLE_API_KEY: "google-parent",
			GOOGLE_GENERATIVE_AI_BASE_URL: "https://google.example",
			AZURE_OPENAI_API_KEY: "azure-parent",
			AZURE_OPENAI_ENDPOINT: "https://azure.example",
			AWS_ACCESS_KEY_ID: "aws-parent",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
			AWS_SESSION_TOKEN: "aws-token",
			AWS_BEDROCK_ENDPOINT: "https://bedrock.example",
			LANGCHAIN_TRACING_V2: "true",
			LANGSMITH_TRACING: "true",
		},
		"http://127.0.0.1:4040/v1",
	);

	for (const key of [
		"PATH",
		"HOME",
		"LANG",
		"LC_ALL",
		"TMPDIR",
		"npm_config_cache",
		"PNPM_HOME",
	]) {
		assert.ok(key in environment, `${key} must be preserved`);
	}
	assert.deepEqual(
		Object.fromEntries(
			[
				"OPENAI_BASE_URL",
				"OPENAI_API_KEY",
				"COPILOTKIT_TELEMETRY_DISABLED",
				"DO_NOT_TRACK",
			].map((key) => [key, environment[key]]),
		),
		{
			OPENAI_BASE_URL: "http://127.0.0.1:4040/v1",
			OPENAI_API_KEY: "test-not-used",
			COPILOTKIT_TELEMETRY_DISABLED: "true",
			DO_NOT_TRACK: "1",
		},
	);
	assert.equal(environment.npm_config_package, "@dawn-ai/cli");
	for (const key of [
		"GITHUB_TOKEN",
		"DATABASE_URL",
		"CUSTOM_DEPLOY_SECRET",
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_BASE_URL",
		"GOOGLE_API_KEY",
		"GOOGLE_GENERATIVE_AI_BASE_URL",
		"AZURE_OPENAI_API_KEY",
		"AZURE_OPENAI_ENDPOINT",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_BEDROCK_ENDPOINT",
		"LANGCHAIN_TRACING_V2",
		"LANGSMITH_TRACING",
	]) {
		assert.equal(environment[key], undefined, `${key} must be stripped`);
	}
});

test("capture gives both services sanitized environments and only Dawn receives model overrides", async () => {
	const fixture = orchestrationFixture();
	await captureDemo({
		repoRoot: "/repo",
		parentEnv: {
			PATH: "/toolchain/bin",
			npm_config_userconfig: "/home/test/.npmrc",
			GITHUB_TOKEN: "parent-github",
			DATABASE_URL: "postgres://parent-secret",
			CUSTOM_DEPLOY_SECRET: "parent-custom",
			OPENAI_API_KEY: "parent-openai",
			ANTHROPIC_API_KEY: "parent-anthropic",
			GOOGLE_API_KEY: "parent-google",
			AZURE_OPENAI_API_KEY: "parent-azure",
			AWS_SECRET_ACCESS_KEY: "parent-aws",
		},
		adapters: fixture.adapters,
		recordOnly: true,
	});

	const serverEnvironment = fixture.childEnvironments.find(
		({ service }) => service === "server",
	)?.env;
	const workbenchEnvironment = fixture.childEnvironments.find(
		({ service }) => service === "workbench",
	)?.env;
	assert.deepEqual(
		Object.fromEntries(
			[
				"OPENAI_BASE_URL",
				"OPENAI_API_KEY",
				"COPILOTKIT_TELEMETRY_DISABLED",
				"DO_NOT_TRACK",
			].map((key) => [key, serverEnvironment?.[key]]),
		),
		{
			OPENAI_BASE_URL: "http://127.0.0.1:4040/v1",
			OPENAI_API_KEY: "test-not-used",
			COPILOTKIT_TELEMETRY_DISABLED: "true",
			DO_NOT_TRACK: "1",
		},
	);
	assert.equal(workbenchEnvironment?.DAWN_SERVER_URL, "http://127.0.0.1:4100");
	assert.equal(workbenchEnvironment?.NEXT_TELEMETRY_DISABLED, "1");
	assert.equal(serverEnvironment?.npm_config_package, "@dawn-ai/cli");
	assert.equal(workbenchEnvironment?.OPENAI_API_KEY, undefined);
	for (const environment of [serverEnvironment, workbenchEnvironment]) {
		assert.equal(environment?.PATH, "/toolchain/bin");
		assert.equal(environment?.npm_config_userconfig, "/home/test/.npmrc");
		for (const key of [
			"GITHUB_TOKEN",
			"DATABASE_URL",
			"CUSTOM_DEPLOY_SECRET",
			"ANTHROPIC_API_KEY",
			"GOOGLE_API_KEY",
			"AZURE_OPENAI_API_KEY",
			"AWS_SECRET_ACCESS_KEY",
		]) {
			assert.equal(environment?.[key], undefined);
		}
	}
});

test("model base URL accepts loopback HTTP(S) and rejects public or unsafe URLs", () => {
	assert.equal(
		assertLoopbackModelBaseUrl("http://127.0.0.1:4040/v1").href,
		"http://127.0.0.1:4040/v1",
	);
	assert.equal(
		assertLoopbackModelBaseUrl("https://[::1]:4040/v1").hostname,
		"[::1]",
	);
	for (const unsafe of [
		"https://api.openai.com/v1",
		"http://192.168.1.20:4040/v1",
		"file:///tmp/mock",
		"not a URL",
	]) {
		assert.throws(
			() => assertLoopbackModelBaseUrl(unsafe),
			/loopback HTTP\(S\)/,
		);
	}
});

test("available-port helper asks node:net for an ephemeral loopback port", async () => {
	const calls = [];
	const fakeServer = new EventEmitter();
	fakeServer.unref = () => calls.push("unref");
	fakeServer.address = () => ({
		address: "127.0.0.1",
		family: "IPv4",
		port: 45678,
	});
	fakeServer.listen = (options, callback) => {
		calls.push(["listen", options]);
		callback();
	};
	fakeServer.close = (callback) => {
		calls.push("close");
		callback();
	};

	assert.equal(
		await getAvailableLoopbackPort({ createServer: () => fakeServer }),
		45678,
	);
	assert.deepEqual(calls, [
		["listen", { host: "127.0.0.1", port: 0, exclusive: true }],
		"unref",
		"close",
	]);
});

test("assigned-port startup retries only EADDRINUSE with fresh distinct ports", async () => {
	const assigned = [4100, 4101, 4102];
	const starts = [];
	const result = await startWithAssignedPort({
		service: "Dawn server",
		excludedPorts: new Set([3002, 3010]),
		getPort: async () => assigned.shift(),
		start: async (port) => {
			starts.push(port);
			if (starts.length < 3)
				throw Object.assign(new Error("address busy"), { code: "EADDRINUSE" });
			return { child: { name: "server" }, port };
		},
	});
	assert.deepEqual(starts, [4100, 4101, 4102]);
	assert.equal(result.port, 4102);
});

test("assigned-port startup never retries other errors or more than three bind races", async () => {
	let calls = 0;
	await assert.rejects(
		startWithAssignedPort({
			service: "Workbench",
			excludedPorts: new Set([3002, 3010]),
			getPort: async () => 4200 + calls,
			start: async () => {
				calls += 1;
				throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
			},
		}),
		/boom/,
	);
	assert.equal(calls, 1);

	calls = 0;
	await assert.rejects(
		startWithAssignedPort({
			service: "Workbench",
			excludedPorts: new Set([3002, 3010]),
			getPort: async () => 4300 + calls,
			start: async () => {
				calls += 1;
				throw Object.assign(new Error("address busy"), { code: "EADDRINUSE" });
			},
		}),
		/after 3 EADDRINUSE attempts/,
	);
	assert.equal(calls, 3);
});

test("capture CLI accepts pnpm's forwarded separator before --record-only", () => {
	assert.deepEqual(parseCaptureArguments(["--", "--record-only"]), {
		recordOnly: true,
	});
	assert.throws(
		() => parseCaptureArguments(["--", "--unexpected"]),
		/Unknown capture argument/,
	);
});

test("toolchain validation accepts the repository Node floor and records actual patches", () => {
	assert.deepEqual(
		validateToolchainVersions({ node: "v24.0.0", pnpm: "10.33.0" }),
		{ node: "v24.0.0", pnpm: "10.33.0" },
	);
	assert.deepEqual(
		validateToolchainVersions({ node: "v25.4.1", pnpm: "10.33.0" }),
		{ node: "v25.4.1", pnpm: "10.33.0" },
	);
	assert.throws(
		() => validateToolchainVersions({ node: "v23.11.0", pnpm: "10.33.0" }),
		/Node >=24\.0\.0/,
	);
	assert.throws(
		() => validateToolchainVersions({ node: "v24.19.0", pnpm: "10.32.0" }),
		/pnpm 10\.33\.0/,
	);
});

test("run ids accept focused safe names and reject traversal", () => {
	assert.equal(validateRunId("run-2026_09_01"), "run-2026_09_01");
	for (const unsafe of ["", ".", "..", "../escape", "nested/run", "run.id"])
		assert.throws(() => validateRunId(unsafe), /run id/);
});

test("generated npm test command enables the real runner's verbose named-test output", () => {
	assert.deepEqual(generatedTestCommand(), {
		command: "npm",
		args: ["test", "--", "--", "--reporter=verbose"],
	});
});

test("internal scaffold installation uses its pnpm workspace so Workbench resolves local packages", () => {
	assert.deepEqual(generatedInstallCommand(), {
		command: "pnpm",
		args: ["install"],
	});
});

test("Workbench capture waits for the active rail row before filling the keyed composer", async () => {
	const calls = [];
	const page = {
		getByRole(role, options) {
			if (role === "button" && options.name === "New conversation") {
				return {
					async waitFor(waitOptions) {
						calls.push(["active row", waitOptions]);
					},
				};
			}
			if (role === "textbox" && options.name === "Message") {
				return {
					async fill(value) {
						calls.push(["fill", value]);
					},
				};
			}
			throw new Error(`unexpected locator: ${role} ${options.name}`);
		},
	};

	await fillActiveWorkbenchComposer(page, DEMO_PROMPT);
	assert.deepEqual(calls, [
		["active row", { state: "visible", timeout: 60_000 }],
		["fill", DEMO_PROMPT],
	]);
});

test("Workbench capture arms and verifies CopilotKit runtime readiness before interaction", async () => {
	const calls = [];
	let responsePredicate;
	const response = {
		ok: () => true,
		request: () => ({ method: () => "GET" }),
		url: () => "http://127.0.0.1:4101/api/copilotkit/info",
	};
	const page = {
		waitForResponse(predicate, options) {
			responsePredicate = predicate;
			calls.push(["arm response", options]);
			return Promise.resolve(response);
		},
		async goto(url, options) {
			calls.push(["goto", url, options]);
		},
	};

	await openReadyWorkbench(page, "http://127.0.0.1:4101");
	assert.equal(responsePredicate(response), true);
	assert.deepEqual(calls, [
		["arm response", { timeout: 60_000 }],
		["goto", "http://127.0.0.1:4101", { waitUntil: "domcontentloaded" }],
	]);
});

test("failed Workbench navigation handles its later readiness rejection and closes once", async () => {
	const fixture = orchestrationFixture();
	const originalOpen = fixture.adapters.browser.open;
	const navigationError = new Error("Workbench navigation failed");
	const readinessError = new Error("readiness waiter closed later");
	const unhandled = [];
	let rejectReadiness;
	let closeCount = 0;
	const onUnhandled = (error) => unhandled.push(error);
	process.on("unhandledRejection", onUnhandled);
	try {
		fixture.adapters.browser.open = async (options) => {
			const session = await originalOpen(options);
			session.runScenario = ({ url }) =>
				openReadyWorkbench(
					{
						waitForResponse() {
							return new Promise((_, reject) => {
								rejectReadiness = reject;
							});
						},
						async goto() {
							throw navigationError;
						},
					},
					url,
				);
			session.close = async () => {
				closeCount += 1;
				fixture.operations.push("close browser");
			};
			return session;
		};

		await assert.rejects(
			captureDemo({
				repoRoot: "/repo",
				adapters: fixture.adapters,
				recordOnly: true,
				runIdFactory: () => "run-navigation-waiter-failure",
			}),
			(error) => error === navigationError,
		);
		rejectReadiness(readinessError);
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepEqual(unhandled, []);
		assert.equal(closeCount, 1);
		assert.equal(
			fixture.operations.indexOf("close browser") <
				fixture.operations.indexOf("stop workbench"),
			true,
		);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("Workbench completion waits for Stop to leave and the real composer to return", async () => {
	const calls = [];
	const page = {
		getByRole(role, options) {
			if (role === "button" && options.name === "Stop") {
				return {
					async waitFor(waitOptions) {
						calls.push(["stop", waitOptions]);
					},
				};
			}
			if (role === "button" && options.name === "Send") {
				return {
					async waitFor(waitOptions) {
						calls.push(["send", waitOptions]);
					},
				};
			}
			if (role === "textbox" && options.name === "Message") {
				return {
					async fill(value, fillOptions) {
						calls.push(["composer", value, fillOptions]);
					},
				};
			}
			throw new Error(`unexpected role: ${role}`);
		},
	};

	await waitForWorkbenchRunCompletion(page);
	assert.deepEqual(calls, [
		["stop", { state: "hidden", timeout: 120_000 }],
		["send", { state: "visible", timeout: 120_000 }],
		["composer", "", { timeout: 120_000 }],
	]);
});

test("restoration scopes state GET to Workbench and proves canonical transcript evidence", async () => {
	const calls = [];
	let responsePredicate;
	const stateUrl = "http://127.0.0.1:4101/api/dawn/threads/thread-unit-1/state";
	const response = {
		ok: () => true,
		status: () => 200,
		request: () => ({ method: () => "GET" }),
		url: () => stateUrl,
		async finished() {
			calls.push("response finished");
		},
	};
	const transcript = {
		getByText(text, options) {
			return {
				last() {
					return {
						async waitFor(waitOptions) {
							calls.push(["transcript", text, options, waitOptions]);
						},
					};
				},
			};
		},
	};
	const page = {
		waitForResponse(predicate, options) {
			responsePredicate = predicate;
			calls.push(["arm state", options]);
			return Promise.resolve(response);
		},
		async reload(options) {
			calls.push(["reload", options]);
		},
		getByRole(role, options) {
			if (role === "main") return transcript;
			if (role === "button" && options.name === DEMO_PROMPT) {
				return {
					async waitFor(waitOptions) {
						calls.push(["row", waitOptions]);
					},
					async click() {
						calls.push("click row");
					},
					async getAttribute(name) {
						calls.push(["attribute", name]);
						return "true";
					},
				};
			}
			throw new Error(`unexpected role: ${role}`);
		},
	};

	const result = await restoreWorkbenchThread(page, {
		workbenchUrl: "http://127.0.0.1:4101",
		threadId: "thread-unit-1",
		prompt: DEMO_PROMPT,
		tools: ["searchCorpus", "readDoc"],
		answer: EXPECTED_ANSWER,
	});
	assert.equal(responsePredicate(response), true);
	assert.equal(
		responsePredicate({
			...response,
			url: () => "http://public.example/api/dawn/threads/thread-unit-1/state",
		}),
		false,
	);
	assert.equal(result.stateUrl, stateUrl);
	for (const evidence of [
		DEMO_PROMPT,
		"searchCorpus",
		"readDoc",
		EXPECTED_ANSWER,
	]) {
		assert.equal(
			calls.some(
				(call) =>
					Array.isArray(call) &&
					call[0] === "transcript" &&
					call[1] === evidence,
			),
			true,
		);
	}
});

test("failed restoration interaction handles its later state rejection and closes once", async () => {
	const fixture = orchestrationFixture();
	const originalOpen = fixture.adapters.browser.open;
	const reloadError = new Error("Workbench reload failed");
	const stateError = new Error("state waiter closed later");
	const unhandled = [];
	let rejectState;
	let closeCount = 0;
	const onUnhandled = (error) => unhandled.push(error);
	process.on("unhandledRejection", onUnhandled);
	try {
		fixture.adapters.browser.open = async (options) => {
			const session = await originalOpen(options);
			session.reloadAndRestore = (restoreOptions) =>
				restoreWorkbenchThread(
					{
						waitForResponse() {
							return new Promise((_, reject) => {
								rejectState = reject;
							});
						},
						async reload() {
							throw reloadError;
						},
					},
					restoreOptions,
				);
			session.close = async () => {
				closeCount += 1;
				fixture.operations.push("close browser");
			};
			return session;
		};

		await assert.rejects(
			captureDemo({
				repoRoot: "/repo",
				adapters: fixture.adapters,
				recordOnly: true,
				runIdFactory: () => "run-restoration-waiter-failure",
			}),
			(error) => error === reloadError,
		);
		rejectState(stateError);
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepEqual(unhandled, []);
		assert.equal(closeCount, 1);
		assert.equal(
			fixture.operations.indexOf("close browser") <
				fixture.operations.indexOf("stop workbench"),
			true,
		);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("managed-child registry retains a child whose stop fails and retries it during final cleanup", async () => {
	const child = { name: "failed-start" };
	const unrelated = { name: "unrelated" };
	const calls = [];
	let attempt = 0;
	const registry = createManagedChildRegistry(async (candidate) => {
		calls.push(candidate);
		attempt += 1;
		if (attempt === 1) throw new Error("first stop failed");
	});
	registry.track(child);
	await assert.rejects(registry.stop(child), /first stop failed/);
	await registry.stopRemaining();
	assert.deepEqual(calls, [child, child]);
	assert.equal(calls.includes(unrelated), false);
});

test("managed command cancellation stops and confirms its exact owned child", async () => {
	const child = new EventEmitter();
	child.pid = 8123;
	child.exitCode = null;
	child.signalCode = null;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdout.setEncoding = () => {};
	child.stderr.setEncoding = () => {};
	const stopped = [];
	const registry = createManagedChildRegistry(async (candidate) => {
		stopped.push(candidate);
		candidate.signalCode = "SIGTERM";
	});
	const controller = new AbortController();
	const cancellation = new Error("cancel build now");
	const command = runManagedCommand("pnpm", ["build"], {
		cwd: "/repo",
		childRegistry: registry,
		signal: controller.signal,
		spawn: () => child,
	});
	controller.abort(cancellation);

	await assert.rejects(command, (error) => error === cancellation);
	assert.deepEqual(stopped, [child]);
	await registry.stopRemaining();
	assert.deepEqual(stopped, [child]);
});

test("service readiness cancellation stops the just-started child exactly once", async () => {
	const child = new EventEmitter();
	child.exitCode = null;
	child.signalCode = null;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdout.setEncoding = () => {};
	child.stderr.setEncoding = () => {};
	const stopped = [];
	const registry = createManagedChildRegistry(async (candidate) => {
		stopped.push(candidate);
	});
	const controller = new AbortController();
	const cancellation = new Error("cancel readiness now");
	const starting = startHttpService({
		command: "npm",
		args: ["exec", "--", "dawn", "dev"],
		cwd: "/repo/server",
		env: { PATH: "/bin" },
		readyUrl: "http://127.0.0.1:4100/healthz",
		service: "Dawn server",
		childRegistry: registry,
		signal: controller.signal,
		spawn: () => child,
		waitUntilReady(_url, candidate, options) {
			assert.equal(candidate, child);
			assert.equal(options.signal, controller.signal);
			return new Promise((_, reject) => {
				options.signal.addEventListener(
					"abort",
					() => reject(options.signal.reason),
					{ once: true },
				);
			});
		},
	});
	controller.abort(cancellation);

	await assert.rejects(starting, (error) => error.cause === cancellation);
	assert.deepEqual(stopped, [child]);
	await registry.stopRemaining();
	assert.deepEqual(stopped, [child]);
});

test("managed-service monitor reports post-readiness exit with bounded transcript", async () => {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdout.setEncoding = () => {};
	child.stderr.setEncoding = () => {};
	const monitor = createManagedServiceMonitor({
		child,
		service: "Workbench",
		maxTranscriptLength: 40,
	});
	monitor.arm();
	child.stdout.emit("data", "prefix-that-must-be-truncated-");
	child.stderr.emit("data", "fatal-tail-from-workbench");
	child.emit("exit", 7, null);
	await assert.rejects(monitor.unexpectedExit, (error) => {
		assert.match(error.message, /Workbench exited unexpectedly \(code 7\)/);
		assert.match(error.message, /fatal-tail-from-workbench/);
		assert.equal(error.message.includes("prefix-that-must"), false);
		return true;
	});
});

test("expected managed-service cleanup cannot win a capture-phase race", async () => {
	const child = new EventEmitter();
	const monitor = createManagedServiceMonitor({
		child,
		service: "Dawn server",
	});
	monitor.arm();
	monitor.markExpectedExit();
	child.emit("exit", 0, null);
	assert.equal(
		await raceCapturePhase("close", async () => "phase complete", [monitor]),
		"phase complete",
	);
});

test("capture phase fails promptly when a ready service exits", async () => {
	const serviceFailure = Promise.reject(
		new Error("Dawn server exited unexpectedly (signal SIGTERM)\nserver-tail"),
	);
	serviceFailure.catch(() => {});
	await assert.rejects(
		raceCapturePhase("restoration", () => new Promise(() => {}), [
			{ unexpectedExit: serviceFailure },
		]),
		/Dawn server exited unexpectedly.*server-tail/s,
	);
});

test("capture signal handlers abort once, force on the second signal, and restore", () => {
	const calls = [];
	const handlers = new Map();
	const signalAdapter = {
		on(signal, handler) {
			calls.push(["on", signal]);
			handlers.set(signal, handler);
		},
		off(signal, handler) {
			calls.push(["off", signal]);
			assert.equal(handlers.get(signal), handler);
			handlers.delete(signal);
		},
		forceExit(signal) {
			calls.push(["force", signal]);
		},
	};
	const scope = installCaptureSignalHandlers({ signalAdapter });
	handlers.get("SIGINT")();
	assert.equal(scope.signal.aborted, true);
	assert.match(scope.signal.reason.message, /cancelled by SIGINT/);
	handlers.get("SIGTERM")();
	scope.restore();
	assert.deepEqual(calls, [
		["on", "SIGINT"],
		["on", "SIGTERM"],
		["force", "SIGTERM"],
		["off", "SIGINT"],
		["off", "SIGTERM"],
	]);
});

function captureSignalFixture() {
	const calls = [];
	const handlers = new Map();
	return {
		calls,
		handlers,
		adapter: {
			on(signal, handler) {
				calls.push(["on", signal]);
				handlers.set(signal, handler);
			},
			off(signal, handler) {
				calls.push(["off", signal]);
				assert.equal(handlers.get(signal), handler);
				handlers.delete(signal);
			},
			forceExit() {
				throw new Error("force exit must not run for one signal");
			},
		},
	};
}

test("SIGTERM during build aborts the command owner before capture restores handlers", {
	timeout: 1_000,
}, async () => {
	const fixture = orchestrationFixture();
	const signals = captureSignalFixture();
	let commandSettled = false;
	fixture.adapters.commands.build = ({ signal }) =>
		new Promise((_, reject) => {
			signal.addEventListener(
				"abort",
				() => {
					fixture.operations.push("abort build child");
					commandSettled = true;
					reject(signal.reason);
				},
				{ once: true },
			);
			queueMicrotask(() => signals.handlers.get("SIGTERM")());
		});
	fixture.adapters.commands.stopRemaining = async () => {
		fixture.operations.push("confirm command children stopped");
	};

	await assert.rejects(
		captureDemo({
			repoRoot: "/repo",
			adapters: fixture.adapters,
			recordOnly: true,
			runIdFactory: () => "run-cancel-build",
			signalAdapter: signals.adapter,
		}),
		/cancelled by SIGTERM/,
	);
	assert.equal(commandSettled, true);
	assert.equal(
		fixture.operations.includes("confirm command children stopped"),
		true,
	);
	assert.equal(signals.handlers.size, 0);
});

test("SIGTERM during Dawn readiness aborts and confirms the startup child before cleanup", {
	timeout: 1_000,
}, async () => {
	const fixture = orchestrationFixture();
	const signals = captureSignalFixture();
	let startupSettled = false;
	fixture.adapters.processes.startDawn = ({ signal }) =>
		new Promise((_, reject) => {
			signal.addEventListener(
				"abort",
				() => {
					fixture.operations.push("stop startup child");
					startupSettled = true;
					reject(signal.reason);
				},
				{ once: true },
			);
			queueMicrotask(() => signals.handlers.get("SIGTERM")());
		});

	await assert.rejects(
		captureDemo({
			repoRoot: "/repo",
			adapters: fixture.adapters,
			recordOnly: true,
			runIdFactory: () => "run-cancel-readiness",
			signalAdapter: signals.adapter,
		}),
		/cancelled by SIGTERM/,
	);
	assert.equal(startupSettled, true);
	assert.equal(fixture.operations.includes("stop startup child"), true);
	assert.equal(fixture.operations.includes("close aimock"), true);
	assert.equal(
		fixture.operations.includes(`remove ${fixture.workspaceRoot}`),
		true,
	);
	assert.equal(signals.handlers.size, 0);
});

test("capture awaits and closes a browser session acquired after cancellation", {
	timeout: 1_000,
}, async () => {
	const fixture = orchestrationFixture();
	const signals = captureSignalFixture();
	let resolveAcquisition;
	let captureSettled = false;
	let closeCount = 0;
	const lateSession = {
		async close() {
			closeCount += 1;
			fixture.operations.push("close late browser");
		},
	};
	fixture.adapters.browser.open = ({ signal }) => {
		assert.ok(signal instanceof AbortSignal);
		queueMicrotask(() => signals.handlers.get("SIGINT")());
		return new Promise((resolve) => {
			resolveAcquisition = resolve;
		});
	};

	const outcome = captureDemo({
		repoRoot: "/repo",
		adapters: fixture.adapters,
		recordOnly: true,
		runIdFactory: () => "run-late-browser",
		signalAdapter: signals.adapter,
	})
		.then(() => ({ status: "fulfilled" }))
		.catch((error) => ({ error, status: "rejected" }))
		.finally(() => {
			captureSettled = true;
		});
	await new Promise((resolve) => setImmediate(resolve));
	const settledBeforeAcquisition = captureSettled;
	resolveAcquisition(lateSession);
	const result = await outcome;

	assert.equal(settledBeforeAcquisition, false);
	assert.equal(result.status, "rejected");
	assert.match(result.error.message, /cancelled by SIGINT/);
	assert.equal(closeCount, 1);
	assert.equal(
		fixture.operations.indexOf("close late browser") <
			fixture.operations.indexOf("stop workbench"),
		true,
	);
	assert.equal(signals.handlers.size, 0);
});

test("capture closes the browser and awaits an aborted session action before service cleanup", {
	timeout: 1_000,
}, async () => {
	const fixture = orchestrationFixture();
	const signals = captureSignalFixture();
	const originalOpen = fixture.adapters.browser.open;
	let rejectAction;
	let closeCount = 0;
	let captureSettled = false;
	fixture.adapters.browser.open = async (options) => {
		const session = await originalOpen(options);
		session.runScenario = ({ signal }) =>
			new Promise((_, reject) => {
				rejectAction = () => {
					fixture.operations.push("session action settled");
					reject(signal.reason);
				};
				signal.addEventListener(
					"abort",
					() => fixture.operations.push("session action observed abort"),
					{ once: true },
				);
				queueMicrotask(() => signals.handlers.get("SIGINT")());
			});
		session.close = async () => {
			closeCount += 1;
			fixture.operations.push("close browser");
		};
		return session;
	};

	const outcome = captureDemo({
		repoRoot: "/repo",
		adapters: fixture.adapters,
		recordOnly: true,
		runIdFactory: () => "run-session-action-cancel",
		signalAdapter: signals.adapter,
	})
		.then(() => ({ status: "fulfilled" }))
		.catch((error) => ({ error, status: "rejected" }))
		.finally(() => {
			captureSettled = true;
		});
	await new Promise((resolve) => setImmediate(resolve));
	const settledBeforeAction = captureSettled;
	const stoppedBeforeAction = fixture.operations.includes("stop workbench");
	rejectAction();
	const result = await outcome;

	assert.equal(settledBeforeAction, false);
	assert.equal(stoppedBeforeAction, false);
	assert.equal(result.status, "rejected");
	assert.match(result.error.message, /cancelled by SIGINT/);
	assert.equal(closeCount, 1);
	assert.equal(
		fixture.operations.indexOf("session action settled") <
			fixture.operations.indexOf("stop workbench"),
		true,
	);
	assert.equal(signals.handlers.size, 0);
});

test("capture retains and awaits its memoized browser finalization after cancellation", {
	timeout: 1_000,
}, async () => {
	const fixture = orchestrationFixture();
	const signals = captureSignalFixture();
	const originalOpen = fixture.adapters.browser.open;
	let resolveFinalization;
	let closeCount = 0;
	let captureSettled = false;
	fixture.adapters.browser.open = async (options) => {
		const session = await originalOpen(options);
		let closePromise;
		session.close = () => {
			closeCount += 1;
			fixture.operations.push("begin browser finalization");
			queueMicrotask(() => signals.handlers.get("SIGTERM")());
			closePromise ??= new Promise((resolve) => {
				resolveFinalization = () => {
					fixture.operations.push("browser finalization settled");
					resolve({ videoPath: `${options.recordingsDir}/demo.webm` });
				};
			});
			return closePromise;
		};
		return session;
	};

	const outcome = captureDemo({
		repoRoot: "/repo",
		adapters: fixture.adapters,
		recordOnly: true,
		runIdFactory: () => "run-finalization-cancel",
		signalAdapter: signals.adapter,
	})
		.then(() => ({ status: "fulfilled" }))
		.catch((error) => ({ error, status: "rejected" }))
		.finally(() => {
			captureSettled = true;
		});
	await new Promise((resolve) => setImmediate(resolve));
	const settledBeforeFinalization = captureSettled;
	const stoppedBeforeFinalization =
		fixture.operations.includes("stop workbench");
	resolveFinalization();
	const result = await outcome;

	assert.equal(settledBeforeFinalization, false);
	assert.equal(stoppedBeforeFinalization, false);
	assert.equal(result.status, "rejected");
	assert.match(result.error.message, /cancelled by SIGTERM/);
	assert.equal(closeCount, 1);
	assert.equal(
		fixture.operations.indexOf("browser finalization settled") <
			fixture.operations.indexOf("stop workbench"),
		true,
	);
	assert.equal(signals.handlers.size, 0);
});

test("browser cleanup always closes Chromium even when context finalization fails", async () => {
	const calls = [];
	await assert.rejects(
		closeBrowserResources({
			context: {
				async close() {
					calls.push("context");
					throw new Error("context failed");
				},
			},
			video: {
				async path() {
					calls.push("video");
					return "/ignored/demo.webm";
				},
			},
			browser: {
				async close() {
					calls.push("browser");
				},
			},
		}),
		/context failed/,
	);
	assert.deepEqual(calls, ["context", "video", "browser"]);
});

test("browser acquisition closes Chromium when context creation fails", async () => {
	const calls = [];
	const acquisitionError = new Error("context creation failed");
	const chromium = {
		async launch() {
			calls.push("launch");
			return {
				async newContext() {
					calls.push("new context");
					throw acquisitionError;
				},
				async close() {
					calls.push("close browser");
				},
			};
		},
	};

	await assert.rejects(
		createBrowserResources({
			chromium,
			recordingsDir: "/ignored/raw-recordings",
			viewport: { width: 1440, height: 810 },
		}),
		(error) => {
			assert.equal(error, acquisitionError);
			return true;
		},
	);
	assert.deepEqual(calls, ["launch", "new context", "close browser"]);
});

test("browser acquisition rolls back a late Chromium launch after abort", async () => {
	const calls = [];
	const controller = new AbortController();
	const cancellation = new Error("cancel browser launch");
	let resolveLaunch;
	const browser = {
		async newContext() {
			calls.push("new context");
			throw new Error("context must not start after cancellation");
		},
		async close() {
			calls.push("close browser");
		},
	};
	const acquiring = createBrowserResources({
		chromium: {
			launch() {
				calls.push("launch");
				return new Promise((resolve) => {
					resolveLaunch = resolve;
				});
			},
		},
		recordingsDir: "/ignored/raw-recordings",
		viewport: { width: 1440, height: 810 },
		signal: controller.signal,
	});
	controller.abort(cancellation);
	resolveLaunch(browser);

	await assert.rejects(acquiring, (error) => error === cancellation);
	assert.deepEqual(calls, ["launch", "close browser"]);
});

test("browser acquisition closes context then Chromium when page creation fails", async () => {
	const calls = [];
	const acquisitionError = new Error("page creation failed");
	const chromium = {
		async launch() {
			calls.push("launch");
			return {
				async newContext() {
					calls.push("new context");
					return {
						async newPage() {
							calls.push("new page");
							throw acquisitionError;
						},
						async close() {
							calls.push("close context");
						},
					};
				},
				async close() {
					calls.push("close browser");
				},
			};
		},
	};

	await assert.rejects(
		createBrowserResources({
			chromium,
			recordingsDir: "/ignored/raw-recordings",
			viewport: { width: 1440, height: 810 },
		}),
		(error) => {
			assert.equal(error, acquisitionError);
			return true;
		},
	);
	assert.deepEqual(calls, [
		"launch",
		"new context",
		"new page",
		"close context",
		"close browser",
	]);
});

test("capture invokes the future encoder after finalizing recordings and summary", async () => {
	const fixture = orchestrationFixture();
	await captureDemo({
		repoRoot: "/repo",
		adapters: fixture.adapters,
		recordOnly: false,
		runIdFactory: () => "run-unit-encode",
		async encodeCaptureArtifacts(options) {
			fixture.operations.push("encode capture");
			assert.ok(options.signal instanceof AbortSignal);
			assert.equal(
				options.summaryPath,
				"/repo/docs/brand/demo/artifacts/runs/run-unit-encode/capture-summary.json",
			);
			assert.equal(
				options.summary.videoPath,
				"/repo/docs/brand/demo/raw-recordings/runs/run-unit-encode/demo.webm",
			);
		},
	});

	assert.deepEqual(fixture.operations.slice(-7), [
		"close browser",
		"publish summary",
		"encode capture",
		"stop workbench",
		"stop server",
		"close aimock",
		`remove ${fixture.workspaceRoot}`,
	]);
});

test("SIGTERM during encoding aborts and awaits the encoder before final cleanup", {
	timeout: 1_000,
}, async () => {
	const fixture = orchestrationFixture();
	const signals = captureSignalFixture();
	let encoderSettled = false;
	let encoderSignal;

	await assert.rejects(
		captureDemo({
			repoRoot: "/repo",
			adapters: fixture.adapters,
			recordOnly: false,
			runIdFactory: () => "run-cancel-encoder",
			signalAdapter: signals.adapter,
			encodeCaptureArtifacts(options) {
				encoderSignal = options.signal;
				return new Promise((_, reject) => {
					options.signal.addEventListener(
						"abort",
						() => {
							fixture.operations.push("abort encoder child");
							encoderSettled = true;
							reject(options.signal.reason);
						},
						{ once: true },
					);
					queueMicrotask(() => signals.handlers.get("SIGTERM")());
				});
			},
		}),
		/cancelled by SIGTERM/,
	);

	assert.ok(encoderSignal instanceof AbortSignal);
	assert.equal(encoderSettled, true);
	assert.equal(fixture.operations.includes("abort encoder child"), true);
	assert.deepEqual(fixture.operations.slice(-5), [
		"stop workbench",
		"stop server",
		"close aimock",
		`remove ${fixture.workspaceRoot}`,
		"remove /repo/docs/brand/demo/artifacts/runs/run-cancel-encoder/capture-summary.json",
	]);
	assert.equal(signals.handlers.size, 0);
});

test("capture publishes a versioned run-specific manifest with deterministic scene boundaries", async () => {
	const fixture = orchestrationFixture();
	let tick = 1_000;
	const holds = [];
	const summary = await captureDemo({
		repoRoot: "/repo",
		adapters: fixture.adapters,
		recordOnly: true,
		runIdFactory: () => "run-unit-manifest",
		timing: {
			now() {
				const value = tick;
				tick += 100;
				return value;
			},
			async sleep(durationMs) {
				holds.push(durationMs);
			},
		},
		holdDurations: { preReloadMs: 700, restorationMs: 900 },
	});

	assert.equal(summary.schemaVersion, 1);
	assert.equal(summary.runId, "run-unit-manifest");
	assert.deepEqual(summary.toolchain, {
		node: "v24.19.0",
		pnpm: "10.33.0",
	});
	assert.deepEqual(summary.paths, {
		artifactsRoot: "/repo/docs/brand/demo/artifacts/runs/run-unit-manifest",
		recordingsRoot:
			"/repo/docs/brand/demo/raw-recordings/runs/run-unit-manifest",
		logs: {
			stdout:
				"/repo/docs/brand/demo/artifacts/runs/run-unit-manifest/test.stdout.log",
			stderr:
				"/repo/docs/brand/demo/artifacts/runs/run-unit-manifest/test.stderr.log",
			result:
				"/repo/docs/brand/demo/artifacts/runs/run-unit-manifest/test.result.json",
		},
		recording:
			"/repo/docs/brand/demo/raw-recordings/runs/run-unit-manifest/demo.webm",
	});
	assert.deepEqual(Object.keys(summary.videoTimeline.scenes), [
		"author",
		"test",
		"workbench-run",
		"pre-reload-complete",
		"restoration",
		"close",
	]);
	let previousEnd = -1;
	for (const boundary of Object.values(summary.videoTimeline.scenes)) {
		assert.equal(Number.isFinite(boundary.startMs), true);
		assert.equal(boundary.endMs >= boundary.startMs, true);
		assert.equal(boundary.startMs >= previousEnd, true);
		previousEnd = boundary.endMs;
	}
	assert.deepEqual(holds, [700, 900]);
	assert.deepEqual(summary.evidence, {
		prompt: DEMO_PROMPT,
		tools: ["searchCorpus", "readDoc"],
		answer: EXPECTED_ANSWER,
		threadId: "thread-unit-1",
		stateUrl: undefined,
	});
});

test("distinct run ids own disjoint raw and artifact roots", async () => {
	const first = orchestrationFixture();
	const second = orchestrationFixture();
	await Promise.all([
		captureDemo({
			repoRoot: "/repo",
			adapters: first.adapters,
			recordOnly: true,
			runIdFactory: () => "run-concurrent-a",
		}),
		captureDemo({
			repoRoot: "/repo",
			adapters: second.adapters,
			recordOnly: true,
			runIdFactory: () => "run-concurrent-b",
		}),
	]);
	for (const write of first.writes)
		assert.match(write.path, /\/runs\/run-concurrent-a\//);
	for (const write of second.writes)
		assert.match(write.path, /\/runs\/run-concurrent-b\//);
});

test("successful summaries publish atomically and failed runs leave no success summary", async () => {
	const success = orchestrationFixture();
	await captureDemo({
		repoRoot: "/repo",
		adapters: success.adapters,
		recordOnly: true,
		runIdFactory: () => "run-atomic-success",
	});
	assert.deepEqual(success.renames, [
		{
			from: "/repo/docs/brand/demo/artifacts/runs/run-atomic-success/capture-summary.json.tmp",
			to: "/repo/docs/brand/demo/artifacts/runs/run-atomic-success/capture-summary.json",
		},
	]);

	const failed = orchestrationFixture({ failAt: "scenario" });
	await assert.rejects(
		captureDemo({
			repoRoot: "/repo",
			adapters: failed.adapters,
			recordOnly: true,
			runIdFactory: () => "run-atomic-failure",
		}),
		/scenario failed/,
	);
	assert.equal(
		failed.writes.some(({ path }) => path.includes("capture-summary.json")),
		false,
	);
	assert.deepEqual(failed.renames, []);
});

test("record-only capture never invokes the future encoder", async () => {
	const fixture = orchestrationFixture();
	let invoked = false;
	await captureDemo({
		repoRoot: "/repo",
		adapters: fixture.adapters,
		recordOnly: true,
		async encodeCaptureArtifacts() {
			invoked = true;
		},
	});
	assert.equal(invoked, false);
});

test("non-record-only capture cleans up when the encoder fails", async () => {
	const fixture = orchestrationFixture();
	await assert.rejects(
		captureDemo({
			repoRoot: "/repo",
			adapters: fixture.adapters,
			recordOnly: false,
			async encodeCaptureArtifacts() {
				throw new Error("encoder failed");
			},
		}),
		/encoder failed/,
	);
	assert.deepEqual(fixture.operations.slice(-5, -1), [
		"stop workbench",
		"stop server",
		"close aimock",
		`remove ${fixture.workspaceRoot}`,
	]);
	assert.match(
		fixture.operations.at(-1),
		/^remove \/repo\/docs\/brand\/demo\/artifacts\/runs\/[A-Za-z0-9_-]+\/capture-summary\.json$/,
	);
});

const EXPECTED_UPLOAD_PATHS = [
	"demo/product-loop.mp4",
	"demo/product-loop.webm",
	"demo/author.mp4",
	"demo/author.webm",
	"demo/test.mp4",
	"demo/test.webm",
	"demo/run.mp4",
	"demo/run.webm",
];
const AUTHORIZED_MEDIA_STORE_ID = "store_9RQ8eZyGheVy0wOp";
const AUTHORIZED_MEDIA_ORIGIN =
	"https://9rq8ezyghevy0wop.public.blob.vercel-storage.com";

function authorizedLegacyToken(secret) {
	return `vercel_blob_rw_9RQ8eZyGheVy0wOp_${secret}`;
}

const AUTHORIZED_LEGACY_TOKEN = authorizedLegacyToken("testsecret");

function validUploadFixture(repoRoot = "/repo", runId = "run-upload") {
	const fixture = validManifestLayout(repoRoot, runId);
	fixture.manifest.captions = { ...MEDIA_CAPTIONS };
	return fixture;
}

function uploadBodies(manifest) {
	return new Map(
		EXPECTED_UPLOAD_PATHS.map((pathname) => {
			const [name, format] = pathname.slice("demo/".length).split(".");
			const sourcePath = manifest.clips[name][format];
			return [sourcePath, Buffer.from(`immutable:${pathname}`)];
		}),
	);
}

function validatedUploadMedia(pointer, manifest, bodies = uploadBodies(manifest)) {
	return {
		pointer,
		manifest,
		sourceFiles: new Map(
			[...bodies].map(([sourcePath, body]) => [
				sourcePath,
				{
					size: body.byteLength,
					probe: { validated: true },
					sha256: createHash("sha256").update(body).digest("hex"),
				},
			]),
		),
	};
}

function response(status, contentType) {
	return {
		status,
		headers: new Headers(
			contentType === undefined ? {} : { "content-type": contentType },
		),
	};
}

function inspectErrorSurface(error) {
	const seen = new Set();
	function inspect(value) {
		if (value === null || typeof value !== "object") return value;
		if (seen.has(value)) return "<circular>";
		seen.add(value);
		return Object.fromEntries(
			Reflect.ownKeys(value).map((key) => [String(key), inspect(value[key])]),
		);
	}
	return JSON.stringify(inspect(error));
}

test("upload plan binds the exact suffix-free paths to the validated run manifest", () => {
	const repoRoot = "/repo";
	const { pointer, manifest } = validUploadFixture(repoRoot);
	const plan = createUploadPlan({
		repoRoot,
		pointer,
		manifest,
		baseUrl: AUTHORIZED_MEDIA_ORIGIN,
	});

	assert.deepEqual(MEDIA_UPLOAD_PATHS, EXPECTED_UPLOAD_PATHS);
	assert.deepEqual(
		plan.map(({ pathname }) => pathname),
		EXPECTED_UPLOAD_PATHS,
	);
	assert.deepEqual(
		plan.map(({ sourcePath }) => sourcePath),
		EXPECTED_UPLOAD_PATHS.map((pathname) =>
			`${repoRoot}/docs/brand/demo/artifacts/runs/run-upload/output/${pathname.slice("demo/".length)}`,
		),
	);
	assert.deepEqual(
		plan.map(({ contentType }) => contentType),
		EXPECTED_UPLOAD_PATHS.map((pathname) =>
			pathname.endsWith(".mp4") ? "video/mp4" : "video/webm",
		),
	);
	assert.deepEqual(
		plan.map(({ url }) => url),
		EXPECTED_UPLOAD_PATHS.map(
			(pathname) =>
				`${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
		),
	);

	assert.throws(
		() =>
			createUploadPlan({
				repoRoot,
				pointer,
				manifest: {
					...manifest,
					clips: {
						...manifest.clips,
						run: { ...manifest.clips.run, mp4: "/tmp/unbound/run.mp4" },
					},
				},
				baseUrl: AUTHORIZED_MEDIA_ORIGIN,
			}),
		/run\.mp4.*expected run output root/,
	);
});

test("upload options default to dry run and reject conflicting or unknown flags", () => {
	assert.deepEqual(parseUploadArguments([]), { apply: false });
	assert.deepEqual(parseUploadArguments(["--dry-run"]), { apply: false });
	assert.deepEqual(parseUploadArguments(["--", "--apply"]), { apply: true });
	assert.throws(
		() => parseUploadArguments(["--dry-run", "--apply"]),
		/Usage:.*--dry-run.*--apply/,
	);
	assert.throws(() => parseUploadArguments(["--force"]), /Usage:/);
});

test("recording guide documents the local development OIDC requirement", async () => {
	const guide = await readFile(
		join(import.meta.dirname, "../recording-guide.md"),
		"utf8",
	);
	assert.match(guide, /vercel env pull/u);
	assert.match(guide, /local OIDC tokens.*development/u);
	assert.match(guide, /store connection.*include.*development/u);
	const [, committedOutputs] =
		guide.match(/Committed outputs are:\n\n```text\n([\s\S]*?)\n```/u) ?? [];
	assert.ok(committedOutputs, "recording guide must list committed outputs");
	assert.match(
		committedOutputs,
		/^apps\/web\/app\/lib\/demo-media\.json$/mu,
	);
});

test("upload validation rejects unsafe bases and randomized or nested path suffixes", () => {
	assert.equal(
		validatePublicBaseUrl(
			AUTHORIZED_MEDIA_ORIGIN,
		),
		AUTHORIZED_MEDIA_ORIGIN,
	);
	assert.equal(
		validatePublicBaseUrl("https://[2001:db8::1]"),
		"https://[2001:db8::1]",
	);
	assert.equal(
		validatePublicBaseUrl("https://xn--xample-9ua.com"),
		"https://xn--xample-9ua.com",
	);
	for (const unsafeBase of [
		"http://dawn-media.example.com",
		"https://user:secret@dawn-media.example.com",
		"https://dawn-media.example.com:443",
		" https://dawn-media.example.com",
		"https://dawn-media.example.com ",
		"https:\\dawn-media.example.com",
		"HTTPS://dawn-media.example.com",
		"https://Dawn-Media.example.com",
		"https://éxample.com",
		"https://[2001:0db8::1]",
		"https://dawn-media.example.com/",
		"https://dawn-media.example.com/prefix",
		"https://dawn-media.example.com?token=secret",
		"not a URL",
	]) {
		assert.throws(() => validatePublicBaseUrl(unsafeBase), /public base URL/i);
	}
	for (const unsafePath of [
		"demo/product-loop-abc123.mp4",
		"demo/nested/product-loop.mp4",
		"../demo/product-loop.mp4",
		"demo/product-loop.mov",
		"demo/product-loop.mp4?download=1",
	]) {
		assert.throws(() => validateUploadPathname(unsafePath), /stable media path/i);
	}
	for (const pathname of EXPECTED_UPLOAD_PATHS) {
		assert.equal(validateUploadPathname(pathname), pathname);
	}
});

test("dry run validates local media but performs no network or catalog I/O", async () => {
	const { pointer, manifest } = validUploadFixture();
	const lines = [];
	let validationCalls = 0;
	const env = new Proxy(
		{},
		{
			get(_target, property) {
				if (
					[
						"VERCEL_OIDC_TOKEN",
						"BLOB_STORE_ID",
						"BLOB_READ_WRITE_TOKEN",
						"DAWN_MEDIA_PUBLIC_BASE_URL",
					].includes(property)
				) {
					throw new Error(`dry run must not read ${property}`);
				}
				return undefined;
			},
		},
	);
	const result = await uploadReadmeMedia({
		args: [],
		env,
		repoRoot: "/repo",
		async loadValidatedMedia() {
			validationCalls += 1;
			return { pointer, manifest };
		},
		async readFile() {
			throw new Error("dry run must not read upload bodies");
		},
		async put() {
			throw new Error("dry run must not call put");
		},
		async fetch() {
			throw new Error("dry run must not call fetch");
		},
		async writeCatalog() {
			throw new Error("dry run must not write a catalog");
		},
		log(line) {
			lines.push(line);
		},
	});

	assert.equal(validationCalls, 1);
	assert.equal(result.applied, false);
	assert.equal(result.catalog, undefined);
	assert.match(lines[0], /DRY RUN.*no uploads.*no catalog/i);
	for (const [index, pathname] of EXPECTED_UPLOAD_PATHS.entries()) {
		assert.match(lines[index + 1], new RegExp(pathname.replaceAll(".", "\\.")));
		assert.match(lines[index + 1], /\/repo\/docs\/brand\/demo\/artifacts\/runs\/run-upload\/output/);
		assert.match(lines[index + 1], /<DAWN_MEDIA_PUBLIC_BASE_URL>/);
	}
});

test("apply rejects missing, partial, conflicting, or incorrectly bound credential modes", async () => {
	const { pointer, manifest } = validUploadFixture();
	let validationCalls = 0;
	const options = {
		args: ["--apply"],
		repoRoot: "/repo",
		async loadValidatedMedia() {
			validationCalls += 1;
			return { pointer, manifest };
		},
		log() {},
	};
	for (const [env, expected] of [
		[{}, /exactly one.*credential mode/i],
		[{ VERCEL_OIDC_TOKEN: "oidc-secret" }, /VERCEL_OIDC_TOKEN.*BLOB_STORE_ID/i],
		[{ BLOB_STORE_ID: AUTHORIZED_MEDIA_STORE_ID }, /VERCEL_OIDC_TOKEN.*BLOB_STORE_ID/i],
		[
			{
				VERCEL_OIDC_TOKEN: "oidc-secret",
				BLOB_STORE_ID: AUTHORIZED_MEDIA_STORE_ID,
				BLOB_READ_WRITE_TOKEN: "legacy-secret",
			},
			/exactly one.*credential mode|conflicting/i,
		],
		[
			{
				VERCEL_OIDC_TOKEN: "oidc-secret",
				BLOB_STORE_ID: "9RQ8eZyGheVy0wOp",
				DAWN_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
			},
			/BLOB_STORE_ID.*authorized Dawn media store/i,
		],
		[
			{
				VERCEL_OIDC_TOKEN: "oidc-secret",
				BLOB_STORE_ID: `${AUTHORIZED_MEDIA_STORE_ID} `,
				DAWN_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
			},
			/BLOB_STORE_ID.*authorized Dawn media store/i,
		],
		[
			{
				VERCEL_OIDC_TOKEN: "oidc-secret",
				BLOB_STORE_ID: AUTHORIZED_MEDIA_STORE_ID,
				DAWN_MEDIA_PUBLIC_BASE_URL:
					"https://other.public.blob.vercel-storage.com",
			},
			/public base URL.*authorized.*store/i,
		],
	]) {
		await assert.rejects(uploadReadmeMedia({ ...options, env }), expected);
	}
	assert.equal(validationCalls, 0);
});

test("legacy credentials reject malformed or wrong-store tokens and a mismatched base before put", async () => {
	const { pointer, manifest } = validUploadFixture();
	let validationCalls = 0;
	let puts = 0;
	const options = {
		args: ["--apply"],
		repoRoot: "/repo",
		async loadValidatedMedia() {
			validationCalls += 1;
			return { pointer, manifest };
		},
		async put() {
			puts += 1;
		},
		log() {},
	};
	for (const [env, expected] of [
		[
			{
				BLOB_READ_WRITE_TOKEN: "not-a-vercel-blob-token",
				DAWN_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
			},
			/BLOB_READ_WRITE_TOKEN.*canonical Vercel Blob/i,
		],
		[
			{
				BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_wrongStore_secret",
				DAWN_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
			},
			/BLOB_READ_WRITE_TOKEN.*authorized Dawn media store/i,
		],
		[
			{
				BLOB_READ_WRITE_TOKEN: AUTHORIZED_LEGACY_TOKEN,
				DAWN_MEDIA_PUBLIC_BASE_URL:
					"https://other.public.blob.vercel-storage.com",
			},
			/public base URL.*authorized.*store/i,
		],
	]) {
		await assert.rejects(uploadReadmeMedia({ ...options, env }), expected);
	}
	assert.equal(validationCalls, 0);
	assert.equal(puts, 0);
});

test("credential values reject surrounding whitespace without leaking their trimmed secrets", async () => {
	const { pointer, manifest } = validUploadFixture();
	let validationCalls = 0;
	let puts = 0;
	const cases = [
		{
			env: {
				VERCEL_OIDC_TOKEN: " oidc-whitespace-secret ",
				BLOB_STORE_ID: AUTHORIZED_MEDIA_STORE_ID,
				DAWN_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
			},
			secret: "oidc-whitespace-secret",
		},
		{
			env: {
				BLOB_READ_WRITE_TOKEN: ` ${AUTHORIZED_LEGACY_TOKEN} `,
				DAWN_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
			},
			secret: AUTHORIZED_LEGACY_TOKEN,
		},
	];
	for (const { env, secret } of cases) {
		let captured;
		try {
			await uploadReadmeMedia({
				args: ["--apply"],
				env,
				repoRoot: "/repo",
				async loadValidatedMedia() {
					validationCalls += 1;
					return { pointer, manifest };
				},
				async put() {
					puts += 1;
				},
				log() {},
			});
		} catch (error) {
			captured = error;
		}
		assert.match(captured.message, /credential.*surrounding whitespace/i);
		assert.doesNotMatch(inspectErrorSurface(captured), new RegExp(secret));
	}
	assert.equal(validationCalls, 0);
	assert.equal(puts, 0);
});

test("OIDC apply passes only the explicit authorized oidcToken and storeId to put", async () => {
	const { pointer, manifest } = validUploadFixture();
	const bodies = uploadBodies(manifest);
	const oidcToken = "short-lived-oidc-secret";
	const puts = [];
	await uploadReadmeMedia({
		args: ["--apply"],
		env: {
			VERCEL_OIDC_TOKEN: oidcToken,
			BLOB_STORE_ID: AUTHORIZED_MEDIA_STORE_ID,
			DAWN_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
		},
		repoRoot: "/repo",
		async loadValidatedMedia() {
			return validatedUploadMedia(pointer, manifest, bodies);
		},
		async readFile(path) {
			return bodies.get(path);
		},
		async put(pathname, _body, options) {
			puts.push({ pathname, options });
			return { url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}` };
		},
		async fetch(url) {
			return response(200, url.endsWith(".mp4") ? "video/mp4" : "video/webm");
		},
		async writeCatalog() {},
		log(line) {
			assert.doesNotMatch(line, new RegExp(oidcToken));
		},
	});
	assert.equal(puts.length, 8);
	for (const { options } of puts) {
		assert.equal(options.oidcToken, oidcToken);
		assert.equal(options.storeId, AUTHORIZED_MEDIA_STORE_ID);
		assert.equal(Object.hasOwn(options, "token"), false);
	}
});

test("OIDC provider failures redact the credential from the full error surface", async () => {
	const { pointer, manifest } = validUploadFixture();
	const bodies = uploadBodies(manifest);
	const oidcToken = "provider-oidc-secret";
	let captured;
	try {
		await uploadReadmeMedia({
			args: ["--apply"],
			env: {
				VERCEL_OIDC_TOKEN: oidcToken,
				BLOB_STORE_ID: AUTHORIZED_MEDIA_STORE_ID,
				DAWN_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
			},
			repoRoot: "/repo",
			async loadValidatedMedia() {
				return validatedUploadMedia(pointer, manifest, bodies);
			},
			async readFile(path) {
				return bodies.get(path);
			},
			async put() {
				const error = new Error(`OIDC authorization failed: ${oidcToken}`);
				error.authorization = oidcToken;
				throw error;
			},
			log() {},
		});
	} catch (error) {
		captured = error;
	}
	assert.equal(captured.cause, undefined);
	assert.match(captured.message, /OIDC authorization failed: <redacted>/);
	assert.doesNotMatch(captured.stack, new RegExp(oidcToken));
	assert.doesNotMatch(inspectErrorSurface(captured), new RegExp(oidcToken));
});

test("legacy apply remains compatible and requires an explicit safe public base", async () => {
	const { pointer, manifest } = validUploadFixture();
	const legacyToken = authorizedLegacyToken("topsecrettoken");
	const options = {
		args: ["--apply"],
		repoRoot: "/repo",
		async loadValidatedMedia() {
			return { pointer, manifest };
		},
		log() {},
	};
	await assert.rejects(
		uploadReadmeMedia({ ...options, env: {} }),
		/BLOB_READ_WRITE_TOKEN/,
	);
	await assert.rejects(
		uploadReadmeMedia({
			...options,
			env: { BLOB_READ_WRITE_TOKEN: legacyToken },
		}),
		(error) => {
			assert.match(error.message, /DAWN_MEDIA_PUBLIC_BASE_URL/);
			assert.doesNotMatch(error.message, new RegExp(legacyToken));
			return true;
		},
	);
	await assert.rejects(
		uploadReadmeMedia({
			...options,
			env: {
				BLOB_READ_WRITE_TOKEN: legacyToken,
				DAWN_MEDIA_PUBLIC_BASE_URL: "http://unsafe.example.com",
			},
		}),
		(error) => {
			assert.doesNotMatch(error.message, new RegExp(legacyToken));
			return /public base URL/i.test(error.message);
		},
	);
});

test("provider failures expose no token-bearing cause, stack, or serialized property", async () => {
	const { pointer, manifest } = validUploadFixture();
	const bodies = uploadBodies(manifest);
	const token = authorizedLegacyToken("providersecretwritetoken");
	let captured;
	try {
		await uploadReadmeMedia({
			args: ["--apply"],
			env: {
				BLOB_READ_WRITE_TOKEN: token,
				DAWN_MEDIA_PUBLIC_BASE_URL:
					AUTHORIZED_MEDIA_ORIGIN,
			},
			repoRoot: "/repo",
			async loadValidatedMedia() {
				return validatedUploadMedia(pointer, manifest, bodies);
			},
			async readFile(path) {
				return bodies.get(path);
			},
			async put() {
				const providerError = new Error(
					`provider rejected Authorization: Bearer ${token}`,
				);
				providerError.request = {
					headers: { authorization: `Bearer ${token}` },
				};
				throw providerError;
			},
			async fetch() {
				throw new Error("fetch must not run after a failed put");
			},
			async writeCatalog() {
				throw new Error("catalog must not be written after a failed put");
			},
			log() {},
		});
	} catch (error) {
		captured = error;
	}
	assert.ok(captured instanceof Error);
	assert.match(captured.message, /Upload did not converge at demo\/product-loop\.mp4/);
	assert.match(captured.message, /provider rejected Authorization: Bearer <redacted>/);
	assert.equal(captured.cause, undefined);
	assert.doesNotMatch(captured.stack, new RegExp(token));
	assert.doesNotMatch(inspectErrorSurface(captured), new RegExp(token));
});

test("upload preflights all bodies and hashes before the first put", async () => {
	const { pointer, manifest } = validUploadFixture();
	const bodies = uploadBodies(manifest);
	const events = [];
	const putBodies = [];
	const result = await uploadReadmeMedia({
		args: ["--apply"],
		env: {
			BLOB_READ_WRITE_TOKEN: AUTHORIZED_LEGACY_TOKEN,
			DAWN_MEDIA_PUBLIC_BASE_URL:
				AUTHORIZED_MEDIA_ORIGIN,
		},
		repoRoot: "/repo",
		async loadValidatedMedia() {
			return validatedUploadMedia(pointer, manifest, bodies);
		},
		async readFile(path) {
			events.push(`read:${path}`);
			return bodies.get(path);
		},
		async put(pathname, body) {
			events.push(`put:${pathname}`);
			putBodies.push(body);
			return {
				url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
			};
		},
		async fetch(url) {
			return response(200, url.endsWith(".mp4") ? "video/mp4" : "video/webm");
		},
		async writeCatalog() {},
		log() {},
	});

	assert.equal(events.slice(0, 8).every((event) => event.startsWith("read:")), true);
	assert.equal(events.slice(8).every((event) => event.startsWith("put:")), true);
	assert.equal(Object.isFrozen(result.plan), true);
	for (const [index, entry] of result.plan.entries()) {
		const expectedBody = bodies.get(entry.sourcePath);
		assert.equal(Object.isFrozen(entry), true);
		assert.equal(entry.body, expectedBody);
		assert.equal(putBodies[index], entry.body);
		assert.equal(entry.size, expectedBody.byteLength);
		assert.equal(
			entry.sha256,
			createHash("sha256").update(expectedBody).digest("hex"),
		);
	}
});

test("a late preflight read failure performs zero puts", async () => {
	const { pointer, manifest } = validUploadFixture();
	const bodies = uploadBodies(manifest);
	let reads = 0;
	let puts = 0;
	await assert.rejects(
		uploadReadmeMedia({
			args: ["--apply"],
			env: {
				BLOB_READ_WRITE_TOKEN: AUTHORIZED_LEGACY_TOKEN,
				DAWN_MEDIA_PUBLIC_BASE_URL:
					AUTHORIZED_MEDIA_ORIGIN,
			},
			repoRoot: "/repo",
			async loadValidatedMedia() {
				return validatedUploadMedia(pointer, manifest, bodies);
			},
			async readFile(path) {
				reads += 1;
				if (reads === 8) throw new Error("late local read failed");
				return bodies.get(path);
			},
			async put() {
				puts += 1;
			},
			log() {},
		}),
		/late local read failed/,
	);
	assert.equal(reads, 8);
	assert.equal(puts, 0);
});

test("same-size video mutation fails the validation-time hash before any put", async () => {
	const { pointer, manifest } = validUploadFixture();
	const validatedBodies = uploadBodies(manifest);
	const mutatedBodies = new Map(validatedBodies);
	const sourcePath = manifest.clips.author.mp4;
	const original = validatedBodies.get(sourcePath);
	const mutated = Buffer.from(original);
	mutated[0] ^= 0xff;
	assert.equal(mutated.byteLength, original.byteLength);
	mutatedBodies.set(sourcePath, mutated);
	let puts = 0;
	await assert.rejects(
		uploadReadmeMedia({
			args: ["--apply"],
			env: {
				BLOB_READ_WRITE_TOKEN: AUTHORIZED_LEGACY_TOKEN,
				DAWN_MEDIA_PUBLIC_BASE_URL:
					AUTHORIZED_MEDIA_ORIGIN,
			},
			repoRoot: "/repo",
			async loadValidatedMedia() {
				return validatedUploadMedia(pointer, manifest, validatedBodies);
			},
			async readFile(path) {
				return mutatedBodies.get(path);
			},
			async put() {
				puts += 1;
			},
			log() {},
		}),
		/author\.mp4.*SHA-256.*validation-time hash/i,
	);
	assert.equal(puts, 0);
});

test("partial provider failure reports safe convergence and a full replay succeeds", async () => {
	const { pointer, manifest } = validUploadFixture();
	const bodies = uploadBodies(manifest);
	const token = authorizedLegacyToken("convergencesecret");
	let writes = 0;
	const firstPuts = [];
	let firstError;
	try {
		await uploadReadmeMedia({
			args: ["--apply"],
			env: {
				BLOB_READ_WRITE_TOKEN: token,
				DAWN_MEDIA_PUBLIC_BASE_URL:
					AUTHORIZED_MEDIA_ORIGIN,
			},
			repoRoot: "/repo",
			async loadValidatedMedia() {
				return validatedUploadMedia(pointer, manifest, bodies);
			},
			async readFile(path) {
				return bodies.get(path);
			},
			async put(pathname) {
				firstPuts.push(pathname);
				if (firstPuts.length === 4) {
					throw new Error(`provider failed ${token}`);
				}
				return {
					url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
				};
			},
			async writeCatalog() {
				writes += 1;
			},
			log() {},
		});
	} catch (error) {
		firstError = error;
	}
	assert.equal(writes, 0);
	assert.deepEqual(firstPuts, EXPECTED_UPLOAD_PATHS.slice(0, 4));
	assert.match(firstError.message, /completed.*product-loop\.mp4.*author\.mp4/is);
	assert.match(firstError.message, /potentially completed.*author\.webm/is);
	assert.match(firstError.message, /definitely pending.*test\.mp4.*run\.webm/is);
	assert.match(firstError.message, /full eight-path.*idempotent.*replay/is);
	assert.doesNotMatch(inspectErrorSurface(firstError), new RegExp(token));
	assert.doesNotMatch(firstError.message, /rollback/i);

	const replayPuts = [];
	let heads = 0;
	await uploadReadmeMedia({
		args: ["--apply"],
		env: {
			BLOB_READ_WRITE_TOKEN: token,
			DAWN_MEDIA_PUBLIC_BASE_URL:
				AUTHORIZED_MEDIA_ORIGIN,
		},
		repoRoot: "/repo",
		async loadValidatedMedia() {
			return validatedUploadMedia(pointer, manifest, bodies);
		},
		async readFile(path) {
			return bodies.get(path);
		},
		async put(pathname, body, options) {
			replayPuts.push({ pathname, body, options });
			return {
				url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
			};
		},
		async fetch(url) {
			heads += 1;
			return response(200, url.endsWith(".mp4") ? "video/mp4" : "video/webm");
		},
		async writeCatalog() {
			writes += 1;
		},
		log() {},
	});
	assert.deepEqual(
		replayPuts.map(({ pathname }) => pathname),
		EXPECTED_UPLOAD_PATHS,
	);
	for (const put of replayPuts) {
		assert.equal(put.options.allowOverwrite, true);
		assert.equal(put.options.addRandomSuffix, false);
		assert.equal(put.body, bodies.get(manifest.clips[put.pathname.split("/")[1].split(".")[0]][put.pathname.endsWith(".mp4") ? "mp4" : "webm"]));
	}
	assert.equal(heads, 8);
	assert.equal(writes, 1);
});

test("apply uses official stable put options and writes only after all HEAD checks", async () => {
	const { pointer, manifest } = validUploadFixture();
	const bodies = uploadBodies(manifest);
	const events = [];
	const token = authorizedLegacyToken("privatewritetoken");
	const baseUrl = AUTHORIZED_MEDIA_ORIGIN;
	const result = await uploadReadmeMedia({
		args: ["--apply"],
		env: {
			BLOB_READ_WRITE_TOKEN: token,
			DAWN_MEDIA_PUBLIC_BASE_URL: baseUrl,
		},
		repoRoot: "/repo",
		async loadValidatedMedia() {
			return validatedUploadMedia(pointer, manifest, bodies);
		},
		async readFile(path) {
			events.push({ type: "read", path });
			return bodies.get(path);
		},
		async put(pathname, body, options) {
			events.push({ type: "put", pathname, body, options });
			return { url: `${baseUrl}/${pathname}` };
		},
		async fetch(url, options) {
			events.push({ type: "head", url, options });
			return response(
				200,
				url.endsWith(".mp4") ? "video/mp4" : "video/webm",
			);
		},
		async writeCatalog(catalog) {
			events.push({ type: "write", catalog });
		},
		log(line) {
			assert.doesNotMatch(line, new RegExp(token));
		},
	});

	const putEvents = events.filter(({ type }) => type === "put");
	assert.equal(putEvents.length, 8);
	for (const [index, event] of putEvents.entries()) {
		assert.equal(event.pathname, EXPECTED_UPLOAD_PATHS[index]);
		assert.ok(Buffer.isBuffer(event.body));
		assert.ok(event.options.abortSignal instanceof AbortSignal);
		assert.deepEqual({ ...event.options, abortSignal: undefined }, {
			access: "public",
			addRandomSuffix: false,
			allowOverwrite: true,
			contentType: event.pathname.endsWith(".mp4")
				? "video/mp4"
				: "video/webm",
			token,
			abortSignal: undefined,
		});
	}
	const headEvents = events.filter(({ type }) => type === "head");
	assert.equal(headEvents.length, 8);
	for (const event of headEvents) {
		assert.equal(event.options.method, "HEAD");
		assert.equal(event.options.redirect, "error");
		assert.ok(event.options.signal instanceof AbortSignal);
		assert.equal("headers" in event.options, false);
	}
	assert.equal(events.at(-1).type, "write");
	assert.deepEqual(result.catalog, events.at(-1).catalog);
	assert.equal(result.applied, true);
	assert.doesNotMatch(JSON.stringify(result.catalog), new RegExp(token));
});

test("returned URL mismatch reports the current mutation uncertainty and safe convergence", async () => {
	const { pointer, manifest } = validUploadFixture();
	const bodies = uploadBodies(manifest);
	const token = authorizedLegacyToken("mismatchsecret");
	let puts = 0;
	let writes = 0;
	let captured;
	try {
		await uploadReadmeMedia({
			args: ["--apply"],
			env: {
				BLOB_READ_WRITE_TOKEN: token,
				DAWN_MEDIA_PUBLIC_BASE_URL:
					AUTHORIZED_MEDIA_ORIGIN,
			},
			repoRoot: "/repo",
			async loadValidatedMedia() {
				return validatedUploadMedia(pointer, manifest, bodies);
			},
			async readFile(path) {
				return bodies.get(path);
			},
			async put(pathname) {
				puts += 1;
				return {
					url:
						puts === 3
							? `https://other.example.com/${pathname}-${token}`
							: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
				};
			},
			async fetch() {
				throw new Error("HEAD must wait for valid upload URLs");
			},
			async writeCatalog() {
				writes += 1;
			},
			log() {},
		});
	} catch (error) {
		captured = error;
	}
	assert.equal(puts, 3);
	assert.equal(writes, 0);
	assert.equal(captured.cause, undefined);
	assert.match(captured.message, /returned URL.*stable public URL/i);
	assert.match(
		captured.message,
		/confirmed completed.*product-loop\.mp4.*product-loop\.webm/is,
	);
	assert.match(captured.message, /potentially completed.*author\.mp4/is);
	assert.match(
		captured.message,
		/definitely pending.*author\.webm.*run\.webm/is,
	);
	assert.match(
		captured.message,
		/correct.*BLOB_READ_WRITE_TOKEN.*DAWN_MEDIA_PUBLIC_BASE_URL.*full eight-path.*replay/is,
	);
	assert.match(captured.message, /catalog.*not written|catalog.*withheld/i);
	assert.doesNotMatch(inspectErrorSurface(captured), new RegExp(token));
});

test("non-timeout HEAD failure withholds the catalog and reports safe post-mutation convergence", async () => {
	const { pointer, manifest } = validUploadFixture();
	const bodies = uploadBodies(manifest);
	let writes = 0;
	let headCalls = 0;
	let captured;
	try {
		await uploadReadmeMedia({
			args: ["--apply"],
			env: {
				BLOB_READ_WRITE_TOKEN: AUTHORIZED_LEGACY_TOKEN,
				DAWN_MEDIA_PUBLIC_BASE_URL:
					AUTHORIZED_MEDIA_ORIGIN,
			},
			repoRoot: "/repo",
			async loadValidatedMedia() {
				return validatedUploadMedia(pointer, manifest, bodies);
			},
			async readFile(path) {
				return bodies.get(path);
			},
			async put(pathname) {
				return {
					url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
				};
			},
			async fetch(url) {
				headCalls += 1;
				return response(
					url.endsWith("run.webm") ? 503 : 200,
					url.endsWith(".mp4") ? "video/mp4" : "video/webm",
				);
			},
			async writeCatalog() {
				writes += 1;
			},
			log() {},
		});
	} catch (error) {
		captured = error;
	}
	assert.equal(headCalls, 8);
	assert.equal(writes, 0);
	assert.match(captured.message, /run\.webm.*200.*503/i);
	assert.match(captured.message, /all eight upload calls returned/i);
	assert.match(captured.message, /catalog.*not written|catalog.*withheld/i);
	assert.match(
		captured.message,
		/verification outcome.*uncertain.*run\.webm/is,
	);
	assert.match(captured.message, /full eight-path.*replay|re-verif/is);
});

test("HEAD timeout after all puts preserves safe identity and post-mutation guidance", async () => {
	const { pointer, manifest } = validUploadFixture();
	const bodies = uploadBodies(manifest);
	const token = authorizedLegacyToken("headtimeoutsecret");
	let puts = 0;
	let heads = 0;
	let writes = 0;
	let captured;
	try {
		await uploadReadmeMedia({
			args: ["--apply"],
			env: {
				BLOB_READ_WRITE_TOKEN: token,
				DAWN_MEDIA_PUBLIC_BASE_URL:
					AUTHORIZED_MEDIA_ORIGIN,
			},
			timeoutMs: 5,
			repoRoot: "/repo",
			async loadValidatedMedia() {
				return validatedUploadMedia(pointer, manifest, bodies);
			},
			async readFile(path) {
				return bodies.get(path);
			},
			async put(pathname) {
				puts += 1;
				return {
					url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
				};
			},
			async fetch(_url, options) {
				heads += 1;
				return new Promise((_resolve, reject) => {
					options.signal.addEventListener(
						"abort",
						() => reject(options.signal.reason),
						{ once: true },
					);
				});
			},
			async writeCatalog() {
				writes += 1;
			},
			log() {},
		});
	} catch (error) {
		captured = error;
	}
	assert.equal(puts, 8);
	assert.equal(heads, 1);
	assert.equal(writes, 0);
	assert.equal(captured.code, "DAWN_MEDIA_REMOTE_TIMEOUT");
	assert.equal(captured.cause, undefined);
	assert.match(captured.message, /all eight upload calls returned/i);
	for (const pathname of EXPECTED_UPLOAD_PATHS) {
		assert.match(captured.message, new RegExp(pathname.replace(".", "\\.")));
	}
	assert.match(captured.message, /catalog.*not written|catalog.*withheld/i);
	assert.match(
		captured.message,
		/verification outcome.*uncertain.*https:\/\/9rq8ezyghevy0wop\.public\.blob\.vercel-storage\.com\/demo\/product-loop\.mp4/is,
	);
	assert.match(captured.message, /full eight-path.*replay|re-verif/is);
	assert.doesNotMatch(inspectErrorSurface(captured), new RegExp(token));
});

test("HEAD abort after all puts preserves safe abort identity without a secret-bearing cause", async () => {
	const { pointer, manifest } = validUploadFixture();
	const bodies = uploadBodies(manifest);
	const token = authorizedLegacyToken("headabortsecret");
	let puts = 0;
	let writes = 0;
	let captured;
	try {
		await uploadReadmeMedia({
			args: ["--apply"],
			env: {
				BLOB_READ_WRITE_TOKEN: token,
				DAWN_MEDIA_PUBLIC_BASE_URL:
					AUTHORIZED_MEDIA_ORIGIN,
			},
			repoRoot: "/repo",
			async loadValidatedMedia() {
				return validatedUploadMedia(pointer, manifest, bodies);
			},
			async readFile(path) {
				return bodies.get(path);
			},
			async put(pathname) {
				puts += 1;
				return {
					url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
				};
			},
			async fetch() {
				const error = new Error(`provider abort ${token}`);
				error.name = "AbortError";
				throw error;
			},
			async writeCatalog() {
				writes += 1;
			},
			log() {},
		});
	} catch (error) {
		captured = error;
	}
	assert.equal(puts, 8);
	assert.equal(writes, 0);
	assert.equal(captured.name, "AbortError");
	assert.equal(captured.code, "DAWN_MEDIA_REMOTE_ABORT");
	assert.equal(captured.cause, undefined);
	assert.match(captured.message, /all eight upload calls returned/i);
	assert.match(captured.message, /catalog.*not written|catalog.*withheld/i);
	assert.match(captured.message, /verification outcome.*uncertain/i);
	assert.match(captured.message, /full eight-path.*replay|re-verif/is);
	assert.doesNotMatch(inspectErrorSurface(captured), new RegExp(token));
});

test("stalled put and HEAD operations abort at the bounded timeout", async () => {
	const { pointer, manifest } = validUploadFixture();
	const bodies = uploadBodies(manifest);
	let putSignal;
	await assert.rejects(
		uploadReadmeMedia({
			args: ["--apply"],
			env: {
				BLOB_READ_WRITE_TOKEN: AUTHORIZED_LEGACY_TOKEN,
				DAWN_MEDIA_PUBLIC_BASE_URL:
					AUTHORIZED_MEDIA_ORIGIN,
			},
			timeoutMs: 5,
			repoRoot: "/repo",
			async loadValidatedMedia() {
				return validatedUploadMedia(pointer, manifest, bodies);
			},
			async readFile(path) {
				return bodies.get(path);
			},
			async put(_pathname, _body, options) {
				putSignal = options.abortSignal;
				return new Promise((_resolve, reject) => {
					setTimeout(() => reject(new Error("put safety timeout")), 30);
					options.abortSignal?.addEventListener(
						"abort",
						() => reject(options.abortSignal.reason),
						{ once: true },
					);
				});
			},
			log() {},
		}),
		/put demo\/product-loop\.mp4 timed out after 5ms/,
	);
	assert.equal(putSignal.aborted, true);

	const catalog = buildDemoMediaCatalog({
		manifest,
		plan: createUploadPlan({
			repoRoot: "/repo",
			pointer,
			manifest,
			baseUrl: AUTHORIZED_MEDIA_ORIGIN,
		}),
	});
	let headSignal;
	await assert.rejects(
		checkRemoteMedia({
			repoRoot: "/repo",
			timeoutMs: 5,
			async readFile() {
				return JSON.stringify(catalog);
			},
			async fetch(_url, options) {
				headSignal = options.signal;
				return new Promise((_resolve, reject) => {
					setTimeout(() => reject(new Error("HEAD safety timeout")), 30);
					options.signal?.addEventListener(
						"abort",
						() => reject(options.signal.reason),
						{ once: true },
					);
				});
			},
			log() {},
		}),
		/HEAD productLoop\.mp4 timed out after 5ms/,
	);
	assert.equal(headSignal.aborted, true);
});

test("timeout after prior puts reports uncertainty and full idempotent convergence", async () => {
	const { pointer, manifest } = validUploadFixture();
	const bodies = uploadBodies(manifest);
	let puts = 0;
	let writes = 0;
	let captured;
	try {
		await uploadReadmeMedia({
			args: ["--apply"],
			env: {
				BLOB_READ_WRITE_TOKEN: authorizedLegacyToken("timeoutsecret"),
				DAWN_MEDIA_PUBLIC_BASE_URL:
					AUTHORIZED_MEDIA_ORIGIN,
			},
			timeoutMs: 5,
			repoRoot: "/repo",
			async loadValidatedMedia() {
				return validatedUploadMedia(pointer, manifest, bodies);
			},
			async readFile(path) {
				return bodies.get(path);
			},
			async put(pathname, _body, options) {
				puts += 1;
				if (puts < 3) {
					return {
						url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
					};
				}
				return new Promise((_resolve, reject) => {
					options.abortSignal.addEventListener(
						"abort",
						() => reject(options.abortSignal.reason),
						{ once: true },
					);
				});
			},
			async writeCatalog() {
				writes += 1;
			},
			log() {},
		});
	} catch (error) {
		captured = error;
	}
	assert.equal(puts, 3);
	assert.equal(writes, 0);
	assert.equal(captured.code, "DAWN_MEDIA_REMOTE_TIMEOUT");
	assert.equal(captured.cause, undefined);
	assert.match(
		captured.message,
		/confirmed completed.*product-loop\.mp4.*product-loop\.webm/is,
	);
	assert.match(captured.message, /potentially completed.*author\.mp4/is);
	assert.match(
		captured.message,
		/definitely pending.*author\.webm.*run\.webm/is,
	);
	assert.match(captured.message, /full eight-path.*idempotent.*replay/is);
	assert.doesNotMatch(inspectErrorSurface(captured), /timeout-secret/);
});

test("bounded remote operation rejects a fired timeout after an ignoring operation resolves", async () => {
	let operationSignal;
	await assert.rejects(
		runBoundedRemoteOperation({
			label: "late provider operation",
			timeoutMs: 5,
			async operation(signal) {
				operationSignal = signal;
				await new Promise((resolve) => setTimeout(resolve, 20));
				return "late success";
			},
		}),
		(error) =>
			error.code === "DAWN_MEDIA_REMOTE_TIMEOUT" &&
			/late provider operation timed out after 5ms/.test(error.message),
	);
	assert.equal(operationSignal.aborted, true);
});

test("catalog entries contain exactly the six required fields", () => {
	const { pointer, manifest } = validUploadFixture();
	const plan = createUploadPlan({
		repoRoot: "/repo",
		pointer,
		manifest,
		baseUrl: AUTHORIZED_MEDIA_ORIGIN,
	});
	const catalog = buildDemoMediaCatalog({ manifest, plan });
	assert.deepEqual(Object.keys(catalog), ["productLoop", "author", "test", "run"]);
	for (const entry of Object.values(catalog)) {
		assert.deepEqual(Object.keys(entry).sort(), [
			"ariaLabel",
			"caption",
			"mp4",
			"poster",
			"transcript",
			"webm",
		]);
	}
	assert.deepEqual(validateDemoMediaCatalog(catalog), catalog);
	const missingTranscript = structuredClone(catalog);
	delete missingTranscript.run.transcript;
	assert.throws(
		() => validateDemoMediaCatalog(missingTranscript),
		/run\.transcript.*required/i,
	);
	const unexpectedField = structuredClone(catalog);
	unexpectedField.author.extra = true;
	assert.throws(
		() => validateDemoMediaCatalog(unexpectedField),
		/author.*exactly.*ariaLabel.*transcript/i,
	);
});

test("catalog media URLs require exact stable paths with no authority or URL suffix drift", () => {
	const { pointer, manifest } = validUploadFixture();
	const catalog = buildDemoMediaCatalog({
		manifest,
		plan: createUploadPlan({
			repoRoot: "/repo",
			pointer,
			manifest,
			baseUrl: AUTHORIZED_MEDIA_ORIGIN,
		}),
	});
	for (const [name, url, pattern] of [
		[
			"extra path prefix",
			"https://dawn-media.public.blob.vercel-storage.com/extra/demo/run.mp4",
			/run\.mp4.*exact stable path/i,
		],
		[
			"query suffix",
			"https://dawn-media.public.blob.vercel-storage.com/demo/run.mp4?unstable=1",
			/run\.mp4.*query|exact stable path/i,
		],
		[
			"fragment suffix",
			"https://dawn-media.public.blob.vercel-storage.com/demo/run.mp4#unstable",
			/run\.mp4.*fragment|exact stable path/i,
		],
		[
			"credentials",
			"https://user:secret@dawn-media.public.blob.vercel-storage.com/demo/run.mp4",
			/run\.mp4.*credentials/i,
		],
		[
			"nonstandard port",
			"https://dawn-media.public.blob.vercel-storage.com:8443/demo/run.mp4",
			/run\.mp4.*port|same public origin/i,
		],
		[
			"explicit default port",
			"https://dawn-media.public.blob.vercel-storage.com:443/demo/run.mp4",
			/run\.mp4.*explicit port/i,
		],
		[
			"leading whitespace",
			" https://dawn-media.public.blob.vercel-storage.com/demo/run.mp4",
			/run\.mp4.*canonical/i,
		],
		[
			"trailing whitespace",
			"https://dawn-media.public.blob.vercel-storage.com/demo/run.mp4 ",
			/run\.mp4.*canonical/i,
		],
		[
			"backslashes",
			"https://dawn-media.public.blob.vercel-storage.com\\demo\\run.mp4",
			/run\.mp4.*canonical/i,
		],
		[
			"uppercase host",
			"https://DAWN-MEDIA.public.blob.vercel-storage.com/demo/run.mp4",
			/run\.mp4.*canonical/i,
		],
	]) {
		const candidate = structuredClone(catalog);
		candidate.run.mp4 = url;
		assert.throws(
			() => validateDemoMediaCatalog(candidate),
			pattern,
			name,
		);
	}
	for (const [name, noncanonicalHost] of [
		["Unicode IDN", "éxample.com"],
		["expanded IPv6", "[2001:0db8::1]"],
	]) {
		const candidate = structuredClone(catalog);
		for (const entry of Object.values(candidate)) {
			entry.mp4 = entry.mp4.replace(
				new URL(AUTHORIZED_MEDIA_ORIGIN).host,
				noncanonicalHost,
			);
			entry.webm = entry.webm.replace(
				new URL(AUTHORIZED_MEDIA_ORIGIN).host,
				noncanonicalHost,
			);
		}
		assert.throws(
			() => validateDemoMediaCatalog(candidate),
			/canonical/i,
			name,
		);
	}
	for (const canonicalHost of ["xn--xample-9ua.com", "[2001:db8::1]"]) {
		const candidate = structuredClone(catalog);
		for (const entry of Object.values(candidate)) {
			entry.mp4 = entry.mp4.replace(
				new URL(AUTHORIZED_MEDIA_ORIGIN).host,
				canonicalHost,
			);
			entry.webm = entry.webm.replace(
				new URL(AUTHORIZED_MEDIA_ORIGIN).host,
				canonicalHost,
			);
		}
		assert.doesNotThrow(() => validateDemoMediaCatalog(candidate));
	}
});

test("remote checker loads the checked-in catalog and HEAD-verifies every URL without a token", async () => {
	const { pointer, manifest } = validUploadFixture();
	const plan = createUploadPlan({
		repoRoot: "/repo",
		pointer,
		manifest,
		baseUrl: AUTHORIZED_MEDIA_ORIGIN,
	});
	const catalog = buildDemoMediaCatalog({ manifest, plan });
	const calls = [];
	const lines = [];
	const result = await checkRemoteMedia({
		repoRoot: "/repo",
		async readFile(path) {
			assert.equal(path, "/repo/apps/web/app/lib/demo-media.json");
			return JSON.stringify(catalog);
		},
		async fetch(url, options) {
			calls.push({ url, options });
			return response(
				200,
				url.endsWith(".mp4") ? "video/mp4" : "video/webm",
			);
		},
		log(line) {
			lines.push(line);
		},
	});
	assert.deepEqual(result.catalog, catalog);
	assert.equal(calls.length, 8);
	for (const call of calls) {
		assert.equal(call.options.method, "HEAD");
		assert.equal(call.options.redirect, "error");
		assert.ok(call.options.signal instanceof AbortSignal);
		assert.equal("headers" in call.options, false);
	}
	assert.equal(lines.length, 8);
	assert.ok(lines.every((line) => line.startsWith("PASS remote:")));
});

test("remote checker fails for a missing URL, non-200 status, or wrong content type", async () => {
	const { pointer, manifest } = validUploadFixture();
	const catalog = buildDemoMediaCatalog({
		manifest,
		plan: createUploadPlan({
			repoRoot: "/repo",
			pointer,
			manifest,
			baseUrl: AUTHORIZED_MEDIA_ORIGIN,
		}),
	});
	for (const [name, mutate, fetch, pattern] of [
		[
			"missing URL",
			(value) => {
				value.test.webm = "";
			},
			async () => response(200, "video/webm"),
			/test\.webm.*HTTPS URL/i,
		],
		[
			"non-200",
			() => {},
			async (url) =>
				response(
					url.endsWith("author.mp4") ? 404 : 200,
					url.endsWith(".mp4") ? "video/mp4" : "video/webm",
				),
			/author\.mp4.*200.*404/i,
		],
		[
			"wrong type",
			() => {},
			async (url) =>
				response(
					200,
					url.endsWith("run.webm")
						? "application/octet-stream"
						: url.endsWith(".mp4")
							? "video/mp4"
							: "video/webm",
				),
			/run\.webm.*video\/webm.*application\/octet-stream/i,
		],
	]) {
		const candidate = structuredClone(catalog);
		mutate(candidate);
		await assert.rejects(
			checkRemoteMedia({
				repoRoot: "/repo",
				async readFile() {
					return JSON.stringify(candidate);
				},
				fetch,
				log() {},
			}),
			pattern,
			name,
		);
	}
});

test("media checker CLI requires exactly one local or remote mode", () => {
	assert.deepEqual(parseMediaCheckArguments(["--", "--remote"]), {
		remote: true,
	});
	assert.deepEqual(parseMediaCheckArguments(["--local"]), { local: true });
	for (const args of [[], ["--local", "--remote"], ["--remote", "--remote"]]) {
		assert.throws(
			() => parseMediaCheckArguments(args),
			/Usage:.*--local.*--remote/,
		);
	}
});

test("catalog writer removes its temporary path after real write and rename failures", async () => {
	const root = await mkdtemp(join(tmpdir(), "dawn-demo-catalog-atomic-"));
	try {
		const target = join(root, "apps/web/app/lib/demo-media.json");
		const temporary = `${target}.tmp`;
		const parent = join(root, "apps/web/app/lib");
		await mkdir(parent, { recursive: true });
		const outsideDirectory = join(root, "outside-directory");
		await mkdir(outsideDirectory);
		await symlink(outsideDirectory, temporary);
		await assert.rejects(
			writeDemoMediaCatalog({ safe: true }, { repoRoot: root }),
			/EISDIR|illegal operation|directory/i,
		);
		await assert.rejects(lstat(temporary), /ENOENT/);
		assert.equal((await lstat(outsideDirectory)).isDirectory(), true);
		await mkdir(target);
		await assert.rejects(
			writeDemoMediaCatalog({ safe: true }, { repoRoot: root }),
			/EISDIR|ENOTEMPTY|directory/i,
		);
		await assert.rejects(lstat(temporary), /ENOENT/);
		assert.equal((await lstat(target)).isDirectory(), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
