import { execFile, spawn } from "node:child_process";

const API_ORIGIN = "https://api.github.com";
const REPOSITORY_PATH = "/repos/cacheplane/dawnai/";
const REPOSITORY_ID_PATH = "/repositories/1210070282/";
const API_VERSION = "2022-11-28";
const JSON_ACCEPT = "application/vnd.github+json";
const MAX_PROCESS_BYTES = 64 * 1024 * 1024;
const MAX_PROCESS_TIMEOUT_MS = 300_000;
const PROCESS_TERM_GRACE_MS = 100;
const PROCESS_KILL_GRACE_MS = 250;
const PROCESS_TASKKILL_TIMEOUT_MS = 500;
const PROCESS_TASKKILL_BYTES = 64 * 1024;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SECRET_KEY =
	/(?:authorization|cookie|password|secret|token|private.?key)/iu;

export class EvidenceError extends Error {
	constructor(code) {
		super(`UNPROVABLE: ${code}`);
		this.name = "EvidenceError";
		this.code = code;
	}
}

function fail(code) {
	throw new EvidenceError(code);
}

export function safeEvidenceError(error) {
	return error instanceof EvidenceError
		? error.message
		: "UNPROVABLE: EVIDENCE_OPERATION_FAILED";
}

export function canonicalJsonBytes(value) {
	const state = { ancestors: new Set(), nodes: 0 };
	const normalized = canonicalize(value, state, 0);
	const bytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
	if (bytes.byteLength > MAX_PROCESS_BYTES) fail("CANONICAL_JSON_LIMIT");
	return bytes;
}

function canonicalize(value, state, depth) {
	state.nodes += 1;
	if (state.nodes > 100_000 || depth > 64) fail("INVALID_JSON_VALUE");
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail("INVALID_JSON_VALUE");
		return value;
	}
	if (typeof value !== "object") fail("INVALID_JSON_VALUE");
	if (state.ancestors.has(value)) fail("INVALID_JSON_VALUE");

	const descriptors = Object.getOwnPropertyDescriptors(value);
	const symbolDescriptors = Object.getOwnPropertySymbols(value);
	if (symbolDescriptors.length > 0) fail("INVALID_JSON_VALUE");
	state.ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (
				Object.getPrototypeOf(value) !== Array.prototype ||
				Object.keys(descriptors).some(
					(key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key),
				)
			) {
				fail("INVALID_JSON_VALUE");
			}
			const result = [];
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = descriptors[String(index)];
				if (
					descriptor === undefined ||
					!("value" in descriptor) ||
					descriptor.enumerable !== true
				) {
					fail("INVALID_JSON_VALUE");
				}
				result.push(canonicalize(descriptor.value, state, depth + 1));
			}
			return result;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null)
			fail("INVALID_JSON_VALUE");
		const result = Object.create(null);
		for (const key of Object.keys(descriptors).sort(compareText)) {
			const descriptor = descriptors[key];
			if (
				descriptor === undefined ||
				!("value" in descriptor) ||
				descriptor.enumerable !== true ||
				UNSAFE_KEYS.has(key) ||
				SECRET_KEY.test(key)
			) {
				fail("INVALID_JSON_VALUE");
			}
			Object.defineProperty(result, key, {
				configurable: false,
				enumerable: true,
				value: canonicalize(descriptor.value, state, depth + 1),
				writable: false,
			});
		}
		return result;
	} finally {
		state.ancestors.delete(value);
	}
}

export function parseGhIncludedResponse(raw, responseType = "json") {
	if (
		typeof raw !== "string" ||
		Buffer.byteLength(raw, "utf8") > MAX_PROCESS_BYTES
	) {
		fail("MALFORMED_GITHUB_RESPONSE");
	}
	const separator = /\r?\n\r?\n/u.exec(raw);
	if (separator === null || separator.index === 0)
		fail("MALFORMED_GITHUB_RESPONSE");
	const headerText = raw.slice(0, separator.index);
	const bodyText = raw.slice(separator.index + separator[0].length);
	const lines = headerText.split(/\r?\n/u);
	const statusMatch =
		/^HTTP\/(?:1\.1|2(?:\.0)?) ([1-5][0-9]{2})(?: .*)?$/u.exec(lines[0] ?? "");
	if (statusMatch === null) fail("MALFORMED_GITHUB_RESPONSE");
	const status = Number(statusMatch[1]);
	if (status !== 200) fail(`GITHUB_HTTP_${status}`);
	const headers = new Map();
	for (const line of lines.slice(1)) {
		const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/u.exec(line);
		if (match === null) fail("MALFORMED_GITHUB_RESPONSE");
		const name = match[1].toLowerCase();
		if (headers.has(name)) fail("DUPLICATE_GITHUB_HEADER");
		headers.set(name, match[2]);
	}
	let body;
	if (responseType === "json") {
		try {
			body = JSON.parse(bodyText);
		} catch {
			fail("MALFORMED_GITHUB_JSON");
		}
		body = JSON.parse(canonicalJsonBytes(body).toString("utf8"));
	} else if (responseType === "text") {
		body = bodyText;
	} else {
		fail("INVALID_RESPONSE_TYPE");
	}
	return {
		body,
		bodyBytes: Buffer.byteLength(raw, "utf8"),
		link: headers.get("link") ?? null,
		status,
	};
}

