import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access as nodeAccess,
	copyFile as nodeCopyFile,
	mkdir as nodeMkdir,
	rename as nodeRename,
	readFile as nodeReadFile,
	rm as nodeRm,
	writeFile as nodeWriteFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import sharp from "sharp";

import {
	MEDIA_CAPTIONS,
	validateStagedMediaManifest,
} from "./check-media.mjs";
import { spawnManaged, stopManaged } from "./processes.mjs";

const OUTPUT_WIDTH = 1440;
const OUTPUT_HEIGHT = 810;
const OUTPUT_FPS = 30;
const SCENE_END_GUARD_MS = 200;
const ACT_LABEL_WIDTH = 224;
const ACT_LABEL_HEIGHT = 58;
const ACT_LABEL_GLYPHS = Object.freeze({
	A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
	E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
	H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
	N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
	O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
	P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
	R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
	T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
	U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
	V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
});

export const ACT_LABELS = Object.freeze({
	author: "Author",
	prove: "Prove",
	run: "Run",
});

function requireScene(scenes, name) {
	const scene = scenes?.[name];
	if (
		scene === undefined ||
		!Number.isFinite(scene.startMs) ||
		!Number.isFinite(scene.endMs) ||
		scene.startMs < 0 ||
		scene.endMs <= scene.startMs
	) {
		throw new Error(`capture summary has an invalid ${name} scene`);
	}
	return scene;
}

function segment(
	scene,
	sourceStartMs,
	sourceEndMs,
	targetDuration,
	actLabel,
) {
	const guardedEndMs = sourceEndMs - SCENE_END_GUARD_MS;
	if (guardedEndMs <= sourceStartMs) {
		throw new Error(`${scene} is too short for a stable final frame`);
	}
	return {
		scene,
		sourceStart: sourceStartMs / 1_000,
		// Scene actions switch the page immediately after their monotonic end.
		// Keep the final sampled frame inside the asserted scene so tpad never
		// freezes the first frame of the next act.
		sourceEnd: guardedEndMs / 1_000,
		duration: targetDuration,
		...(actLabel !== undefined ? { actLabel } : {}),
	};
}

export function createTimelinePlan(summary) {
	if (summary?.videoTimeline?.unit !== "milliseconds") {
		throw new Error("capture summary timeline must use milliseconds");
	}
	const scenes = summary.videoTimeline.scenes;
	const author = requireScene(scenes, "author");
	const test = requireScene(scenes, "test");
	const workbench = requireScene(scenes, "workbench-run");
	const completed = requireScene(scenes, "pre-reload-complete");
	const restoration = requireScene(scenes, "restoration");
	const close = requireScene(scenes, "close");
	const plans = {
		"product-loop": {
			duration: 24,
			segments: [
				segment(
					"author",
					author.startMs,
					author.endMs,
					7,
					ACT_LABELS.author,
				),
				segment(
					"test",
					test.startMs,
					test.endMs,
					6,
					ACT_LABELS.prove,
				),
				segment(
					"workbench",
					workbench.startMs,
					restoration.endMs,
					9,
					ACT_LABELS.run,
				),
				segment("close", close.startMs, close.endMs, 2),
			],
			posterTime: 0.75,
		},
		author: {
			duration: 9,
			actLabel: ACT_LABELS.author,
			segments: [
				segment(
					"author",
					author.startMs,
					author.endMs,
					9,
					ACT_LABELS.author,
				),
			],
			posterTime: 0.75,
		},
		test: {
			duration: 9,
			actLabel: ACT_LABELS.prove,
			segments: [
				segment(
					"test",
					test.startMs,
					test.endMs,
					9,
					ACT_LABELS.prove,
				),
			],
			posterTime: 0.75,
		},
		run: {
			duration: 10,
			actLabel: ACT_LABELS.run,
			segments: [
				segment(
					"run-completed",
					completed.startMs,
					completed.endMs,
					3,
					ACT_LABELS.run,
				),
				segment(
					"reload-and-restoration",
					restoration.startMs,
					restoration.endMs,
					7,
					ACT_LABELS.run,
				),
			],
			posterTime: 9.25,
		},
	};
	return plans;
}

