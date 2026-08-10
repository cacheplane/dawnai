import { readBoundedFixture } from "../release/fixture-io.mjs";
import {
	AUDIT_SEVERITIES,
	assertUniqueAuditRecords,
	compareAuditRecords,
	countAuditSeverity,
	normalizeAuditRecord,
	validateAuditExpectation,
	validateAuditExpectationMode,
} from "./audit-evidence-schema.mjs";
import {
	canonicalJsonBytes,
	EvidenceError,
	runBoundedProcess,
} from "./github-evidence.mjs";

const UTC_SECONDS_PATTERN =
	/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const MAX_AUDIT_BYTES = 64 * 1024 * 1024;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

function fail(code) {
	throw new EvidenceError(code);
}

export function formatUtcSeconds(milliseconds) {
	if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
		fail("INVALID_CLOCK");
	let timestamp;
	try {
		timestamp = new Date(milliseconds)
			.toISOString()
			.replace(/\.[0-9]{3}Z$/u, "Z");
	} catch {
		fail("INVALID_CLOCK");
	}
	if (!UTC_SECONDS_PATTERN.test(timestamp)) fail("INVALID_CLOCK");
	return timestamp;
}

export async function loadAuditExpectation(
	file,
	{ root = process.cwd() } = {},
) {
	let source;
	try {
		source = await readBoundedFixture(file, { maxBytes: 1024 * 1024, root });
	} catch {
		fail("INVALID_EXPECTATION_FILE");
	}
	if (source.includes("\uFFFD")) fail("INVALID_EXPECTATION_ENCODING");
	let parsed;
	try {
		parsed = JSON.parse(source);
	} catch {
		fail("MALFORMED_EXPECTATION_JSON");
	}
	return validateAuditExpectation(parsed);
}

export { validateAuditExpectation };

export function normalizeAuditDocument(value, expectedMode, exitCode) {
	const document = safeClone(value, "MALFORMED_AUDIT_SCHEMA");
	const expected = validateAuditExpectationMode(expectedMode);
	if (!isRecord(document) || Object.hasOwn(document, "error"))
		fail("MALFORMED_AUDIT_SCHEMA");
	if (!Array.isArray(document.muted) || document.muted.length !== 0) {
		fail("AUDIT_MUTED_RECORDS");
	}
	if (!isRecord(document.advisories)) fail("MALFORMED_AUDIT_SCHEMA");
	const records = [];
	const advisoryIds = new Set();
	for (const [advisoryId, advisory] of Object.entries(document.advisories)) {
		if (
			!/^(?:0|[1-9][0-9]*)$/u.test(advisoryId) ||
			advisoryIds.has(advisoryId)
		) {
			fail("INVALID_AUDIT_IDENTITY");
		}
		advisoryIds.add(advisoryId);
		if (
			!isRecord(advisory) ||
			typeof advisory.module_name !== "string" ||
			typeof advisory.github_advisory_id !== "string" ||
			typeof advisory.severity !== "string" ||
			!Array.isArray(advisory.findings) ||
			advisory.findings.length !== 1
		) {
			fail("INVALID_AUDIT_IDENTITY");
		}
		const finding = advisory.findings[0];
		if (
			!isRecord(finding) ||
			typeof finding.version !== "string" ||
			!Array.isArray(finding.paths) ||
			finding.paths.length === 0 ||
			!finding.paths.every(
				(path) =>
					typeof path === "string" &&
					path.length > 0 &&
					Buffer.byteLength(path, "utf8") <= 16_384,
			)
		) {
			fail("INVALID_AUDIT_IDENTITY");
		}
		records.push(
			normalizeAuditRecord(
				{
					ghsa: advisory.github_advisory_id,
					package: advisory.module_name,
					severity: advisory.severity,
					version: finding.version,
				},
				"INVALID_AUDIT_EXPECTATION",
			),
		);
	}
	records.sort(compareAuditRecords);
	assertUniqueAuditRecords(records, "DUPLICATE_AUDIT_IDENTITY");
	const totals = normalizeSeverityTotals(document.metadata?.vulnerabilities);
	const observedTotals = countAuditSeverity(records);
	if (JSON.stringify(totals) !== JSON.stringify(observedTotals))
		fail("AUDIT_TOTAL_MISMATCH");
	if (JSON.stringify(records) !== JSON.stringify(expected.records))
		fail("AUDIT_IDENTITY_MISMATCH");
	const findings = records.length > 0;
	if ((findings && exitCode !== 1) || (!findings && exitCode !== 0)) {
		fail("AUDIT_EXIT_MISMATCH");
	}
	return {
		exitCode,
		muted: [],
		records,
		severityTotals: totals,
		status: findings ? "findings" : "clean",
	};
}

