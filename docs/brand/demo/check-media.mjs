import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const MEDIA_SCHEMA_VERSION = 1;

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

function requireExactPath(actualPath, expectedPath, description) {
	if (
		typeof actualPath !== "string" ||
		resolve(actualPath) !== resolve(expectedPath)
	) {
		throw new Error(
			`${description} must be inside the expected run output root at ${expectedPath}`,
		);
	}
}

function validateLatestPointerLayout({ repoRoot, pointer }) {
	if (pointer?.schemaVersion !== MEDIA_SCHEMA_VERSION) {
		throw new Error(
			`unsupported latest-media schema ${pointer?.schemaVersion ?? "missing"}`,
		);
	}
	if (
		typeof pointer.runId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(pointer.runId)
	) {
		throw new Error("latest-media pointer has an invalid run ID");
	}
	const runRoot = join(
		resolve(repoRoot),
		"docs/brand/demo/artifacts/runs",
		pointer.runId,
	);
	const manifestPath = join(runRoot, "media-manifest.json");
	requireExactPath(pointer.manifestPath, manifestPath, "manifest path");
	return { runRoot, manifestPath };
}

export function validateMediaManifestLayout({ repoRoot, pointer, manifest }) {
	const { runRoot, manifestPath } = validateLatestPointerLayout({
		repoRoot,
		pointer,
	});
	if (manifest?.schemaVersion !== MEDIA_SCHEMA_VERSION) {
		throw new Error(
			`unsupported media manifest schema ${manifest?.schemaVersion ?? "missing"}`,
		);
	}
	if (pointer.runId !== manifest.runId) {
		throw new Error("pointer and manifest run IDs differ");
	}
	const outputRoot = join(runRoot, "output");
	requireExactPath(manifest.outputRoot, outputRoot, "manifest output root");
	const publicationRoot = join(runRoot, "publication");
	for (const { name } of MEDIA_CONTRACTS) {
		const clip = manifest.clips?.[name];
		requireExactPath(
			clip?.mp4,
			join(outputRoot, `${name}.mp4`),
			`${name}.mp4`,
		);
		requireExactPath(
			clip?.webm,
			join(outputRoot, `${name}.webm`),
			`${name}.webm`,
		);
		requireExactPath(
			clip?.poster,
			join(publicationRoot, `${name}-poster.webp`),
			`${name} poster`,
		);
		if (!/^[a-f0-9]{64}$/u.test(manifest.assetHashes?.posters?.[name] ?? "")) {
			throw new Error(`${name} poster hash is missing or invalid`);
		}
	}
	requireExactPath(
		manifest.gif,
		join(publicationRoot, "product-loop.gif"),
		"flagship GIF",
	);
	if (!/^[a-f0-9]{64}$/u.test(manifest.assetHashes?.gif ?? "")) {
		throw new Error("flagship GIF hash is missing or invalid");
	}
	return { runRoot, manifestPath, outputRoot, publicationRoot };
}

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

export async function probeFile(path, { signal, exec = execFile } = {}) {
	signal?.throwIfAborted();
	try {
		const { stdout } = await exec(
			"ffprobe",
			[
				"-v",
				"error",
				"-show_streams",
				"-show_format",
				"-of",
				"json",
				path,
			],
			{ ...(signal !== undefined ? { signal } : {}) },
		);
		signal?.throwIfAborted();
		return JSON.parse(stdout);
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		throw error;
	}
}

async function hashFile(path, readFile = nodeReadFile) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readLatestManifest(repoRoot, readFile = nodeReadFile) {
	const pointerPath = join(
		repoRoot,
		"docs/brand/demo/artifacts/latest-media.json",
	);
	const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
	if (typeof pointer.manifestPath !== "string") {
		throw new Error(`${pointerPath} does not name a media manifest`);
	}
	validateLatestPointerLayout({ repoRoot, pointer });
	const manifest = JSON.parse(await readFile(pointer.manifestPath, "utf8"));
	validateMediaManifestLayout({ repoRoot, pointer, manifest });
	return { pointer, manifest };
}

