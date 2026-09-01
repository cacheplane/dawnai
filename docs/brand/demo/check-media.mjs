import { execFile as nodeExecFile } from "node:child_process";
import {
	access as nodeAccess,
	readFile as nodeReadFile,
	stat as nodeStat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(nodeExecFile);
const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, "../../..");
const VIDEO_BYTE_LIMIT = 2_000_000;
const GIF_BYTE_LIMIT = 4_000_000;

export const MEDIA_CAPTIONS = Object.freeze({
	"product-loop":
		"Author a file-system route, prove it with npm test, run it in the Dawn Workbench, then restore the same thread after a browser reload.",
	author:
		"Inspect the generated research route, co-located route files, shared searchCorpus tool, and offline test harness.",
	test: "Run npm test and see the deterministic research scenario pass without a provider key.",
	run: "Complete a fixture-backed Workbench run, reload the browser, reopen the same thread, and restore its transcript.",
});

export const MEDIA_CONTRACTS = Object.freeze(
	[
		{ name: "product-loop", minimumDuration: 20, maximumDuration: 30 },
		{ name: "author", minimumDuration: 8, maximumDuration: 12 },
		{ name: "test", minimumDuration: 8, maximumDuration: 12 },
		{ name: "run", minimumDuration: 8, maximumDuration: 12 },
	].map((contract) =>
		Object.freeze({
			...contract,
			mp4: `docs/brand/demo/artifacts/output/${contract.name}.mp4`,
			webm: `docs/brand/demo/artifacts/output/${contract.name}.webm`,
			poster: `apps/web/public/demo/${contract.name}-poster.webp`,
			...(contract.name === "product-loop"
				? { gif: "docs/brand/product-loop.gif" }
				: {}),
		}),
	),
);

function videoStream(probe) {
	return probe?.streams?.find((stream) => stream.codec_type === "video");
}

function frameRate(value) {
	if (typeof value !== "string") return Number.NaN;
	const [numerator, denominator] = value.split("/").map(Number);
	return denominator === 0 ? Number.NaN : numerator / denominator;
}

function duration(probe) {
	const value = Number(probe?.format?.duration ?? videoStream(probe)?.duration);
	return Number.isFinite(value) ? value : Number.NaN;
}

function validateVideoFile({
	logicalPath,
	file,
	clip,
	expectedCodec,
	byteLimit,
}) {
	const failures = [];
	if (file === undefined) {
		failures.push(`${logicalPath} is missing`);
		return failures;
	}
	const stream = videoStream(file.probe);
	if (stream === undefined) {
		failures.push(`${logicalPath} has no video stream`);
		return failures;
	}
	if (stream.width !== 1440 || stream.height !== 810) {
		failures.push(
			`${logicalPath} must be exactly 1440x810 (16:9); received ${stream.width ?? "unknown"}x${stream.height ?? "unknown"}`,
		);
	}
	const measuredFrameRate = frameRate(
		expectedCodec === "gif"
			? (stream.r_frame_rate ?? stream.avg_frame_rate)
			: stream.avg_frame_rate,
	);
	if (Math.abs(measuredFrameRate - 30) > 0.001) {
		failures.push(`${logicalPath} must be exactly 30 fps`);
	}
	if (stream.codec_name !== expectedCodec) {
		const codecLabel = expectedCodec === "h264" ? "H.264" : expectedCodec.toUpperCase();
		failures.push(`${logicalPath} must use ${codecLabel}`);
	}
	const measuredDuration = duration(file.probe);
	if (
		!Number.isFinite(measuredDuration) ||
		measuredDuration < clip.minimumDuration ||
		measuredDuration > clip.maximumDuration
	) {
		failures.push(
			`${clip.name} must be ${clip.minimumDuration}-${clip.maximumDuration} seconds; ${logicalPath} is ${Number.isFinite(measuredDuration) ? measuredDuration : "unknown"}`,
		);
	}
	if (!Number.isSafeInteger(file.size) || file.size > byteLimit) {
		failures.push(`${logicalPath} must be at most ${byteLimit.toLocaleString("en-US")} bytes`);
	}
	return failures;
}

function captionClaimsScaffolding(caption) {
	return /\bscaffold(?:ed|ing|s)?\b/iu.test(caption);
}

function validatePoster(logicalPath, file) {
	if (file === undefined) return [`poster is missing: ${logicalPath}`];
	const failures = [];
	const stream = videoStream(file.probe);
	if (stream?.codec_name !== "webp") {
		failures.push(`${logicalPath} must use WebP`);
	}
	if (stream?.width !== 1440 || stream?.height !== 810) {
		failures.push(`${logicalPath} must be exactly 1440x810`);
	}
	return failures;
}