export function parseNextLink(link, { cursorOnly = false, initialUrl, seen }) {
	if (link === null || link === undefined) return null;
	if (typeof link !== "string" || link.trim().length === 0)
		fail("MALFORMED_LINK");
	if (typeof initialUrl !== "string" || !(seen instanceof Set))
		fail("INVALID_PAGINATION_STATE");
	const next = [];
	for (const rawPart of link.split(",")) {
		const part = rawPart.trim();
		const match = /^<([^<>\s]+)>((?:\s*;\s*[^;]+)+)$/u.exec(part);
		if (match === null) fail("MALFORMED_LINK");
		const parameters = new Map();
		let rest = match[2];
		while (rest.length > 0) {
			const parameter =
				/^\s*;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"([^"\\]*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))/u.exec(
					rest,
				);
			if (parameter === null) fail("MALFORMED_LINK");
			const key = parameter[1].toLowerCase();
			if (parameters.has(key)) fail("MALFORMED_LINK");
			parameters.set(key, parameter[2] ?? parameter[3]);
			rest = rest.slice(parameter[0].length);
		}
		const relation = parameters.get("rel");
		if (relation === undefined) fail("MALFORMED_LINK");
		const relations = relation.split(/\s+/u);
		if (
			relations.length === 0 ||
			new Set(relations).size !== relations.length ||
			relations.some((value) => !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(value)) ||
			relations.some((value) => value !== value.toLowerCase()) ||
			(relations.includes("next") && relations.includes("prev"))
		) {
			fail("MALFORMED_LINK");
		}
		if (relations.includes("next")) next.push(match[1]);
	}
	if (next.length > 1) fail("DUPLICATE_NEXT_LINK");
	if (next.length === 0) return null;

	let initial;
	let candidate;
	try {
		initial = new URL(initialUrl);
		candidate = new URL(next[0]);
	} catch {
		fail("UNSAFE_PAGINATION_URL");
	}
	if (
		initial.origin !== API_ORIGIN ||
		candidate.origin !== API_ORIGIN ||
		candidate.username !== "" ||
		candidate.password !== "" ||
		candidate.hash !== "" ||
		paginationPathIdentity(candidate.pathname) !==
			paginationPathIdentity(initial.pathname)
	) {
		fail("UNSAFE_PAGINATION_URL");
	}
	const initialQuery = uniqueQuery(initial.searchParams);
	if (["page", "before", "after"].some((key) => initialQuery.has(key))) {
		fail("UNSAFE_PAGINATION_URL");
	}
	const candidateQuery = uniqueQuery(candidate.searchParams);
	const fixed = new Map(
		[...initialQuery].filter(
			([key]) => !["page", "before", "after"].includes(key),
		),
	);
	for (const [key, value] of fixed) {
		if (candidateQuery.get(key) !== value) fail("UNSAFE_PAGINATION_URL");
	}
	for (const key of candidateQuery.keys()) {
		if (!fixed.has(key) && !["page", "before", "after"].includes(key)) {
			fail("UNSAFE_PAGINATION_URL");
		}
	}
	const before = candidateQuery.get("before");
	const after = candidateQuery.get("after");
	const page = candidateQuery.get("page");
	if (cursorOnly) {
		if (before !== undefined || after === undefined || page !== undefined) {
			fail("UNSAFE_PAGINATION_URL");
		}
		if (!/^[A-Za-z0-9._~+/=-]{1,512}$/u.test(after)) {
			fail("UNSAFE_PAGINATION_URL");
		}
	} else if (
		before !== undefined ||
		after !== undefined ||
		page === undefined ||
		!/^[1-9][0-9]*$/u.test(page)
	) {
		fail("UNSAFE_PAGINATION_URL");
	}
	const href = candidate.href;
	const visitedUrls = [];
	for (const visited of seen) {
		let visitedUrl;
		try {
			visitedUrl = new URL(visited);
		} catch {
			fail("INVALID_PAGINATION_STATE");
		}
		if (
			visitedUrl.origin !== API_ORIGIN ||
			paginationPathIdentity(visitedUrl.pathname) !==
				paginationPathIdentity(initial.pathname)
		) {
			fail("INVALID_PAGINATION_STATE");
		}
		visitedUrls.push(visitedUrl);
	}
	const candidateState = paginationStateKey(candidate);
	if (
		visitedUrls.some(
			(visited) => paginationStateKey(visited) === candidateState,
		)
	) {
		fail("PAGINATION_CYCLE");
	}
	if (!cursorOnly) {
		const current = visitedUrls.at(-1);
		if (current === undefined) fail("INVALID_PAGINATION_STATE");
		const currentPage = current.searchParams.get("page");
		const expectedPage = currentPage === null ? 2 : Number(currentPage) + 1;
		if (Number(page) !== expectedPage) fail("NON_MONOTONE_PAGE");
	}
	return href;
}