async function collectMediaFiles(
	repoRoot,
	manifest,
	{
		published,
		stat = nodeStat,
		access = nodeAccess,
		probe = probeFile,
		readFile = nodeReadFile,
		hash = (path) => hashFile(path, readFile),
		signal,
	} = {},
) {
	const files = new Map();
	for (const contract of MEDIA_CONTRACTS) {
		const clip = manifest.clips?.[contract.name];
		for (const [kind, logicalPath] of [
			["mp4", contract.mp4],
			["webm", contract.webm],
		]) {
			const actualPath = clip?.[kind];
			if (typeof actualPath !== "string") continue;
			const info = await stat(actualPath);
			files.set(logicalPath, {
				size: info.size,
				probe: await probe(actualPath, { signal }),
				sha256: await hash(actualPath),
			});
		}
		const posterPath = published ? join(repoRoot, contract.poster) : clip?.poster;
		try {
			await access(posterPath);
			files.set(contract.poster, {
				size: (await stat(posterPath)).size,
				probe: await probe(posterPath, { signal }),
			});
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	const gifPath = published
		? join(repoRoot, "docs/brand/product-loop.gif")
		: manifest.gif;
	try {
		const info = await stat(gifPath);
		files.set("docs/brand/product-loop.gif", {
			size: info.size,
			probe: await probe(gifPath, { signal }),
		});
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const transcriptPath = join(repoRoot, "docs/brand/demo/transcript.md");
	try {
		files.set("docs/brand/demo/transcript.md", {
			size: (await stat(transcriptPath)).size,
			text: await readFile(transcriptPath, "utf8"),
		});
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	return files;
}

export async function validateStagedMediaManifest({
	repoRoot,
	manifest,
	manifestPath,
	stat = nodeStat,
	access = nodeAccess,
	probe = probeFile,
	readFile = nodeReadFile,
	hash = (path) => hashFile(path, readFile),
	signal,
}) {
	validateMediaManifestLayout({
		repoRoot,
		pointer: {
			schemaVersion: MEDIA_SCHEMA_VERSION,
			runId: manifest.runId,
			manifestPath,
		},
		manifest,
	});
	for (const { name } of MEDIA_CONTRACTS) {
		const measured = await hash(manifest.clips[name].poster);
		if (measured !== manifest.assetHashes.posters[name]) {
			throw new Error(`${name} staged poster hash does not match its manifest`);
		}
	}
	if ((await hash(manifest.gif)) !== manifest.assetHashes.gif) {
		throw new Error("staged flagship GIF hash does not match its manifest");
	}
	const files = await collectMediaFiles(repoRoot, manifest, {
		published: false,
		stat,
		access,
		probe,
		readFile,
		hash,
		signal,
	});
	const failures = await validateLocalMediaContract({
		files,
		captions: manifest.captions ?? MEDIA_CAPTIONS,
	});
	if (failures.length > 0) {
		throw new Error(`Staged media contract failed:\n- ${failures.join("\n- ")}`);
	}
}

async function verifyPublishedCorrespondence(
	repoRoot,
	manifest,
	{ hash = hashFile } = {},
) {
	for (const contract of MEDIA_CONTRACTS) {
		const stagedHash = await hash(manifest.clips[contract.name].poster);
		const publishedHash = await hash(join(repoRoot, contract.poster));
		const expectedHash = manifest.assetHashes.posters[contract.name];
		if (stagedHash !== expectedHash || publishedHash !== expectedHash) {
			throw new Error(
				`${contract.name} fixed poster does not correspond to run ${manifest.runId}`,
			);
		}
	}
	const stagedGifHash = await hash(manifest.gif);
	const publishedGifHash = await hash(
		join(repoRoot, "docs/brand/product-loop.gif"),
	);
	if (
		stagedGifHash !== manifest.assetHashes.gif ||
		publishedGifHash !== manifest.assetHashes.gif
	) {
		throw new Error(
			`fixed flagship GIF does not correspond to run ${manifest.runId}`,
		);
	}
}

export async function checkLocalMedia({
	repoRoot = DEFAULT_REPO_ROOT,
	readFile = nodeReadFile,
	stat = nodeStat,
	access = nodeAccess,
	probe = probeFile,
	hash = (path) => hashFile(path, readFile),
	log = console.log,
	signal,
} = {}) {
	const { pointer, manifest } = await readLatestManifest(repoRoot, readFile);
	await verifyPublishedCorrespondence(repoRoot, manifest, { hash });
	const files = await collectMediaFiles(repoRoot, manifest, {
		published: true,
		stat,
		access,
		probe,
		readFile,
		hash,
		signal,
	});
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
	for (const line of passLines) log(line);
	const sourceFiles = new Map();
	for (const contract of MEDIA_CONTRACTS) {
		for (const format of ["mp4", "webm"]) {
			sourceFiles.set(
				manifest.clips[contract.name][format],
				files.get(contract[format]),
			);
		}
	}
	return { pointer, manifest, sourceFiles, passLines };
}

const DEMO_MEDIA_KEYS = Object.freeze([
	"productLoop",
	"author",
	"test",
	"run",
]);
const DEMO_MEDIA_FIELDS = Object.freeze([
	"mp4",
	"webm",
	"poster",
	"caption",
	"ariaLabel",
	"transcript",
]);
const DEMO_MEDIA_NAMES = Object.freeze({
	productLoop: "product-loop",
	author: "author",
	test: "test",
	run: "run",
});

export function urlHasExplicitPort(value) {
	if (typeof value !== "string") return false;
	const authorityMatch = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(value);
	if (authorityMatch === null) return false;
	const authority = authorityMatch[1];
	const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
	if (hostAndPort.startsWith("[")) {
		const closingBracket = hostAndPort.indexOf("]");
		return closingBracket !== -1 && hostAndPort[closingBracket + 1] === ":";
	}
	return hostAndPort.includes(":");
}

function requireHttpsUrl(value, description) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`${description} must be an HTTPS URL`);
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new Error(`${description} must be an HTTPS URL without credentials`);
	}
	if (urlHasExplicitPort(value)) {
		throw new Error(`${description} must not use an explicit port`);
	}
	if (value !== parsed.href) {
		throw new Error(`${description} must use canonical HTTPS URL serialization`);
	}
	return parsed;
}

function requireStableMediaUrl(value, key, format) {
	const description = `${key}.${format}`;
	const parsed = requireHttpsUrl(value, description);
	const expectedPath = `/demo/${DEMO_MEDIA_NAMES[key]}.${format}`;
	if (
		parsed.pathname !== expectedPath ||
		parsed.search !== "" ||
		parsed.hash !== ""
	) {
		throw new Error(
			`${description} must use the exact stable path ${expectedPath} with no query or fragment`,
		);
	}
	return parsed;
}

export function validateDemoMediaCatalog(catalog) {
	if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog)) {
		throw new Error("demo media catalog must be an object");
	}
	const actualKeys = Object.keys(catalog);
	if (
		actualKeys.length !== DEMO_MEDIA_KEYS.length ||
		DEMO_MEDIA_KEYS.some((key, index) => actualKeys[index] !== key)
	) {
		throw new Error(
			`demo media catalog must contain exactly ${DEMO_MEDIA_KEYS.join(", ")} in order`,
		);
	}
	let mediaOrigin;
	for (const key of DEMO_MEDIA_KEYS) {
		const entry = catalog[key];
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`${key} catalog entry must be an object`);
		}
		const actualFields = Object.keys(entry).sort();
		const expectedFields = [...DEMO_MEDIA_FIELDS].sort();
		const missingField = DEMO_MEDIA_FIELDS.find(
			(field) => !Object.hasOwn(entry, field),
		);
		if (missingField !== undefined) {
			throw new Error(`${key}.${missingField} is required`);
		}
		if (
			actualFields.length !== expectedFields.length ||
			expectedFields.some((field, index) => actualFields[index] !== field)
		) {
			throw new Error(
				`${key} catalog entry must contain exactly ${DEMO_MEDIA_FIELDS.join(", ")}`,
			);
		}
		for (const field of ["poster", "caption", "ariaLabel", "transcript"]) {
			if (typeof entry[field] !== "string" || entry[field].trim() === "") {
				throw new Error(`${key}.${field} is required`);
			}
		}
		const mp4 = requireStableMediaUrl(entry.mp4, key, "mp4");
		const webm = requireStableMediaUrl(entry.webm, key, "webm");
		mediaOrigin ??= mp4.origin;
		if (mp4.origin !== mediaOrigin || webm.origin !== mediaOrigin) {
			throw new Error("all demo media URLs must use the same public origin");
		}
		if (entry.poster !== `/demo/${DEMO_MEDIA_NAMES[key]}-poster.webp`) {
			throw new Error(`${key}.poster must use its local /demo/*.webp path`);
		}
		requireHttpsUrl(entry.transcript, `${key}.transcript`);
	}
	return catalog;
}