export async function validateLocalMediaContract({ files, captions }) {
	if (!(files instanceof Map)) throw new TypeError("files must be a Map");
	if (captions === null || typeof captions !== "object") {
		throw new TypeError("captions must be an object");
	}
	const failures = [];
	for (const contract of MEDIA_CONTRACTS) {
		failures.push(
			...validateVideoFile({
				logicalPath: contract.mp4,
				file: files.get(contract.mp4),
				clip: contract,
				expectedCodec: "h264",
				byteLimit: VIDEO_BYTE_LIMIT,
			}),
			...validateVideoFile({
				logicalPath: contract.webm,
				file: files.get(contract.webm),
				clip: contract,
				expectedCodec: "vp9",
				byteLimit: VIDEO_BYTE_LIMIT,
			}),
		);
		failures.push(...validatePoster(contract.poster, files.get(contract.poster)));
		const caption = captions[contract.name];
		if (typeof caption !== "string" || caption.trim() === "") {
			failures.push(`${contract.name} caption is missing`);
		} else if (captionClaimsScaffolding(caption)) {
			failures.push(
				`${contract.name} caption must not claim scaffolding appears in the footage`,
			);
		}
	}
	const flagship = MEDIA_CONTRACTS[0];
	failures.push(
		...validateVideoFile({
			logicalPath: flagship.gif,
			file: files.get(flagship.gif),
			clip: flagship,
			expectedCodec: "gif",
			byteLimit: GIF_BYTE_LIMIT,
		}),
	);
	const transcript = files.get("docs/brand/demo/transcript.md");
	if (
		transcript === undefined ||
		typeof transcript.text !== "string" ||
		transcript.text.trim() === ""
	) {
		failures.push("media transcript is missing or empty");
	}
	return failures;
}

async function probeFile(path) {
	const { stdout } = await execFile("ffprobe", [
		"-v",
		"error",
		"-show_streams",
		"-show_format",
		"-of",
		"json",
		path,
	]);
	return JSON.parse(stdout);
}

async function readLatestManifest(repoRoot) {
	const pointerPath = join(
		repoRoot,
		"docs/brand/demo/artifacts/latest-media.json",
	);
	const pointer = JSON.parse(await nodeReadFile(pointerPath, "utf8"));
	if (typeof pointer.manifestPath !== "string") {
		throw new Error(`${pointerPath} does not name a media manifest`);
	}
	return JSON.parse(await nodeReadFile(pointer.manifestPath, "utf8"));
}

async function collectLocalFiles(repoRoot, manifest) {
	const files = new Map();
	for (const contract of MEDIA_CONTRACTS) {
		const clip = manifest.clips?.[contract.name];
		for (const [kind, logicalPath] of [
			["mp4", contract.mp4],
			["webm", contract.webm],
		]) {
			const actualPath = clip?.[kind];
			if (typeof actualPath !== "string") continue;
			const info = await nodeStat(actualPath);
			files.set(logicalPath, {
				size: info.size,
				probe: await probeFile(actualPath),
			});
		}
		const posterPath = join(repoRoot, contract.poster);
		try {
			await nodeAccess(posterPath);
			files.set(contract.poster, {
				size: (await nodeStat(posterPath)).size,
				probe: await probeFile(posterPath),
			});
		} catch {}
	}
	const gifPath = join(repoRoot, "docs/brand/product-loop.gif");
	try {
		const info = await nodeStat(gifPath);
		files.set("docs/brand/product-loop.gif", {
			size: info.size,
			probe: await probeFile(gifPath),
		});
	} catch {}
	const transcriptPath = join(repoRoot, "docs/brand/demo/transcript.md");
	try {
		files.set("docs/brand/demo/transcript.md", {
			size: (await nodeStat(transcriptPath)).size,
			text: await nodeReadFile(transcriptPath, "utf8"),
		});
	} catch {}
	return files;
}

export async function checkLocalMedia({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
	const manifest = await readLatestManifest(repoRoot);
	const files = await collectLocalFiles(repoRoot, manifest);
	const failures = await validateLocalMediaContract({
		files,
		captions: manifest.captions ?? MEDIA_CAPTIONS,
	});
	if (failures.length > 0) {
		throw new Error(`Local media contract failed:\n- ${failures.join("\n- ")}`);
	}
	const passLines = [
		"PASS dimensions: every video and GIF is 1440x810 (16:9)",
		"PASS frame rate: every video and GIF is 30 fps",
		"PASS durations: flagship is 20-30s; derivatives are 8-12s",
		"PASS codecs: MP4 is H.264, WebM is VP9, and GIF is animated GIF",
		"PASS byte budgets: MP4/WebM <=2MB each and GIF <=4MB",
		"PASS posters: all four fallbacks are 1440x810 WebP",
		"PASS transcript: the static walkthrough exists",
		"PASS captions: no caption claims scaffolding appears",
	];
	for (const line of passLines) console.log(line);
	return { manifest, passLines };
}

function parseArguments(args) {
	const forwarded = args.filter((arg) => arg !== "--");
	if (forwarded.length !== 1 || forwarded[0] !== "--local") {
		throw new Error("Usage: node docs/brand/demo/check-media.mjs --local");
	}
	return { local: true };
}

function isMainModule() {
	return (
		process.argv[1] !== undefined &&
		pathToFileURL(resolve(process.argv[1])).href === import.meta.url
	);
}

if (isMainModule()) {
	try {
		parseArguments(process.argv.slice(2));
		await checkLocalMedia();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