function paginationStateKey(url) {
	const query = [...url.searchParams]
		.map(([key, value]) => [key, value])
		.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
			leftKey === rightKey
				? compareText(leftValue, rightValue)
				: compareText(leftKey, rightKey),
		);
	return `${url.origin}${paginationPathIdentity(url.pathname)}?${JSON.stringify(query)}`;
}

function paginationPathIdentity(pathname) {
	if (pathname.startsWith(REPOSITORY_PATH)) return pathname;
	if (pathname.startsWith(REPOSITORY_ID_PATH)) {
		return `${REPOSITORY_PATH}${pathname.slice(REPOSITORY_ID_PATH.length)}`;
	}
	return pathname;
}

function uniqueQuery(searchParams) {
	const result = new Map();
	for (const [key, value] of searchParams) {
		if (result.has(key)) fail("UNSAFE_PAGINATION_URL");
		result.set(key, value);
	}
	return result;
}

export function createEvidenceBudget({
	maxBytes = 64 * 1024 * 1024,
	maxPages = 100,
	maxRecords = 10_000,
	maxRequests = 500,
	now = Date.now,
	timeoutMs = 120_000,
} = {}) {
	for (const [value, maximum, label] of [
		[maxBytes, 512 * 1024 * 1024, "maxBytes"],
		[maxPages, 1000, "maxPages"],
		[maxRecords, 1_000_000, "maxRecords"],
		[maxRequests, 10_000, "maxRequests"],
		[timeoutMs, 30 * 60_000, "timeoutMs"],
	]) {
		if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
			fail(`INVALID_${label}`);
	}
	if (typeof now !== "function") fail("INVALID_CLOCK");
	const sampleClock = createClockSampler(now);
	const started = sampleClock();
	if (started > MAX_DATE_MILLISECONDS - timeoutMs) fail("INVALID_CLOCK");
	return {
		deadline: started + timeoutMs,
		maxPages,
		maxRecords,
		now: sampleClock,
		remainingBytes: maxBytes,
		remainingPages: maxPages,
		remainingRecords: maxRecords,
		remainingRequests: maxRequests,
	};
}

function reserveRequest(budget) {
	const current = budget.now();
	if (budget.deadline <= current) fail("EVIDENCE_TIMEOUT");
	if (budget.remainingRequests < 1) fail("REQUEST_LIMIT");
	if (budget.remainingBytes < 1) fail("BYTE_LIMIT");
	budget.remainingRequests -= 1;
	return {
		maxBytes: Math.min(budget.remainingBytes, MAX_PROCESS_BYTES),
		timeoutMs: Math.max(
			1,
			Math.min(budget.deadline - current, MAX_PROCESS_TIMEOUT_MS),
		),
	};
}

function createClockSampler(now) {
	let last;
	return () => {
		let value;
		try {
			value = now();
		} catch {
			fail("INVALID_CLOCK");
		}
		if (
			!Number.isSafeInteger(value) ||
			value < 0 ||
			value > MAX_DATE_MILLISECONDS ||
			(last !== undefined && value < last)
		) {
			fail("INVALID_CLOCK");
		}
		last = value;
		return value;
	};
}