export async function runBoundedRemoteOperation({
	label,
	timeoutMs,
	signal,
	operation,
}) {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new TypeError("remote operation timeout must be a positive integer");
	}
	signal?.throwIfAborted();
	const controller = new AbortController();
	const forwardAbort = () => controller.abort(signal.reason);
	signal?.addEventListener("abort", forwardAbort, { once: true });
	const timer = setTimeout(() => {
		const timeout = new Error(`${label} timed out after ${timeoutMs}ms`);
		timeout.code = "DAWN_MEDIA_REMOTE_TIMEOUT";
		controller.abort(timeout);
	}, timeoutMs);
	try {
		const result = await operation(controller.signal);
		if (controller.signal.aborted) throw controller.signal.reason;
		return result;
	} catch (error) {
		if (controller.signal.aborted) throw controller.signal.reason;
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", forwardAbort);
	}
}

export async function verifyRemoteMediaCatalog({
	catalog,
	fetch = globalThis.fetch,
	log = console.log,
	timeoutMs = 15_000,
	signal,
} = {}) {
	validateDemoMediaCatalog(catalog);
	const checks = [];
	for (const key of DEMO_MEDIA_KEYS) {
		for (const [format, expectedContentType] of [
			["mp4", "video/mp4"],
			["webm", "video/webm"],
		]) {
			const url = catalog[key][format];
			try {
				const response = await runBoundedRemoteOperation({
					label: `HEAD ${key}.${format}`,
					timeoutMs,
					signal,
					operation: (operationSignal) =>
						fetch(url, {
							method: "HEAD",
							redirect: "error",
							signal: operationSignal,
						}),
				});
				if (response.status !== 200) {
					throw new Error(
						`${key}.${format} must return 200; received ${response.status}`,
					);
				}
				const actualContentType = response.headers.get("content-type");
				if (actualContentType !== expectedContentType) {
					throw new Error(
						`${key}.${format} must return ${expectedContentType}; received ${actualContentType ?? "missing"}`,
					);
				}
			} catch (error) {
				const annotated = new Error(
					error instanceof Error ? error.message : String(error),
				);
				annotated.verificationUrl = url;
				if (error?.code === "DAWN_MEDIA_REMOTE_TIMEOUT") {
					annotated.code = "DAWN_MEDIA_REMOTE_TIMEOUT";
				}
				if (error?.name === "AbortError") annotated.name = "AbortError";
				throw annotated;
			}
			const line = `PASS remote: ${key}.${format} is 200 ${expectedContentType}`;
			log(line);
			checks.push(line);
		}
	}
	return checks;
}

