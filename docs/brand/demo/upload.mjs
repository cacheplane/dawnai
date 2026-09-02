import { put as vercelBlobPut } from "@vercel/blob";
import { createHash } from "node:crypto";
import {
	mkdir as nodeMkdir,
	readFile as nodeReadFile,
	rename as nodeRename,
	rm as nodeRm,
	writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	checkLocalMedia,
	runBoundedRemoteOperation,
	urlHasExplicitPort,
	validateDemoMediaCatalog,
	validateMediaManifestLayout,
	verifyRemoteMediaCatalog,
} from "./check-media.mjs";

const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, "../../..");
const PUBLIC_BASE_PLACEHOLDER = "<DAWN_MEDIA_PUBLIC_BASE_URL>";
const CATALOG_PATH = "apps/web/app/lib/demo-media.json";
const TRANSCRIPT_BASE_URL =
	"https://github.com/cacheplane/dawnai/blob/main/docs/brand/demo/transcript.md";
const AUTHORIZED_OIDC_STORE_ID = "store_9RQ8eZyGheVy0wOp";
const AUTHORIZED_LEGACY_STORE_ID = AUTHORIZED_OIDC_STORE_ID.slice(
	"store_".length,
);
const AUTHORIZED_OIDC_ORIGIN =
	"https://9rq8ezyghevy0wop.public.blob.vercel-storage.com";
const CREDENTIAL_PAIRING_GUIDANCE =
	"the correct credential mode (VERCEL_OIDC_TOKEN with BLOB_STORE_ID, or BLOB_READ_WRITE_TOKEN) and DAWN_MEDIA_PUBLIC_BASE_URL pairing";

const CLIPS = Object.freeze([
	Object.freeze({
		name: "product-loop",
		catalogKey: "productLoop",
		ariaLabel: "Dawn product loop: author, prove, run, reload, and restore",
		transcript: `${TRANSCRIPT_BASE_URL}#product-loop-24-seconds`,
	}),
	Object.freeze({
		name: "author",
		catalogKey: "author",
		ariaLabel: "Dawn Author clip: inspect a generated route and shared tool",
		transcript: `${TRANSCRIPT_BASE_URL}#author-clip-9-seconds`,
	}),
	Object.freeze({
		name: "test",
		catalogKey: "test",
		ariaLabel: "Dawn Prove clip: run the deterministic offline test",
		transcript: `${TRANSCRIPT_BASE_URL}#test-clip-9-seconds`,
	}),
	Object.freeze({
		name: "run",
		catalogKey: "run",
		ariaLabel: "Dawn Run clip: reload and restore the same Workbench thread",
		transcript: `${TRANSCRIPT_BASE_URL}#run-clip-10-seconds`,
	}),
]);

export const MEDIA_UPLOAD_PATHS = Object.freeze(
	CLIPS.flatMap(({ name }) => [`demo/${name}.mp4`, `demo/${name}.webm`]),
);

const UPLOAD_PATH_SET = new Set(MEDIA_UPLOAD_PATHS);

function usage(message) {
	return new Error(
		`${message}\nUsage: node docs/brand/demo/upload.mjs [--dry-run | --apply]`,
	);
}

export function parseUploadArguments(args) {
	const forwarded = args.filter((arg) => arg !== "--");
	if (forwarded.length === 0) return { apply: false };
	if (forwarded.length === 1 && forwarded[0] === "--dry-run") {
		return { apply: false };
	}
	if (forwarded.length === 1 && forwarded[0] === "--apply") {
		return { apply: true };
	}
	throw usage("Choose exactly one upload mode.");
}

export function validatePublicBaseUrl(value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("DAWN media public base URL must be a valid HTTPS origin");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.pathname !== "/" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.port !== "" ||
		urlHasExplicitPort(value)
	) {
		throw new Error(
			"DAWN media public base URL must be a credential-free HTTPS origin with no port, path, query, or fragment",
		);
	}
	if (value !== parsed.origin) {
		throw new Error(
			"DAWN media public base URL must use canonical HTTPS origin serialization",
		);
	}
	return parsed.origin;
}

export function validateUploadPathname(pathname) {
	if (!UPLOAD_PATH_SET.has(pathname)) {
		throw new Error(
			`Invalid stable media path; expected one of: ${MEDIA_UPLOAD_PATHS.join(", ")}`,
		);
	}
	return pathname;
}