export function reserveEvidenceRequest(budget) {
	return reserveRequest(budget);
}

function consumeResponse(budget, response) {
	if (budget.deadline <= budget.now()) fail("EVIDENCE_TIMEOUT");
	if (
		response === null ||
		typeof response !== "object" ||
		response.status !== 200 ||
		!Number.isSafeInteger(response.bodyBytes) ||
		response.bodyBytes < 0 ||
		!(response.link === null || typeof response.link === "string")
	) {
		fail("MALFORMED_GITHUB_RESPONSE");
	}
	if (response.bodyBytes > budget.remainingBytes) fail("BYTE_LIMIT");
	budget.remainingBytes -= response.bodyBytes;
}

export function consumeEvidenceBytes(budget, bytes) {
	if (budget.deadline <= budget.now()) fail("EVIDENCE_TIMEOUT");
	if (!Number.isSafeInteger(bytes) || bytes < 0)
		fail("MALFORMED_EVIDENCE_RESPONSE");
	if (bytes > budget.remainingBytes) fail("BYTE_LIMIT");
	budget.remainingBytes -= bytes;
}

function assertWithinDeadline(budget) {
	if (budget.deadline <= budget.now()) fail("EVIDENCE_TIMEOUT");
}

export function assertEvidenceDeadline(budget) {
	assertWithinDeadline(budget);
}

export function createGitHubReader({ budget, repo, transport }) {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(
			repo,
		)
	) {
		fail("INVALID_REPOSITORY");
	}
	if (typeof transport !== "function") fail("INVALID_GITHUB_TRANSPORT");
	if (budget === null || typeof budget !== "object") fail("INVALID_BUDGET");
	const repositoryBase = `${API_ORIGIN}/repos/${repo}/`;

	async function request(url, responseType) {
		const limits = reserveRequest(budget);
		let response;
		try {
			response = await transport({ ...limits, responseType, url });
		} catch (error) {
			if (error instanceof EvidenceError) throw error;
			fail("GITHUB_TRANSPORT_FAILED");
		}
		consumeResponse(budget, response);
		return response;
	}

	function initialUrl(path) {
		if (
			typeof path !== "string" ||
			path.length === 0 ||
			path.startsWith("/") ||
			path.includes("#")
		) {
			fail("INVALID_GITHUB_PATH");
		}
		let url;
		try {
			url = new URL(path, repositoryBase);
		} catch {
			fail("INVALID_GITHUB_PATH");
		}
		if (url.href.slice(0, repositoryBase.length) !== repositoryBase)
			fail("INVALID_GITHUB_PATH");
		uniqueQuery(url.searchParams);
		return url.href;
	}

	return {
		async object(path) {
			const response = await request(initialUrl(path), "json");
			if (response.link !== null) fail("UNEXPECTED_OBJECT_PAGINATION");
			const body = JSON.parse(
				canonicalJsonBytes(response.body).toString("utf8"),
			);
			assertWithinDeadline(budget);
			if (!isRecord(body)) fail("MALFORMED_GITHUB_SCHEMA");
			return body;
		},
		async text(path) {
			const response = await request(initialUrl(path), "text");
			if (response.link !== null || typeof response.body !== "string") {
				fail("MALFORMED_GITHUB_SCHEMA");
			}
			assertWithinDeadline(budget);
			return response.body;
		},
		async list(
			path,
			{
				cursorOnly = false,
				field,
				pageLimit = 10,
				totalCount = false,
				uniqueKey = "id",
			} = {},
		) {
			if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 10) {
				fail("INVALID_PAGE_LIMIT");
			}
			const firstUrl = initialUrl(path);
			const initialSearch = new URL(firstUrl).searchParams;
			if (["page", "before", "after"].some((key) => initialSearch.has(key))) {
				fail("UNSAFE_PAGINATION_URL");
			}
			const seen = new Set([firstUrl]);
			const records = [];
			const identities = new Set();
			let expectedTotal = null;
			let pagesRead = 0;
			let url = firstUrl;
			for (;;) {
				if (pagesRead >= pageLimit || budget.remainingPages < 1)
					fail("PAGE_LIMIT");
				pagesRead += 1;
				budget.remainingPages -= 1;
				const response = await request(url, "json");
				const body = JSON.parse(
					canonicalJsonBytes(response.body).toString("utf8"),
				);
				assertWithinDeadline(budget);
				let pageRecords;
				let pageTotal = null;
				if (field === undefined) {
					if (!Array.isArray(body)) fail("MALFORMED_GITHUB_SCHEMA");
					pageRecords = body;
				} else {
					if (!isRecord(body) || !Array.isArray(body[field]))
						fail("MALFORMED_GITHUB_SCHEMA");
					pageRecords = body[field];
					if (totalCount) {
						if (
							!Number.isSafeInteger(body.total_count) ||
							body.total_count < 0
						) {
							fail("MALFORMED_GITHUB_SCHEMA");
						}
						pageTotal = body.total_count;
						if (expectedTotal === null) expectedTotal = pageTotal;
						else if (expectedTotal !== pageTotal) fail("TOTAL_COUNT_DRIFT");
					}
				}
				if (pageRecords.length > budget.remainingRecords) fail("RECORD_LIMIT");
				budget.remainingRecords -= pageRecords.length;
				for (const rawRecord of pageRecords) {
					const record = JSON.parse(
						canonicalJsonBytes(rawRecord).toString("utf8"),
					);
					assertWithinDeadline(budget);
					if (!isRecord(record)) fail("MALFORMED_GITHUB_SCHEMA");
					const identity = record[uniqueKey];
					if (
						!(
							(typeof identity === "string" && identity.length > 0) ||
							Number.isSafeInteger(identity)
						)
					) {
						fail("MISSING_RECORD_IDENTITY");
					}
					const identityKey = `${typeof identity}:${String(identity)}`;
					if (identities.has(identityKey)) fail("DUPLICATE_RECORD");
					identities.add(identityKey);
					records.push(record);
				}
				const next = parseNextLink(response.link, {
					cursorOnly,
					initialUrl: firstUrl,
					seen,
				});
				if (next === null) {
					if (totalCount && expectedTotal !== records.length)
						fail("TOTAL_COUNT_MISMATCH");
					assertWithinDeadline(budget);
					return records.sort((left, right) =>
						compareText(
							JSON.stringify(left[uniqueKey]),
							JSON.stringify(right[uniqueKey]),
						),
					);
				}
				if (pagesRead >= pageLimit || budget.remainingPages < 1)
					fail("PAGE_LIMIT");
				seen.add(next);
				url = next;
			}
		},
	};
}