function normalizeSeverityTotals(value) {
	if (!isRecord(value)) fail("MALFORMED_AUDIT_SCHEMA");
	assertExactKeys(value, AUDIT_SEVERITIES, "MALFORMED_AUDIT_SCHEMA");
	const result = {};
	for (const severity of AUDIT_SEVERITIES) {
		if (!Number.isSafeInteger(value[severity]) || value[severity] < 0) {
			fail("MALFORMED_AUDIT_SCHEMA");
		}
		result[severity] = value[severity];
	}
	return result;
}

export async function collectAuditEvidence({
	cwd = process.cwd(),
	expectation,
	maxBytes = 8 * 1024 * 1024,
	now = Date.now,
	runProcess = runBoundedProcess,
	timeoutMs = 120_000,
}) {
	const expected = validateAuditExpectation(expectation);
	if (typeof now !== "function" || typeof runProcess !== "function")
		fail("INVALID_AUDIT_RUNNER");
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 300_000
	) {
		fail("INVALID_AUDIT_TIMEOUT");
	}
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > MAX_AUDIT_BYTES
	) {
		fail("INVALID_AUDIT_BYTES");
	}
	const clock = createAuditClock(now, timeoutMs);
	const env = sanitizedAuditEnvironment(process.env);
	const results = {};
	for (const [mode, args] of [
		["full", ["audit", "--json"]],
		["production", ["audit", "--json", "--prod"]],
	]) {
		const remaining = clock.remaining();
		let processResult;
		try {
			processResult = await runProcess({
				args,
				command: "pnpm",
				cwd,
				env,
				maxBytes,
				timeoutMs: remaining,
			});
		} catch (error) {
			if (error instanceof EvidenceError) throw error;
			fail("AUDIT_PROCESS_FAILED");
		}
		clock.assertBeforeDeadline();
		if (
			!isRecord(processResult) ||
			!Number.isInteger(processResult.exitCode) ||
			typeof processResult.stdout !== "string" ||
			typeof processResult.stderr !== "string"
		) {
			fail("AUDIT_PROCESS_FAILED");
		}
		let document;
		try {
			document = JSON.parse(processResult.stdout);
		} catch {
			fail("MALFORMED_AUDIT_JSON");
		}
		results[mode] = normalizeAuditDocument(
			document,
			expected[mode],
			processResult.exitCode,
		);
	}
	return {
		full: results.full,
		kind: "pnpm-audit",
		production: results.production,
		schemaVersion: 1,
	};
}

function sanitizedAuditEnvironment(environment) {
	const safe = {};
	for (const [key, value] of Object.entries(environment)) {
		if (
			typeof value === "string" &&
			!/(?:^|_)(?:AUTH|KEY|PASSWORD|SECRET|TOKEN)(?:_|$)/iu.test(key) &&
			!["GH_TOKEN", "GITHUB_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"].includes(
				key,
			)
		) {
			safe[key] = value;
		}
	}
	return safe;
}

function createAuditClock(now, timeoutMs) {
	let last;
	const sample = () => {
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
	const started = sample();
	if (started > MAX_DATE_MILLISECONDS - timeoutMs) fail("INVALID_CLOCK");
	const deadline = started + timeoutMs;
	const assertBeforeDeadline = () => {
		const current = sample();
		if (current >= deadline) fail("AUDIT_TIMEOUT");
		return current;
	};
	return {
		assertBeforeDeadline,
		remaining() {
			return deadline - assertBeforeDeadline();
		},
	};
}

function safeClone(value, code) {
	try {
		return JSON.parse(canonicalJsonBytes(value).toString("utf8"));
	} catch {
		fail(code);
	}
}

function assertExactKeys(value, expected, code) {
	if (!isRecord(value)) fail(code);
	const actual = Object.keys(value).sort(compareText);
	const wanted = [...expected].sort(compareText);
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(code);
}

function compareText(left, right) {
	return left === right ? 0 : left < right ? -1 : 1;
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