function contentTypeForPath(pathname) {
	return pathname.endsWith(".mp4") ? "video/mp4" : "video/webm";
}

function publicUrl(baseUrl, pathname) {
	return `${baseUrl}/${validateUploadPathname(pathname)}`;
}

export function createUploadPlan({ repoRoot, pointer, manifest, baseUrl }) {
	validateMediaManifestLayout({ repoRoot, pointer, manifest });
	const resolvedBase =
		baseUrl === undefined ? PUBLIC_BASE_PLACEHOLDER : validatePublicBaseUrl(baseUrl);
	return CLIPS.flatMap(({ name }) =>
		["mp4", "webm"].map((format) => {
			const pathname = validateUploadPathname(`demo/${name}.${format}`);
			return Object.freeze({
				clip: name,
				format,
				pathname,
				sourcePath: manifest.clips[name][format],
				contentType: contentTypeForPath(pathname),
				url: publicUrl(resolvedBase, pathname),
			});
		}),
	);
}

export function buildDemoMediaCatalog({ manifest, plan }) {
	const byPath = new Map(plan.map((entry) => [entry.pathname, entry]));
	const catalog = Object.fromEntries(
		CLIPS.map(({ name, catalogKey, ariaLabel, transcript }) => {
			const mp4 = byPath.get(`demo/${name}.mp4`);
			const webm = byPath.get(`demo/${name}.webm`);
			if (mp4 === undefined || webm === undefined) {
				throw new Error(`${name} upload plan is incomplete`);
			}
			return [
				catalogKey,
				{
					mp4: mp4.url,
					webm: webm.url,
					poster: `/demo/${name}-poster.webp`,
					caption: manifest.captions?.[name],
					ariaLabel,
					transcript,
				},
			];
		}),
	);
	return validateDemoMediaCatalog(catalog);
}

export async function writeDemoMediaCatalog(
	catalog,
	{
		repoRoot,
		mkdir = nodeMkdir,
		writeFile = nodeWriteFile,
		rename = nodeRename,
		remove = (path) => nodeRm(path, { force: true }),
	} = {},
) {
	const destination = join(repoRoot, CATALOG_PATH);
	const temporary = `${destination}.tmp`;
	let published = false;
	await mkdir(dirname(destination), { recursive: true });
	try {
		await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o644,
		});
		await rename(temporary, destination);
		published = true;
	} finally {
		if (!published) await remove(temporary);
	}
}

function sanitizeExternalError(error, secrets, context) {
	const raw = error instanceof Error ? error.message : String(error);
	const sanitized = secrets.reduce(
		(message, secret) => message.replaceAll(secret, "<redacted>"),
		raw,
	);
	return new Error(`${context}: ${sanitized}`);
}

function preserveRemoteFailureIdentity(safeError, error) {
	if (error?.code === "DAWN_MEDIA_REMOTE_TIMEOUT") {
		safeError.code = "DAWN_MEDIA_REMOTE_TIMEOUT";
	}
	if (error?.name === "AbortError") {
		safeError.name = "AbortError";
		safeError.code = "DAWN_MEDIA_REMOTE_ABORT";
	}
	return safeError;
}

async function preflightUploadPlan({ plan, sourceFiles, readFile, signal }) {
	if (!(sourceFiles instanceof Map)) {
		throw new Error("validated local video facts are required before upload");
	}
	const preflighted = [];
	for (const entry of plan) {
		signal?.throwIfAborted();
		const fact = sourceFiles.get(entry.sourcePath);
		if (
			fact === undefined ||
			!Number.isSafeInteger(fact.size) ||
			fact.probe === undefined ||
			!/^[a-f0-9]{64}$/u.test(fact.sha256 ?? "")
		) {
			throw new Error(
				`${entry.pathname} lacks validated ffprobe, size, and SHA-256 facts`,
			);
		}
		const body = await readFile(entry.sourcePath);
		if (!(body instanceof Uint8Array)) {
			throw new Error(`${entry.pathname} preflight body must be binary data`);
		}
		if (body.byteLength !== fact.size) {
			throw new Error(
				`${entry.pathname} changed after validation: expected ${fact.size} bytes, received ${body.byteLength}`,
			);
		}
		const sha256 = createHash("sha256").update(body).digest("hex");
		if (sha256 !== fact.sha256) {
			throw new Error(
				`${entry.pathname} SHA-256 does not match its validation-time hash`,
			);
		}
		preflighted.push(
			Object.freeze({
				...entry,
				body,
				size: body.byteLength,
				sha256,
			}),
		);
	}
	return Object.freeze(preflighted);
}