export function runEncoderCommand(
	command,
	args,
	{
		signal,
		spawn = nodeSpawn,
		stop = (child) => stopManaged(child),
		cwd,
	} = {},
) {
	signal?.throwIfAborted();
	const child = spawnManaged(command, args, {
		spawn,
		options: { cwd, stdio: ["ignore", "pipe", "pipe"] },
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});

	return new Promise((resolve, reject) => {
		let settled = false;
		let aborting = false;
		const cleanup = () => {
			child.off("exit", onExit);
			child.off("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error !== undefined) reject(error);
			else resolve(result);
		};
		const onExit = (code, exitSignal) => {
			if (aborting) return;
			if (code === 0) finish(undefined, { stdout, stderr });
			else {
				finish(
					new Error(
						`${command} exited with ${code === null ? `signal ${exitSignal ?? "unknown"}` : `code ${code}`}${stderr ? `\n${stderr}` : ""}`,
					),
				);
			}
		};
		const onError = (error) => {
			if (!aborting) finish(error);
		};
		const onAbort = () => {
			if (aborting || settled) return;
			aborting = true;
			const cancellation = signal.reason ?? new Error("Encoding cancelled");
			Promise.resolve(stop(child)).then(
				() => finish(cancellation),
				(cleanupError) =>
					finish(
						new AggregateError(
							[cancellation, cleanupError],
							"Encoding cancellation cleanup failed",
							{ cause: cancellation },
						),
					),
			);
		};
		child.once("exit", onExit);
		child.once("error", onError);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

async function pathExists(path, access = nodeAccess) {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

export async function publishFixedAssets({
	entries,
	transactionId,
	signal,
	afterPublish = () => {},
	copy = nodeCopyFile,
	rename = nodeRename,
	remove = (path) => nodeRm(path, { force: true }),
	access = nodeAccess,
}) {
	if (!Array.isArray(entries) || entries.length === 0) {
		throw new TypeError("publication entries must be a non-empty array");
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(transactionId ?? "")) {
		throw new TypeError("publication transaction ID is invalid");
	}
	const prepared = entries.map((entry) => ({
		...entry,
		candidatePath: `${entry.targetPath}.next-${transactionId}`,
		backupPath: `${entry.targetPath}.backup-${transactionId}`,
		preserveBackup: false,
	}));
	signal?.throwIfAborted();
	const existingRecoveryPaths = [];
	for (const entry of prepared) {
		if (await pathExists(entry.backupPath, access)) {
			entry.preserveBackup = true;
			existingRecoveryPaths.push(entry.backupPath);
		}
	}
	if (existingRecoveryPaths.length > 0) {
		throw new Error(
			`media publication recovery backups already exist at: ${existingRecoveryPaths.join(", ")}`,
		);
	}
	const states = [];
	try {
		for (const entry of prepared) {
			signal?.throwIfAborted();
			await remove(entry.candidatePath);
			await copy(entry.stagedPath, entry.candidatePath);
		}
		for (const entry of prepared) {
			signal?.throwIfAborted();
			const state = {
				entry,
				hadPrevious: await pathExists(entry.targetPath, access),
				published: false,
			};
			if (state.hadPrevious) {
				await rename(entry.targetPath, entry.backupPath);
			}
			states.push(state);
			signal?.throwIfAborted();
			await rename(entry.candidatePath, entry.targetPath);
			state.published = true;
			signal?.throwIfAborted();
			await afterPublish(entry.name);
		}
	} catch (error) {
		const rollbackErrors = [];
		for (const state of states.reverse()) {
			let targetRemoved = !state.published;
			if (state.published) {
				try {
					await remove(state.entry.targetPath);
					targetRemoved = true;
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
			if (state.hadPrevious) {
				try {
					if (!targetRemoved) {
						throw new Error("published target could not be removed");
					}
					await rename(state.entry.backupPath, state.entry.targetPath);
				} catch (rollbackError) {
					state.entry.preserveBackup = true;
					rollbackErrors.push(
						new Error(
							`failed to restore ${state.entry.targetPath}; recovery bytes remain at ${state.entry.backupPath}`,
							{ cause: rollbackError },
						),
					);
				}
			}
		}
		if (rollbackErrors.length > 0) {
			const recoveryPaths = prepared
				.filter((entry) => entry.preserveBackup)
				.map((entry) => entry.backupPath);
			throw new AggregateError(
				[error, ...rollbackErrors],
				`media publication failed and rollback was incomplete; recovery files preserved at: ${recoveryPaths.join(", ")}`,
				{ cause: error },
			);
		}
		throw error;
	} finally {
		await Promise.all(
			prepared.flatMap((entry) => [
				remove(entry.candidatePath),
				...(entry.preserveBackup ? [] : [remove(entry.backupPath)]),
			]),
		);
	}
}

export function buildTimelineFilter(
	plan,
	{ gif = false, labelInputIndexes = [] } = {},
) {
	const filters = [];
	const labels = [];
	for (const [index, plannedSegment] of plan.segments.entries()) {
		const sourceDuration =
			plannedSegment.sourceEnd - plannedSegment.sourceStart;
		if (!(sourceDuration > 0)) {
			throw new Error(`${plannedSegment.scene} has no source frames`);
		}
		if (sourceDuration > plannedSegment.duration) {
			throw new Error(
				`${plannedSegment.scene} restored endpoint requires ${sourceDuration} seconds but its delivery segment is ${plannedSegment.duration} seconds; refusing to truncate captured evidence`,
			);
		}
		const holdDuration = Math.max(0, plannedSegment.duration - sourceDuration);
		const baseLabel = `segment${index}base`;
		const label = `segment${index}`;
		filters.push(
			`[0:v]trim=start=${plannedSegment.sourceStart.toFixed(6)}:duration=${sourceDuration.toFixed(6)},setpts=PTS-STARTPTS,fps=${OUTPUT_FPS},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:flags=lanczos,tpad=stop_mode=clone:stop_duration=${holdDuration.toFixed(6)}[${baseLabel}]`,
		);
		const labelInputIndex = labelInputIndexes[index];
		if (plannedSegment.actLabel !== undefined && labelInputIndex === undefined) {
			throw new Error(
				`${plannedSegment.actLabel} act label has no visual input`,
			);
		}
		if (labelInputIndex !== undefined) {
			filters.push(
				`[${baseLabel}][${labelInputIndex}:v]overlay=x=W-w-32:y=24:shortest=1[${label}]`,
			);
		} else {
			filters.push(`[${baseLabel}]null[${label}]`);
		}
		labels.push(`[${label}]`);
	}
	filters.push(
		`${labels.join("")}concat=n=${labels.length}:v=1:a=0,trim=duration=${plan.duration},setpts=PTS-STARTPTS[timeline]`,
	);
	if (gif) {
		filters.push(
			"[timeline]split[gifbase][paletteinput]",
			"[paletteinput]palettegen=max_colors=28:stats_mode=diff[palette]",
			"[gifbase][palette]paletteuse=dither=none:diff_mode=rectangle[outv]",
		);
	}
	return { filter: filters.join(";"), output: gif ? "[outv]" : "[timeline]" };
}

function labelGlyphPath(label) {
	const scale = 5;
	const glyphWidth = 5 * scale;
	const gap = scale;
	const startX = 34;
	const startY = 12;
	const commands = [];
	for (const [characterIndex, character] of [...label.toUpperCase()].entries()) {
		const glyph = ACT_LABEL_GLYPHS[character];
		if (glyph === undefined) throw new Error(`missing act-label glyph ${character}`);
		for (const [rowIndex, row] of glyph.entries()) {
			for (const [columnIndex, pixel] of [...row].entries()) {
				if (pixel !== "1") continue;
				const x = startX + characterIndex * (glyphWidth + gap) + columnIndex * scale;
				const y = startY + rowIndex * scale;
				commands.push(`M${x} ${y}h${scale}v${scale}h-${scale}z`);
			}
		}
	}
	return commands.join("");
}

function labelSvg(label) {
	return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ACT_LABEL_WIDTH}" height="${ACT_LABEL_HEIGHT}" viewBox="0 0 ${ACT_LABEL_WIDTH} ${ACT_LABEL_HEIGHT}">
  <rect width="${ACT_LABEL_WIDTH}" height="${ACT_LABEL_HEIGHT}" rx="18" fill="#10121a" fill-opacity="0.9"/>
  <rect x="12" y="12" width="6" height="34" rx="3" fill="#b7f36b"/>
  <path d="${labelGlyphPath(label)}" fill="#ffffff"/>
</svg>`);
}

async function createActLabelAssets({ labelDir, signal }) {
	await nodeMkdir(labelDir, { recursive: true });
	const assets = new Map();
	for (const label of Object.values(ACT_LABELS)) {
		signal?.throwIfAborted();
		const path = join(labelDir, `${label.toLowerCase()}.png`);
		await sharp(labelSvg(label)).png().toFile(path);
		signal?.throwIfAborted();
		assets.set(label, path);
	}
	return assets;
}

function buildLabelInputs(plan, labelAssets) {
	const inputArguments = [];
	const labelInputIndexes = [];
	let inputIndex = 1;
	for (const plannedSegment of plan.segments) {
		if (plannedSegment.actLabel === undefined) {
			labelInputIndexes.push(undefined);
			continue;
		}
		const path = labelAssets.get(plannedSegment.actLabel);
		if (path === undefined) {
			throw new Error(`missing visual asset for ${plannedSegment.actLabel} act`);
		}
		inputArguments.push("-loop", "1", "-framerate", String(OUTPUT_FPS), "-i", path);
		labelInputIndexes.push(inputIndex);
		inputIndex += 1;
	}
	return { inputArguments, labelInputIndexes };
}

export async function encodeVideo({
	source,
	destination,
	plan,
	format,
	labelAssets,
	signal,
	run = runEncoderCommand,
	rename = nodeRename,
	remove = (path) => nodeRm(path, { force: true }),
}) {
	const temporaryPath = `${destination}.tmp.${format}`;
	let published = false;
	const { inputArguments, labelInputIndexes } = buildLabelInputs(
		plan,
		labelAssets,
	);
	const { filter, output } = buildTimelineFilter(plan, { labelInputIndexes });
	const codecArguments =
		format === "mp4"
			? [
					"-c:v",
					"libx264",
					"-preset",
					"slow",
					"-crf",
					"32",
					"-maxrate",
					"420k",
					"-bufsize",
					"840k",
					"-pix_fmt",
					"yuv420p",
					"-movflags",
					"+faststart",
				]
			: [
					"-c:v",
					"libvpx-vp9",
					"-b:v",
					"0",
					"-crf",
					"38",
					"-deadline",
					"good",
					"-cpu-used",
					"2",
					"-row-mt",
					"1",
				];
	try {
		await run(
			"ffmpeg",
			[
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			source,
			...inputArguments,
			"-filter_complex",
			filter,
			"-map",
			output,
			"-an",
			...codecArguments,
			temporaryPath,
			],
			{ signal },
		);
		signal?.throwIfAborted();
		await rename(temporaryPath, destination);
		published = true;
	} finally {
		if (!published) await remove(temporaryPath);
	}
}

export async function encodePoster({
	source,
	destination,
	time,
	signal,
	run = runEncoderCommand,
	convert = (input, output) =>
		sharp(input).webp({ quality: 82, effort: 5 }).toFile(output),
	rename = nodeRename,
	remove = (path) => nodeRm(path, { force: true }),
}) {
	const framePath = `${destination}.tmp.png`;
	const temporaryPath = `${destination}.tmp.webp`;
	let published = false;
	try {
		await run(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-ss",
				String(time),
				"-i",
				source,
				"-frames:v",
				"1",
				"-vf",
				`scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:flags=lanczos`,
				framePath,
			],
			{ signal },
		);
		signal?.throwIfAborted();
		await convert(framePath, temporaryPath);
		signal?.throwIfAborted();
		await rename(temporaryPath, destination);
		published = true;
	} finally {
		await remove(framePath);
		if (!published) await remove(temporaryPath);
	}
}

export async function encodeGif({
	source,
	destination,
	plan,
	labelAssets,
	signal,
	run = runEncoderCommand,
	rename = nodeRename,
	remove = (path) => nodeRm(path, { force: true }),
}) {
	const temporaryPath = `${destination}.tmp.gif`;
	let published = false;
	const { inputArguments, labelInputIndexes } = buildLabelInputs(
		plan,
		labelAssets,
	);
	const { filter, output } = buildTimelineFilter(plan, {
		gif: true,
		labelInputIndexes,
	});
	try {
		await run(
			"ffmpeg",
			[
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			source,
			...inputArguments,
			"-filter_complex",
			filter,
			"-map",
			output,
			"-an",
			"-gifflags",
			"+transdiff",
			temporaryPath,
			],
			{ signal },
		);
		signal?.throwIfAborted();
		await rename(temporaryPath, destination);
		published = true;
	} finally {
		if (!published) await remove(temporaryPath);
	}
}

async function writeJsonAtomic(path, value, { signal } = {}) {
	const temporaryPath = `${path}.tmp`;
	let published = false;
	try {
		await nodeWriteFile(
			temporaryPath,
			`${JSON.stringify(value, null, 2)}\n`,
			"utf8",
		);
		signal?.throwIfAborted();
		await nodeRename(temporaryPath, path);
		published = true;
	} finally {
		if (!published) await nodeRm(temporaryPath, { force: true });
	}
}

async function hashFile(path) {
	return createHash("sha256").update(await nodeReadFile(path)).digest("hex");
}

export async function encodeCaptureArtifacts({
	repoRoot,
	artifactsDir,
	recordingsDir,
	summary,
	summaryPath,
	signal,
	dependencies = {},
}) {
	for (const [value, name] of [
		[repoRoot, "repoRoot"],
		[artifactsDir, "artifactsDir"],
		[recordingsDir, "recordingsDir"],
		[summaryPath, "summaryPath"],
	]) {
		if (typeof value !== "string" || value === "") {
			throw new TypeError(`${name} must be a non-empty string`);
		}
	}
	signal?.throwIfAborted();
	const source = summary?.videoPath ?? summary?.paths?.recording;
	if (typeof source !== "string" || source === "") {
		throw new Error("capture summary does not name a raw recording");
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(summary.runId ?? "")) {
		throw new Error("capture summary has an invalid run ID");
	}
	const expectedArtifactsDir = join(
		resolve(repoRoot),
		"docs/brand/demo/artifacts/runs",
		summary.runId,
	);
	const expectedRecordingsDir = join(
		resolve(repoRoot),
		"docs/brand/demo/raw-recordings/runs",
		summary.runId,
	);
	if (resolve(artifactsDir) !== expectedArtifactsDir) {
		throw new Error("artifacts directory does not match the capture run ID");
	}
	if (resolve(recordingsDir) !== expectedRecordingsDir) {
		throw new Error("recordings directory does not match the capture run ID");
	}
	if (resolve(summaryPath) !== join(expectedArtifactsDir, "capture-summary.json")) {
		throw new Error("capture summary path does not match the capture run ID");
	}
	const sourceRelativePath = relative(resolve(recordingsDir), resolve(source));
	if (
		sourceRelativePath === "" ||
		sourceRelativePath === ".." ||
		sourceRelativePath.startsWith(`..${sep}`) ||
		isAbsolute(sourceRelativePath)
	) {
		throw new Error("capture recording is outside the run recordings directory");
	}
	const encodeVideoImplementation = dependencies.encodeVideo ?? encodeVideo;
	const encodePosterImplementation = dependencies.encodePoster ?? encodePoster;
	const encodeGifImplementation = dependencies.encodeGif ?? encodeGif;
	const validateStagedMedia =
		dependencies.validateStagedMedia ?? validateStagedMediaManifest;
	const afterPhase = dependencies.afterPhase ?? (() => {});
	const plans = createTimelinePlan(summary);
	const outputDir = join(artifactsDir, "output");
	const labelDir = join(artifactsDir, "labels");
	const publicationDir = join(artifactsDir, "publication");
	const posterDir = join(repoRoot, "apps/web/public/demo");
	await Promise.all([
		nodeMkdir(outputDir, { recursive: true }),
		nodeMkdir(publicationDir, { recursive: true }),
		nodeMkdir(posterDir, { recursive: true }),
	]);
	const labelAssets = await createActLabelAssets({ labelDir, signal });

	const clips = {};
	for (const [name, plan] of Object.entries(plans)) {
		signal?.throwIfAborted();
		const mp4 = join(outputDir, `${name}.mp4`);
		const webm = join(outputDir, `${name}.webm`);
		const poster = join(publicationDir, `${name}-poster.webp`);
		await encodeVideoImplementation({
			source,
			destination: mp4,
			plan,
			format: "mp4",
			labelAssets,
			signal,
		});
		await encodeVideoImplementation({
			source,
			destination: webm,
			plan,
			format: "webm",
			labelAssets,
			signal,
		});
		await afterPhase("video", { name });
		await encodePosterImplementation({
			source: mp4,
			destination: poster,
			time: plan.posterTime,
			signal,
		});
		await afterPhase("poster", { name });
		clips[name] = { mp4, webm, poster, duration: plan.duration };
	}
	const gif = join(publicationDir, "product-loop.gif");
	await encodeGifImplementation({
		source,
		destination: gif,
		plan: plans["product-loop"],
		labelAssets,
		signal,
	});
	await afterPhase("gif");
	signal?.throwIfAborted();

	const manifestPath = join(artifactsDir, "media-manifest.json");
	const assetHashes = {
		gif: await hashFile(gif),
		posters: Object.fromEntries(
			await Promise.all(
				Object.entries(clips).map(async ([name, clip]) => [
					name,
					await hashFile(clip.poster),
				]),
			),
		),
	};
	const manifest = {
		schemaVersion: 1,
		runId: summary.runId,
		captureSummaryPath: summaryPath,
		sourceRecording: source,
		outputRoot: outputDir,
		clips,
		gif,
		assetHashes,
		actLabels: Object.values(ACT_LABELS),
		captions: MEDIA_CAPTIONS,
	};
	await validateStagedMedia({ repoRoot, manifest, manifestPath, signal });
	signal?.throwIfAborted();
	const stagedManifest = join(publicationDir, "media-manifest.json");
	await writeJsonAtomic(stagedManifest, manifest, { signal });
	const stagedPointer = join(publicationDir, "latest-media.json");
	await writeJsonAtomic(
		stagedPointer,
		{ schemaVersion: 1, runId: summary.runId, manifestPath },
		{ signal },
	);
	await publishFixedAssets({
		transactionId: summary.runId,
		signal,
		entries: [
			{
				name: "manifest",
				stagedPath: stagedManifest,
				targetPath: manifestPath,
			},
			...Object.entries(clips).map(([name, clip]) => ({
				name: `poster:${name}`,
				stagedPath: clip.poster,
				targetPath: join(posterDir, `${name}-poster.webp`),
			})),
			{
				name: "gif",
				stagedPath: gif,
				targetPath: join(repoRoot, "docs/brand/product-loop.gif"),
			},
			{
				name: "pointer",
				stagedPath: stagedPointer,
				targetPath: join(
					repoRoot,
					"docs/brand/demo/artifacts/latest-media.json",
				),
			},
		],
		afterPublish: async (name) => {
			if (name === "pointer") await afterPhase("pointer");
		},
	});
	return manifest;
}