export async function checkRemoteMedia({
	repoRoot = DEFAULT_REPO_ROOT,
	readFile = nodeReadFile,
	fetch = globalThis.fetch,
	log = console.log,
	timeoutMs = 15_000,
	signal,
} = {}) {
	const catalogPath = join(repoRoot, "apps/web/app/lib/demo-media.json");
	const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
	const passLines = await verifyRemoteMediaCatalog({
		catalog,
		fetch,
		log,
		timeoutMs,
		signal,
	});
	return { catalog, passLines };
}

export function parseMediaCheckArguments(args) {
	const forwarded = args.filter((arg) => arg !== "--");
	if (forwarded.length !== 1) {
		throw new Error(
			"Usage: node docs/brand/demo/check-media.mjs (--local | --remote)",
		);
	}
	if (forwarded[0] === "--local") return { local: true };
	if (forwarded[0] === "--remote") return { remote: true };
	throw new Error(
		"Usage: node docs/brand/demo/check-media.mjs (--local | --remote)",
	);
}

function isMainModule() {
	return (
		process.argv[1] !== undefined &&
		pathToFileURL(resolve(process.argv[1])).href === import.meta.url
	);
}

if (isMainModule()) {
	try {
		const mode = parseMediaCheckArguments(process.argv.slice(2));
		if (mode.local) await checkLocalMedia();
		else await checkRemoteMedia();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