function uploadConvergenceError({ error, secrets, index, plan }) {
	const confirmed = plan.slice(0, index).map(({ pathname }) => pathname);
	const current = plan[index].pathname;
	const pending = plan.slice(index + 1).map(({ pathname }) => pathname);
	const safeError = sanitizeExternalError(
		error,
		secrets,
		`Upload did not converge at ${current}. Confirmed completed stable paths: ${confirmed.length === 0 ? "none" : confirmed.join(", ")}. Potentially completed stable path: ${current}. Definitely pending stable paths: ${pending.length === 0 ? "none" : pending.join(", ")}. The catalog was not written. Use ${CREDENTIAL_PAIRING_GUIDANCE}, then run a full eight-path idempotent replay with --apply; every stable path is overwritten with no random suffix`,
	);
	return preserveRemoteFailureIdentity(safeError, error);
}

function verificationConvergenceError({ error, secrets, plan }) {
	const stablePaths = plan.map(({ pathname }) => pathname).join(", ");
	const currentUrl =
		typeof error?.verificationUrl === "string"
			? error.verificationUrl
			: "the current public URL";
	const safeError = sanitizeExternalError(
		error,
		secrets,
		`Remote verification did not converge after all eight upload calls returned for stable paths: ${stablePaths}. The catalog was not written. The verification outcome is uncertain for ${currentUrl}. Run a full eight-path idempotent replay with --apply using ${CREDENTIAL_PAIRING_GUIDANCE}, or equivalently re-verify all eight public URLs before writing the catalog`,
	);
	return preserveRemoteFailureIdentity(safeError, error);
}

function requireApplyEnvironment(env) {
	const oidcToken = env.VERCEL_OIDC_TOKEN;
	const storeId = env.BLOB_STORE_ID;
	const legacyToken = env.BLOB_READ_WRITE_TOKEN;
	const hasOidcToken = oidcToken !== undefined;
	const hasStoreId = storeId !== undefined;
	const hasLegacyToken = legacyToken !== undefined;
	if (hasLegacyToken && (hasOidcToken || hasStoreId)) {
		throw new Error(
			"Choose exactly one Blob credential mode; OIDC and legacy credentials conflict",
		);
	}
	if (!hasLegacyToken && !hasOidcToken && !hasStoreId) {
		throw new Error(
			"Choose exactly one Blob credential mode: VERCEL_OIDC_TOKEN with BLOB_STORE_ID, or BLOB_READ_WRITE_TOKEN",
		);
	}

	let credentialOptions;
	let secrets;
	if (hasOidcToken || hasStoreId) {
		if (
			typeof oidcToken !== "string" ||
			oidcToken === "" ||
			typeof storeId !== "string" ||
			storeId === ""
		) {
			throw new Error(
				"OIDC credential mode requires both non-empty VERCEL_OIDC_TOKEN and BLOB_STORE_ID",
			);
		}
		if (oidcToken !== oidcToken.trim()) {
			throw new Error(
				"Blob credential values must not contain surrounding whitespace",
			);
		}
		if (storeId !== AUTHORIZED_OIDC_STORE_ID) {
			throw new Error(
				"BLOB_STORE_ID must exactly match the authorized Dawn media store",
			);
		}
		credentialOptions = Object.freeze({ oidcToken, storeId });
		secrets = Object.freeze([oidcToken]);
	} else {
		if (typeof legacyToken !== "string" || legacyToken === "") {
			throw new Error("BLOB_READ_WRITE_TOKEN must be non-empty with --apply");
		}
		if (legacyToken !== legacyToken.trim()) {
			throw new Error(
				"Blob credential values must not contain surrounding whitespace",
			);
		}
		if (!/^vercel_blob_rw_[A-Za-z0-9]+_[A-Za-z0-9]+$/u.test(legacyToken)) {
			throw new Error(
				"BLOB_READ_WRITE_TOKEN must use canonical Vercel Blob read-write token format",
			);
		}
		const [, , , legacyStoreId = ""] = legacyToken.split("_");
		if (legacyStoreId !== AUTHORIZED_LEGACY_STORE_ID) {
			throw new Error(
				"BLOB_READ_WRITE_TOKEN must encode the authorized Dawn media store",
			);
		}
		credentialOptions = Object.freeze({ token: legacyToken });
		secrets = Object.freeze([legacyToken]);
	}
	const rawBaseUrl = env.DAWN_MEDIA_PUBLIC_BASE_URL;
	if (typeof rawBaseUrl !== "string" || rawBaseUrl === "") {
		throw new Error("DAWN_MEDIA_PUBLIC_BASE_URL is required with --apply");
	}
	const baseUrl = validatePublicBaseUrl(rawBaseUrl);
	if (baseUrl !== AUTHORIZED_OIDC_ORIGIN) {
		throw new Error(
			"DAWN media public base URL must exactly match the authorized Dawn media store origin",
		);
	}
	return { credentialOptions, secrets, baseUrl };
}