export function createGhApiTransport({ runProcess = runBoundedProcess } = {}) {
	if (typeof runProcess !== "function") fail("INVALID_PROCESS_RUNNER");
	return async ({ maxBytes, responseType, timeoutMs, url }) => {
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			fail("INVALID_GITHUB_URL");
		}
		if (
			parsed.origin !== API_ORIGIN ||
			parsed.username !== "" ||
			parsed.password !== "" ||
			parsed.hash !== ""
		) {
			fail("INVALID_GITHUB_URL");
		}
		for (const [key] of parsed.searchParams) {
			if (
				/(?:authorization|cookie|password|secret|token|private.?key)/iu.test(
					key,
				)
			) {
				fail("INVALID_GITHUB_URL");
			}
		}
		const endpoint = `${parsed.pathname.slice(1)}${parsed.search}`;
		const result = await runProcess({
			args: [
				"api",
				"--hostname",
				"github.com",
				"--method",
				"GET",
				"--include",
				"-H",
				`Accept: ${JSON_ACCEPT}`,
				"-H",
				`X-GitHub-Api-Version: ${API_VERSION}`,
				endpoint,
			],
			command: "gh",
			maxBytes,
			timeoutMs,
		});
		if (result.exitCode !== 0) fail("GITHUB_TRANSPORT_FAILED");
		return parseGhIncludedResponse(result.stdout, responseType);
	};
}

