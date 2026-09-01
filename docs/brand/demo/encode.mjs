import { spawn as nodeSpawn } from "node:child_process";
import {
	mkdir as nodeMkdir,
	rename as nodeRename,
	rm as nodeRm,
	writeFile as nodeWriteFile,
} from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import { MEDIA_CAPTIONS } from "./check-media.mjs";
import { spawnManaged, stopManaged } from "./processes.mjs";

const OUTPUT_WIDTH = 1440;
const OUTPUT_HEIGHT = 810;
const OUTPUT_FPS = 30;
const SCENE_END_GUARD_MS = 200;

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

function segment(scene, sourceStartMs, sourceEndMs, targetDuration) {
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
				segment("author", author.startMs, author.endMs, 7),
				segment("test", test.startMs, test.endMs, 6),
				segment(
					"workbench",
					workbench.startMs,
					restoration.endMs,
					9,
				),
				segment("close", close.startMs, close.endMs, 2),
			],
			posterTime: author.startMs / 1_000 + 0.75,
		},
		author: {
			duration: 9,
			segments: [segment("author", author.startMs, author.endMs, 9)],
			posterTime: author.startMs / 1_000 + 0.75,
		},
		test: {
			duration: 9,
			segments: [segment("test", test.startMs, test.endMs, 9)],
			posterTime: test.startMs / 1_000 + 0.75,
		},
		run: {
			duration: 10,
			segments: [
				segment(
					"run-completed",
					completed.startMs,
					completed.endMs,
					3,
				),
				segment(
					"reload-and-restoration",
					restoration.startMs,
					restoration.endMs,
					7,
				),
			],
			posterTime: Math.max(
				restoration.startMs / 1_000,
				restoration.endMs / 1_000 - 0.75,
			),
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

function buildTimelineFilter(plan, { gif = false } = {}) {
	const filters = [];
	const labels = [];
	for (const [index, plannedSegment] of plan.segments.entries()) {
		const sourceDuration = Math.min(
			plannedSegment.duration,
			plannedSegment.sourceEnd - plannedSegment.sourceStart,
		);
		if (!(sourceDuration > 0)) {
			throw new Error(`${plannedSegment.scene} has no source frames`);
		}
		const holdDuration = Math.max(0, plannedSegment.duration - sourceDuration);
		const label = `segment${index}`;
		filters.push(
			`[0:v]trim=start=${plannedSegment.sourceStart.toFixed(6)}:duration=${sourceDuration.toFixed(6)},setpts=PTS-STARTPTS,fps=${OUTPUT_FPS},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:flags=lanczos,tpad=stop_mode=clone:stop_duration=${holdDuration.toFixed(6)}[${label}]`,
		);
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

async function encodeVideo({ source, destination, plan, format, signal }) {
	const temporaryPath = `${destination}.tmp.${format}`;
	const { filter, output } = buildTimelineFilter(plan);
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
	await runEncoderCommand(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			source,
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
	await nodeRename(temporaryPath, destination);
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

async function encodeGif({ source, destination, plan, signal }) {
	const temporaryPath = `${destination}.tmp.gif`;
	const { filter, output } = buildTimelineFilter(plan, { gif: true });
	await runEncoderCommand(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			source,
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
	await nodeRename(temporaryPath, destination);
}

async function writeJsonAtomic(path, value) {
	const temporaryPath = `${path}.tmp`;
	await nodeWriteFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await nodeRename(temporaryPath, path);
}

export async function encodeCaptureArtifacts({
	repoRoot,
	artifactsDir,
	recordingsDir,
	summary,
	summaryPath,
	signal,
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
	if (!source.startsWith(`${recordingsDir}/`)) {
		throw new Error("capture recording is outside the run recordings directory");
	}
	const plans = createTimelinePlan(summary);
	const outputDir = join(artifactsDir, "output");
	const posterDir = join(repoRoot, "apps/web/public/demo");
	await Promise.all([
		nodeMkdir(outputDir, { recursive: true }),
		nodeMkdir(posterDir, { recursive: true }),
	]);

	const clips = {};
	for (const [name, plan] of Object.entries(plans)) {
		signal?.throwIfAborted();
		const mp4 = join(outputDir, `${name}.mp4`);
		const webm = join(outputDir, `${name}.webm`);
		const poster = join(posterDir, `${name}-poster.webp`);
		await encodeVideo({ source, destination: mp4, plan, format: "mp4", signal });
		await encodeVideo({
			source,
			destination: webm,
			plan,
			format: "webm",
			signal,
		});
		await encodePoster({
			source,
			destination: poster,
			time: plan.posterTime,
			signal,
		});
		clips[name] = { mp4, webm, poster, duration: plan.duration };
	}
	const gif = join(repoRoot, "docs/brand/product-loop.gif");
	await encodeGif({
		source,
		destination: gif,
		plan: plans["product-loop"],
		signal,
	});
	signal?.throwIfAborted();

	const manifestPath = join(artifactsDir, "media-manifest.json");
	const manifest = {
		schemaVersion: 1,
		runId: summary.runId,
		captureSummaryPath: summaryPath,
		sourceRecording: source,
		outputRoot: outputDir,
		clips,
		gif,
		captions: MEDIA_CAPTIONS,
	};
	await writeJsonAtomic(manifestPath, manifest);
	await writeJsonAtomic(
		join(repoRoot, "docs/brand/demo/artifacts/latest-media.json"),
		{ schemaVersion: 1, runId: summary.runId, manifestPath },
	);
	return manifest;
}