async function defaultLoadValidatedMedia({ repoRoot }) {
	return checkLocalMedia({ repoRoot, log() {} });
}

export async function uploadReadmeMedia({
	args = [],
	env = process.env,
	repoRoot = DEFAULT_REPO_ROOT,
	loadValidatedMedia = defaultLoadValidatedMedia,
	readFile = nodeReadFile,
	put = vercelBlobPut,
	fetch = globalThis.fetch,
	writeCatalog = (catalog) => writeDemoMediaCatalog(catalog, { repoRoot }),
	log = console.log,
	timeoutMs = 15_000,
	signal,
} = {}) {
	const { apply } = parseUploadArguments(args);
	const applyEnvironment = apply ? requireApplyEnvironment(env) : undefined;
	const { pointer, manifest, sourceFiles } = await loadValidatedMedia({
		repoRoot,
		signal,
	});
	const plan = createUploadPlan({
		repoRoot,
		pointer,
		manifest,
		...(applyEnvironment === undefined
			? {}
			: { baseUrl: applyEnvironment.baseUrl }),
	});

	if (!apply) {
		log("DRY RUN: no uploads and no catalog writes will occur");
		for (const entry of plan) {
			log(`${entry.sourcePath} -> ${entry.url}`);
		}
		return { applied: false, plan };
	}

	const preflightedPlan = await preflightUploadPlan({
		plan,
		sourceFiles,
		readFile,
		signal,
	});
	const uploadedPlan = [];
	for (const [index, entry] of preflightedPlan.entries()) {
		let result;
		try {
			result = await runBoundedRemoteOperation({
				label: `put ${entry.pathname}`,
				timeoutMs,
				signal,
				operation: (operationSignal) =>
					put(entry.pathname, entry.body, {
						access: "public",
						addRandomSuffix: false,
						allowOverwrite: true,
						contentType: entry.contentType,
						...applyEnvironment.credentialOptions,
						abortSignal: operationSignal,
					}),
			});
		} catch (error) {
			throw uploadConvergenceError({
				error,
				secrets: applyEnvironment.secrets,
				index,
				plan: preflightedPlan,
			});
		}
		if (result?.url !== entry.url) {
			throw uploadConvergenceError({
				error: new Error(
					`${entry.pathname} returned URL does not match its stable public URL`,
				),
				secrets: applyEnvironment.secrets,
				index,
				plan: preflightedPlan,
			});
		}
		uploadedPlan.push(entry);
		log(`UPLOADED ${entry.pathname} -> ${entry.url}`);
	}

	const catalog = buildDemoMediaCatalog({ manifest, plan: uploadedPlan });
	try {
		await verifyRemoteMediaCatalog({
			catalog,
			fetch,
			log,
			timeoutMs,
			signal,
		});
	} catch (error) {
		throw verificationConvergenceError({
			error,
			secrets: applyEnvironment.secrets,
			plan: uploadedPlan,
		});
	}
	await writeCatalog(catalog);
	log(`WROTE ${join(repoRoot, CATALOG_PATH)}`);
	return { applied: true, plan: preflightedPlan, catalog };
}

function isMainModule() {
	return (
		process.argv[1] !== undefined &&
		pathToFileURL(resolve(process.argv[1])).href === import.meta.url
	);
}

if (isMainModule()) {
	try {
		await uploadReadmeMedia({ args: process.argv.slice(2) });
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
