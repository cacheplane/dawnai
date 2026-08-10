import { canonicalJsonBytes, EvidenceError } from "./github-evidence.mjs";

const GHSA_PATTERN =
	/^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/u;
const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const TIMESTAMP_PATTERN =
	/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;

function fail(code) {
	throw new EvidenceError(code);
}

export function validateDependabotExpectation(value) {
	const fixture = safeClone(value);
	assertExactKeys(fixture, [
		"defaultSha",
		"open",
		"repository",
		"schemaVersion",
	]);
	if (
		fixture.schemaVersion !== 1 ||
		fixture.repository !== "cacheplane/dawnai" ||
		!isEvidenceSha(fixture.defaultSha) ||
		!Array.isArray(fixture.open) ||
		fixture.open.length === 0
	) {
		fail("INVALID_DEPENDABOT_FIXTURE");
	}
	const open = fixture.open.map(validateNormalizedDependabotAlert);
	const numbers = open.map((alert) => alert.number);
	if (
		new Set(numbers).size !== numbers.length ||
		numbers.some(
			(number, index) => index > 0 && number <= numbers[index - 1],
		) ||
		open.some(
			(alert) =>
				alert.state !== "open" ||
				alert.fixedAt !== null ||
				alert.dismissal !== null ||
				alert.autoDismissedAt !== null,
		)
	) {
		fail("INVALID_DEPENDABOT_FIXTURE");
	}
	return {
		defaultSha: fixture.defaultSha,
		open,
		repository: fixture.repository,
		schemaVersion: 1,
	};
}

export function normalizeDependabotAlert(value) {
	const alert = safeClone(value);
	if (
		!isRecord(alert) ||
		!Number.isSafeInteger(alert.number) ||
		alert.number < 1 ||
		!["auto_dismissed", "dismissed", "fixed", "open"].includes(alert.state) ||
		!isRecord(alert.dependency) ||
		!isRecord(alert.dependency.package) ||
		alert.dependency.package.ecosystem !== "npm" ||
		typeof alert.dependency.package.name !== "string" ||
		!PACKAGE_PATTERN.test(alert.dependency.package.name) ||
		typeof alert.dependency.manifest_path !== "string" ||
		!isSafeManifest(alert.dependency.manifest_path) ||
		!["direct", "transitive"].includes(alert.dependency.relationship) ||
		!["development", "runtime"].includes(alert.dependency.scope) ||
		!isRecord(alert.security_advisory) ||
		typeof alert.security_advisory.ghsa_id !== "string" ||
		!GHSA_PATTERN.test(alert.security_advisory.ghsa_id) ||
		!["critical", "high", "low", "medium"].includes(
			alert.security_advisory.severity,
		) ||
		!isEvidenceTimestamp(alert.created_at) ||
		!isEvidenceTimestamp(alert.updated_at)
	) {
		fail("INVALID_DEPENDABOT_ALERT");
	}
	const fixedAt = normalizeNullableTimestamp(alert.fixed_at);
	const autoDismissedAt = normalizeNullableTimestamp(alert.auto_dismissed_at);
	const dismissal = normalizeDismissal(alert);
	if (
		(alert.state === "open" &&
			(fixedAt !== null || dismissal !== null || autoDismissedAt !== null)) ||
		(alert.state === "fixed" && (fixedAt === null || dismissal !== null)) ||
		(alert.state === "dismissed" && dismissal === null) ||
		(alert.state === "auto_dismissed" && autoDismissedAt === null)
	) {
		fail("INVALID_DEPENDABOT_ALERT");
	}
	return {
		autoDismissedAt,
		createdAt: alert.created_at,
		dismissal,
		ecosystem: "npm",
		fixedAt,
		ghsa: alert.security_advisory.ghsa_id,
		manifest: alert.dependency.manifest_path,
		number: alert.number,
		package: alert.dependency.package.name,
		relationship: alert.dependency.relationship,
		scope: alert.dependency.scope,
		severity: alert.security_advisory.severity,
		state: alert.state,
		updatedAt: alert.updated_at,
	};
}

export function validateNormalizedDependabotAlert(value) {
	if (!isRecord(value)) fail("INVALID_DEPENDABOT_FIXTURE");
	assertExactKeys(value, [
		"autoDismissedAt",
		"createdAt",
		"dismissal",
		"ecosystem",
		"fixedAt",
		"ghsa",
		"manifest",
		"number",
		"package",
		"relationship",
		"scope",
		"severity",
		"state",
		"updatedAt",
	]);
	return normalizeDependabotAlert({
		auto_dismissed_at: value.autoDismissedAt,
		created_at: value.createdAt,
		dependency: {
			manifest_path: value.manifest,
			package: { ecosystem: value.ecosystem, name: value.package },
			relationship: value.relationship,
			scope: value.scope,
		},
		dismissed_at: value.dismissal?.at ?? null,
		dismissed_by:
			value.dismissal === null ? null : { login: value.dismissal?.by },
		dismissed_comment: value.dismissal?.comment ?? null,
		dismissed_reason: value.dismissal?.reason ?? null,
		fixed_at: value.fixedAt,
		number: value.number,
		security_advisory: { ghsa_id: value.ghsa, severity: value.severity },
		state: value.state,
		updated_at: value.updatedAt,
	});
}

function normalizeDismissal(alert) {
	const values = [
		alert.dismissed_at,
		alert.dismissed_by,
		alert.dismissed_comment,
		alert.dismissed_reason,
	];
	if (values.every((value) => value === null)) return null;
	if (
		!isEvidenceTimestamp(alert.dismissed_at) ||
		!isRecord(alert.dismissed_by) ||
		typeof alert.dismissed_by.login !== "string" ||
		!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(alert.dismissed_by.login) ||
		typeof alert.dismissed_comment !== "string" ||
		Buffer.byteLength(alert.dismissed_comment, "utf8") > 4096 ||
		typeof alert.dismissed_reason !== "string" ||
		!/^[a-z_]{1,64}$/u.test(alert.dismissed_reason)
	) {
		fail("INVALID_DEPENDABOT_ALERT");
	}
	return {
		at: alert.dismissed_at,
		by: alert.dismissed_by.login,
		comment: alert.dismissed_comment,
		reason: alert.dismissed_reason,
	};
}

function normalizeNullableTimestamp(value) {
	if (value === null) return null;
	if (!isEvidenceTimestamp(value)) fail("INVALID_DEPENDABOT_ALERT");
	return value;
}

export function isEvidenceTimestamp(value) {
	if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return false;
	try {
		return new Date(timestamp).toISOString().replace(".000Z", "Z") === value;
	} catch {
		return false;
	}
}

export function isEvidenceSha(value) {
	return typeof value === "string" && SHA_PATTERN.test(value);
}

function isSafeManifest(value) {
	return (
		value.length > 0 &&
		value.length <= 1024 &&
		!value.startsWith("/") &&
		!value.includes("\\") &&
		value
			.split("/")
			.every((part) => part !== "" && part !== "." && part !== "..")
	);
}

function safeClone(value) {
	try {
		return JSON.parse(canonicalJsonBytes(value).toString("utf8"));
	} catch {
		fail("INVALID_DEPENDABOT_VALUE");
	}
}

function assertExactKeys(value, expected) {
	if (!isRecord(value)) fail("INVALID_DEPENDABOT_FIXTURE");
	const actual = Object.keys(value).sort(compareText);
	const wanted = [...expected].sort(compareText);
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
		fail("INVALID_DEPENDABOT_FIXTURE");
	}
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left, right) {
	return left === right ? 0 : left < right ? -1 : 1;
}