export function runBoundedProcess({
	args,
	command,
	cwd,
	env,
	maxBytes,
	platform = process.platform,
	runTaskkill = runWindowsTaskkill,
	timeoutMs,
}) {
	if (
		typeof command !== "string" ||
		command.length === 0 ||
		!Array.isArray(args) ||
		!args.every(
			(value) => typeof value === "string" && !/[\0\r\n]/u.test(value),
		) ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > MAX_PROCESS_BYTES ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > MAX_PROCESS_TIMEOUT_MS ||
		![
			"aix",
			"darwin",
			"freebsd",
			"linux",
			"openbsd",
			"sunos",
			"win32",
		].includes(platform) ||
		typeof runTaskkill !== "function"
	) {
		return Promise.reject(new EvidenceError("INVALID_PROCESS_REQUEST"));
	}
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(command, args, {
				...(cwd === undefined ? {} : { cwd }),
				detached: platform !== "win32",
				...(env === undefined ? {} : { env }),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			reject(new EvidenceError("PROCESS_START_FAILED"));
			return;
		}
		const stdout = [];
		const stderr = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let failure = null;
		let killTimer = null;
		let finalTimer = null;
		let settled = false;
		const clearTimers = () => {
			clearTimeout(timeout);
			if (killTimer !== null) clearTimeout(killTimer);
			if (finalTimer !== null) clearTimeout(finalTimer);
		};
		const finishFailure = () => {
			if (settled || failure === null) return;
			settled = true;
			clearTimers();
			child.stdout.destroy();
			child.stderr.destroy();
			reject(failure);
		};
		const terminate = (code) => {
			if (failure === null) failure = new EvidenceError(code);
			if (killTimer !== null || finalTimer !== null) return;
			if (platform === "win32") {
				const pid = child.pid;
				if (!Number.isSafeInteger(pid) || pid < 1) {
					finalTimer = setTimeout(finishFailure, PROCESS_KILL_GRACE_MS);
					return;
				}
				const finishTaskkill = () => {
					signalDirectProcess(child, "SIGKILL");
					finalTimer ??= setTimeout(finishFailure, PROCESS_KILL_GRACE_MS);
				};
				killTimer = setTimeout(
					finishTaskkill,
					PROCESS_TASKKILL_TIMEOUT_MS + PROCESS_KILL_GRACE_MS,
				);
				void Promise.resolve()
					.then(() =>
						runTaskkill({
							args: ["/PID", String(pid), "/T", "/F"],
							command: "taskkill.exe",
							maxBytes: PROCESS_TASKKILL_BYTES,
							timeoutMs: PROCESS_TASKKILL_TIMEOUT_MS,
						}),
					)
					.then(finishTaskkill, finishTaskkill);
				return;
			}
			signalProcessTree(child, "SIGTERM", platform);
			killTimer = setTimeout(() => {
				signalProcessTree(child, "SIGKILL", platform);
				finalTimer = setTimeout(finishFailure, PROCESS_KILL_GRACE_MS);
			}, PROCESS_TERM_GRACE_MS);
		};
		child.stdout.on("data", (chunk) => {
			if (failure !== null) return;
			stdoutBytes += chunk.length;
			if (stdoutBytes > maxBytes) terminate("PROCESS_OUTPUT_LIMIT");
			else stdout.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			if (failure !== null) return;
			stderrBytes += chunk.length;
			if (stderrBytes > maxBytes) terminate("PROCESS_OUTPUT_LIMIT");
			else stderr.push(chunk);
		});
		child.on("error", () => terminate("PROCESS_START_FAILED"));
		const timeout = setTimeout(() => terminate("PROCESS_TIMEOUT"), timeoutMs);
		child.on("close", (code, signal) => {
			if (settled) return;
			if (failure !== null) {
				// The process-group leader can close while descendants remain alive.
				// Keep the force-kill and final watchdog armed until tree supervision ends.
				return;
			}
			settled = true;
			clearTimers();
			if (!Number.isInteger(code) || signal !== null) {
				reject(new EvidenceError("PROCESS_TERMINATED"));
				return;
			}
			resolve({
				exitCode: code,
				stderr: Buffer.concat(stderr).toString("utf8"),
				stdout: Buffer.concat(stdout).toString("utf8"),
			});
		});
	});
}

function signalProcessTree(child, signal, platform) {
	if (platform !== "win32" && Number.isSafeInteger(child.pid)) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch (error) {
			if (readErrorCode(error) === "ESRCH") return;
		}
	}
	signalDirectProcess(child, signal);
}

function signalDirectProcess(child, signal) {
	try {
		child.kill(signal);
	} catch (error) {
		if (readErrorCode(error) !== "ESRCH") return;
	}
}

function runWindowsTaskkill({ args, command, maxBytes, timeoutMs }) {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ maxBuffer: maxBytes, timeout: timeoutMs, windowsHide: true },
			(error) => (error === null ? resolve() : reject(error)),
		);
	});
}

function readErrorCode(error) {
	if (error === null || typeof error !== "object") return undefined;
	const code = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left, right) {
	return left === right ? 0 : left < right ? -1 : 1;
}
