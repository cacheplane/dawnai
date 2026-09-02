import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID as defaultRandomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as defaultFileSystem from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import { DUPLICATE_DRAFT_CONSOLIDATION_LIMITS } from "./duplicate-draft-consolidation-schema.mjs";

const MAXIMUM_PATH_BYTES = 4096;
const IO_CHUNK_BYTES = 64 * 1024;
const PRIVATE_MODE = 0o600;
const TRACKED_MODE = 0o644;
const DEPENDENCY_FIELDS = Object.freeze([
	"effectiveUserId",
	"fileSystem",
	"randomUUID",
]);
const READ_FILE_SYSTEM_METHODS = Object.freeze(["lstat", "open"]);
const WRITE_FILE_SYSTEM_METHODS = Object.freeze([
	...READ_FILE_SYSTEM_METHODS,
	"rename",
	"unlink",
]);
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PRIVATE_READ_PROVENANCE = new WeakMap();
const PRIVATE_TRANSACTION_CONTEXT = new AsyncLocalStorage();
const JOURNAL_BASENAME = "duplicate-draft-consolidation.journal.json";
const JOURNAL_HEAD_BASENAME = "duplicate-draft-consolidation.journal.head.json";
const LOCK_RECORD_BYTES = 2048;
const LOCK_TIMESTAMP_PATTERN =
	/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const PROCESS_START_IDENTITY = `${process.pid}:${Math.trunc(
	Date.now() - process.uptime() * 1000,
)}`;

// Approved threat model: one operator and cooperative in-scope writers. Every
// consolidation journal/head publication must hold this module's lease. An
// arbitrary external filesystem writer is out of scope; no cross-process
// lockfile protocol can make its rename atomic with ours. Identity checks make
// such interference fail closed when observed, but are not a general CAS claim.

const POLICIES = Object.freeze({
	private: Object.freeze({ label: "private envelope", mode: PRIVATE_MODE }),
	tracked: Object.freeze({ label: "tracked receipt", mode: TRACKED_MODE }),
});

export async function readPrivateEnvelope(
	filePath,
	maximumBytes,
	dependencies,
) {
	return readEvidence(filePath, maximumBytes, dependencies, POLICIES.private);
}

export async function writePrivateEnvelope(
	filePath,
	bytes,
	dependencies,
	expectedCurrent,
) {
	const target = snapshotPath(filePath);
	const lockTarget = privateLockTarget(target);
	if (lockTarget !== null && expectedCurrent !== undefined) {
		assertActivePrivateLease(lockTarget);
		return writeEvidence(
			target,
			bytes,
			dependencies,
			POLICIES.private,
			expectedCurrent,
		);
	}
	return withPrivateWriteLock(target, dependencies, () =>
		writeEvidence(
			target,
			bytes,
			dependencies,
			POLICIES.private,
			expectedCurrent,
		),
	);
}

Object.defineProperty(readPrivateEnvelope, "authenticate", {
	value(value, expectedPath) {
		const target = snapshotPath(expectedPath);
		const provenance =
			value !== null && typeof value === "object"
				? PRIVATE_READ_PROVENANCE.get(value)
				: undefined;
		if (
			provenance === undefined ||
			provenance.path !== target ||
			!Buffer.isBuffer(value) ||
			sha256(value) !== provenance.sha256
		) {
			throw new TypeError(
				"Authenticated private read provenance or byte digest is invalid",
			);
		}
		return provenance;
	},
	enumerable: false,
	writable: false,
	configurable: false,
});

Object.defineProperty(writePrivateEnvelope, "withExclusiveTransaction", {
	value(filePath, operation, dependencies) {
		const target = snapshotPath(filePath);
		if (typeof operation !== "function" || utilTypes.isProxy(operation)) {
			throw new TypeError("Private envelope transaction callback is invalid");
		}
		return withPrivateWriteLock(target, dependencies, operation);
	},
	enumerable: false,
	writable: false,
	configurable: false,
});

export async function readTrackedReceipt(filePath, maximumBytes, dependencies) {
	return readEvidence(filePath, maximumBytes, dependencies, POLICIES.tracked);
}

export async function writeTrackedReceipt(filePath, bytes, dependencies) {
	return writeEvidence(filePath, bytes, dependencies, POLICIES.tracked);
}

async function readEvidence(filePath, maximumBytes, dependencies, policy) {
	const target = snapshotPath(filePath);
	const maximum = snapshotMaximumBytes(maximumBytes);
	const runtime = snapshotDependencies(dependencies, false);
	requireNoFollowSupport(false);
	const parentPath = path.dirname(target);
	const parentChain = await captureParentChain(
		runtime.operations,
		parentPath,
		policy.label,
	);
	const parentGuard = await openParentGuard(
		runtime.operations,
		parentPath,
		parentChain,
		policy.label,
		false,
	);
	let handle;
	let primaryError = null;
	let result = null;
	try {
		await assertParentChainCurrent(
			runtime.operations,
			parentChain,
			policy.label,
		);
		handle = await openNoFollow(
			runtime.operations,
			target,
			fsConstants.O_RDONLY,
			policy.label,
		);
		const handleOperations = snapshotHandleOperations(handle, [
			"close",
			"read",
			"stat",
		]);
		const before = await handleOperations.stat({ bigint: true });
		assertSourcePolicy(before, runtime.effectiveUserId, policy);
		if (
			before.size < 0n ||
			before.size > BigInt(maximum) ||
			before.size > BigInt(Number.MAX_SAFE_INTEGER)
		) {
			throw new Error(`${capitalize(policy.label)} exceeds its byte bound`);
		}
		const bytes = Buffer.allocUnsafe(Number(before.size));
		let offset = 0;
		while (offset < bytes.byteLength) {
			const requested = Math.min(IO_CHUNK_BYTES, bytes.byteLength - offset);
			const readResult = await handleOperations.read(
				bytes,
				offset,
				requested,
				offset,
			);
			const bytesRead = resultCount(
				readResult,
				"bytesRead",
				requested,
				`${policy.label} read`,
			);
			if (bytesRead === 0) break;
			offset += bytesRead;
			if (offset > maximum)
				throw new Error(`${capitalize(policy.label)} exceeds its byte bound`);
		}
		const after = await handleOperations.stat({ bigint: true });
		const current = await runtime.operations.lstat(target, { bigint: true });
		if (
			offset !== bytes.byteLength ||
			!sameFileState(before, after) ||
			current.isSymbolicLink() ||
			!sameFileState(after, current)
		) {
			throw new Error(`${capitalize(policy.label)} changed while it was read`);
		}
		assertSourcePolicy(after, runtime.effectiveUserId, policy);
		assertSourcePolicy(current, runtime.effectiveUserId, policy);
		await assertParentChainCurrent(
			runtime.operations,
			parentChain,
			policy.label,
		);
		result = Buffer.from(bytes);
		if (policy === POLICIES.private) recordPrivateRead(result, target, after);
	} catch (error) {
		primaryError = error;
	}

	const closeErrors = [];
	if (handle !== undefined) {
		try {
			await snapshotHandleOperations(handle, ["close"]).close();
		} catch (error) {
			closeErrors.push(error);
		}
	}
	try {
		await parentGuard.operations.close();
	} catch (error) {
		closeErrors.push(error);
	}
	throwCombined(
		primaryError,
		closeErrors,
		`${capitalize(policy.label)} read failed during cleanup`,
	);
	return result;
}

async function writeEvidence(
	filePath,
	inputBytes,
	dependencies,
	policy,
	expectedCurrent,
) {
	const target = snapshotPath(filePath);
	const bytes = snapshotWriteBytes(inputBytes, policy.label);
	const expected = snapshotExpectedCurrent(expectedCurrent, policy, target);
	const runtime = snapshotDependencies(dependencies, true);
	requireNoFollowSupport(true);
	const identifier = runtime.randomUUID();
	if (typeof identifier !== "string" || !UUID_PATTERN.test(identifier)) {
		throw new TypeError(
			`${capitalize(policy.label)} temporary identity is invalid`,
		);
	}

	const parentPath = path.dirname(target);
	const parentChain = await captureParentChain(
		runtime.operations,
		parentPath,
		policy.label,
	);
	const parentGuard = await openParentGuard(
		runtime.operations,
		parentPath,
		parentChain,
		policy.label,
		true,
	);
	const temporaryPath = path.join(
		parentPath,
		`.${path.basename(target)}.${process.pid}.${identifier}.tmp`,
	);
	let existingIdentity;
	let temporaryHandle;
	let temporaryOperations;
	let temporaryIdentity;
	let temporaryCreated = false;
	let renamed = false;
	let publishedIdentity;
	let primaryError = null;

	try {
		await assertParentChainCurrent(
			runtime.operations,
			parentChain,
			policy.label,
		);
		existingIdentity = await inspectExistingDestination(
			runtime,
			target,
			policy,
			parentChain,
			expected,
		);
		temporaryHandle = await openNoFollow(
			runtime.operations,
			temporaryPath,
			fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL,
			policy.label,
			policy.mode,
		);
		temporaryCreated = true;
		temporaryOperations = snapshotHandleOperations(temporaryHandle, [
			"chmod",
			"close",
			"read",
			"stat",
			"sync",
			"write",
		]);
		await temporaryOperations.chmod(policy.mode);
		temporaryIdentity = await temporaryOperations.stat({ bigint: true });
		assertTemporaryFile(temporaryIdentity, runtime.effectiveUserId, policy, 0);

		let offset = 0;
		while (offset < bytes.byteLength) {
			const requested = Math.min(IO_CHUNK_BYTES, bytes.byteLength - offset);
			const writeResult = await temporaryOperations.write(
				bytes,
				offset,
				requested,
				offset,
			);
			const bytesWritten = resultCount(
				writeResult,
				"bytesWritten",
				requested,
				`${policy.label} write`,
			);
			if (bytesWritten === 0) {
				throw new Error(
					`${capitalize(policy.label)} temporary write made no progress`,
				);
			}
			offset += bytesWritten;
		}
		await temporaryOperations.sync();
		temporaryIdentity = await temporaryOperations.stat({ bigint: true });
		assertTemporaryFile(
			temporaryIdentity,
			runtime.effectiveUserId,
			policy,
			bytes.byteLength,
		);
		await assertParentChainCurrent(
			runtime.operations,
			parentChain,
			policy.label,
		);
		await assertDestinationUnchanged(runtime, target, existingIdentity, policy);
		await assertTemporaryPathCurrent(
			runtime.operations,
			temporaryPath,
			temporaryIdentity,
			runtime.effectiveUserId,
			policy,
		);
		await runtime.operations.rename(temporaryPath, target);
		renamed = true;
		try {
			publishedIdentity = await verifyPublishedBytes(
				runtime.operations,
				temporaryOperations,
				target,
				temporaryIdentity,
				bytes,
				runtime.effectiveUserId,
				policy,
				false,
			);
			await temporaryOperations.sync();
			publishedIdentity = await verifyPublishedBytes(
				runtime.operations,
				temporaryOperations,
				target,
				publishedIdentity,
				bytes,
				runtime.effectiveUserId,
				policy,
				true,
			);
			await parentGuard.operations.sync();
			await assertParentChainCurrent(
				runtime.operations,
				parentChain,
				policy.label,
			);
			await verifyPublishedBytes(
				runtime.operations,
				temporaryOperations,
				target,
				publishedIdentity,
				bytes,
				runtime.effectiveUserId,
				policy,
				true,
			);
			await temporaryOperations.close();
			temporaryHandle = undefined;
		} catch (error) {
			throw new Error(
				`${capitalize(policy.label)} publication or durability is ambiguous after atomic replacement`,
				{ cause: error },
			);
		}
	} catch (error) {
		primaryError = error;
	}

	const secondaryErrors = [];
	let retainedState = null;
	if (temporaryHandle !== undefined) {
		try {
			const operations =
				temporaryOperations ??
				snapshotHandleOperations(temporaryHandle, ["close"]);
			await operations.close();
		} catch (error) {
			secondaryErrors.push(error);
		}
	}
	if (temporaryCreated && !renamed) {
		retainedState = await observeRetainedTemporary(
			runtime.operations,
			temporaryPath,
			temporaryIdentity,
		);
		if (primaryError !== null) {
			primaryError = new Error(
				retainedTemporaryMessage(policy.label, temporaryPath, retainedState),
				{ cause: primaryError },
			);
		}
	}
	try {
		await parentGuard.operations.close();
	} catch (error) {
		secondaryErrors.push(error);
	}
	if (renamed && primaryError === null && secondaryErrors.length > 0) {
		primaryError = new Error(
			`${capitalize(policy.label)} publication completed but descriptor cleanup status is ambiguous`,
			{ cause: secondaryErrors.shift() },
		);
	}

	throwCombined(
		primaryError,
		secondaryErrors,
		renamed
			? `${capitalize(policy.label)} publication or durability is ambiguous and descriptor cleanup also failed`
			: `${capitalize(policy.label)} write and retained-path inspection both failed`,
	);
	return Buffer.from(bytes);
}

function snapshotDependencies(dependencies, needsWrite) {
	if (dependencies === undefined) dependencies = Object.create(null);
	if (
		dependencies === null ||
		typeof dependencies !== "object" ||
		utilTypes.isProxy(dependencies) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(dependencies))
	) {
		throw new TypeError("Consolidation file dependencies are unsafe");
	}
	const values = Object.create(null);
	for (const key of Reflect.ownKeys(dependencies)) {
		const descriptor =
			typeof key === "string"
				? Object.getOwnPropertyDescriptor(dependencies, key)
				: undefined;
		if (
			typeof key !== "string" ||
			!DEPENDENCY_FIELDS.includes(key) ||
			descriptor === undefined ||
			!descriptor.enumerable ||
			!("value" in descriptor)
		) {
			throw new TypeError(
				"Consolidation file dependencies contain an unsafe field",
			);
		}
		values[key] = descriptor.value;
	}

	const fileSystem = values.fileSystem ?? defaultFileSystem;
	const operations = Object.create(null);
	const fileSystemMethods = needsWrite
		? WRITE_FILE_SYSTEM_METHODS
		: READ_FILE_SYSTEM_METHODS;
	for (const method of fileSystemMethods) {
		operations[method] = dataMethod(fileSystem, method, "filesystem").bind(
			fileSystem,
		);
	}
	const effectiveUserId = values.effectiveUserId ?? defaultEffectiveUserId;
	if (
		typeof effectiveUserId !== "function" ||
		utilTypes.isProxy(effectiveUserId)
	) {
		throw new TypeError(
			"Consolidation file effective-user dependency is unsafe",
		);
	}
	const currentUserId = effectiveUserId();
	if (!Number.isSafeInteger(currentUserId) || currentUserId < 0) {
		throw new TypeError("Consolidation file effective user is unavailable");
	}
	const randomUUID = values.randomUUID ?? defaultRandomUUID;
	if (
		needsWrite &&
		(typeof randomUUID !== "function" || utilTypes.isProxy(randomUUID))
	) {
		throw new TypeError(
			"Consolidation file random identity dependency is unsafe",
		);
	}
	return Object.freeze({
		effectiveUserId: BigInt(currentUserId),
		operations: Object.freeze(operations),
		randomUUID,
	});
}

function defaultEffectiveUserId() {
	if (typeof process.geteuid !== "function") {
		throw new TypeError("Consolidation file effective user is unavailable");
	}
	return process.geteuid();
}

function snapshotHandleOperations(handle, names) {
	if (
		handle === null ||
		(typeof handle !== "object" && typeof handle !== "function")
	) {
		throw new TypeError("Consolidation file descriptor is unsafe");
	}
	const operations = Object.create(null);
	for (const name of names)
		operations[name] = dataMethod(handle, name, "descriptor").bind(handle);
	return Object.freeze(operations);
}

function dataMethod(object, name, label) {
	if (
		object === null ||
		(typeof object !== "object" && typeof object !== "function") ||
		utilTypes.isProxy(object)
	) {
		throw new TypeError(`Consolidation file ${label} is unsafe`);
	}
	let current = object;
	while (current !== null) {
		if (utilTypes.isProxy(current))
			throw new TypeError(`Consolidation file ${label} is unsafe`);
		const descriptor = Object.getOwnPropertyDescriptor(current, name);
		if (descriptor !== undefined) {
			if (!("value" in descriptor) || typeof descriptor.value !== "function") {
				throw new TypeError(`Consolidation file ${label} must expose ${name}`);
			}
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	throw new TypeError(`Consolidation file ${label} must expose ${name}`);
}

function snapshotPath(value) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		hasControlCharacters(value) ||
		Buffer.byteLength(value, "utf8") > MAXIMUM_PATH_BYTES ||
		!path.isAbsolute(value) ||
		path.resolve(value) !== value ||
		value === path.parse(value).root
	) {
		throw new TypeError("Consolidation evidence file path is invalid");
	}
	return value;
}

function snapshotMaximumBytes(value) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError("Consolidation evidence byte bound is invalid");
	}
	return value;
}

function snapshotWriteBytes(value, label) {
	if (
		!(value instanceof Uint8Array) ||
		utilTypes.isProxy(value) ||
		(!Buffer.isBuffer(value) &&
			Object.getPrototypeOf(value) !== Uint8Array.prototype) ||
		(typeof SharedArrayBuffer === "function" &&
			value.buffer instanceof SharedArrayBuffer)
	) {
		throw new TypeError(
			`${capitalize(label)} bytes must be one owned byte array`,
		);
	}
	if (
		value.byteLength > DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.finalReceiptBytes
	) {
		throw new Error(`${capitalize(label)} exceeds its write byte bound`);
	}
	try {
		return Buffer.from(value);
	} catch {
		throw new TypeError(
			`${capitalize(label)} bytes could not be safely copied`,
		);
	}
}

function snapshotExpectedCurrent(value, policy, target) {
	if (value === undefined) return null;
	if (policy !== POLICIES.private) {
		throw new TypeError(
			"Only private envelopes support authenticated replacement",
		);
	}
	if (value === null) return Object.freeze({ absent: true });
	const provenance =
		value !== null && typeof value === "object"
			? PRIVATE_READ_PROVENANCE.get(value)
			: undefined;
	if (
		provenance === undefined ||
		provenance.path !== target ||
		!Buffer.isBuffer(value) ||
		sha256(value) !== provenance.sha256
	) {
		throw new TypeError(
			"Authenticated private replacement requires the exact no-follow read result",
		);
	}
	return Object.freeze({
		bytes: Buffer.from(value),
		identity: provenance.identity,
	});
}

function recordPrivateRead(bytes, target, status) {
	const provenance = Object.freeze({
		path: target,
		identity: fileIdentity(status),
		sha256: sha256(bytes),
	});
	PRIVATE_READ_PROVENANCE.set(bytes, provenance);
	return bytes;
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

async function withPrivateWriteLock(target, dependencies, operation) {
	const lockTarget = privateLockTarget(target);
	if (lockTarget === null) return operation();
	const active = PRIVATE_TRANSACTION_CONTEXT.getStore();
	if (active?.active === true && active.lockTarget === lockTarget) {
		return operation(() => assertActivePrivateLease(lockTarget, active));
	}
	if (active?.active === true) {
		throw new Error("Private envelope transaction cannot acquire another lock");
	}
	const runtime = snapshotDependencies(dependencies, true);
	const identifier = runtime.randomUUID();
	if (typeof identifier !== "string" || !UUID_PATTERN.test(identifier)) {
		throw new TypeError("Private envelope lock identity is invalid");
	}
	const parentPath = path.dirname(lockTarget);
	const parentChain = await captureParentChain(
		runtime.operations,
		parentPath,
		"private envelope lock",
	);
	const parentGuard = await openParentGuard(
		runtime.operations,
		parentPath,
		parentChain,
		"private envelope lock",
		true,
	);
	let handle;
	let operations;
	let identity;
	let primaryError = null;
	let result;
	try {
		try {
			handle = await openNoFollow(
				runtime.operations,
				lockTarget,
				fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL,
				"private envelope lock",
				PRIVATE_MODE,
			);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			await quarantineProvablyDeadLock({
				runtime,
				lockTarget,
				identifier,
				parentGuard,
			});
			handle = await openNoFollow(
				runtime.operations,
				lockTarget,
				fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL,
				"private envelope lock",
				PRIVATE_MODE,
			);
		}
		operations = snapshotHandleOperations(handle, [
			"chmod",
			"close",
			"stat",
			"sync",
			"write",
		]);
		await operations.chmod(PRIVATE_MODE);
		const lockBytes = canonicalPrivateLockBytes({
			lockTarget,
			nonce: identifier,
		});
		const written = await operations.write(
			lockBytes,
			0,
			lockBytes.byteLength,
			0,
		);
		if (
			resultCount(
				written,
				"bytesWritten",
				lockBytes.byteLength,
				"lock write",
			) !== lockBytes.byteLength
		) {
			throw new Error("Private envelope lock write is incomplete");
		}
		await operations.sync();
		identity = await operations.stat({ bigint: true });
		assertTemporaryFile(
			identity,
			runtime.effectiveUserId,
			POLICIES.private,
			lockBytes.byteLength,
		);
		const current = await runtime.operations.lstat(lockTarget, {
			bigint: true,
		});
		if (!sameFileState(identity, current))
			throw new Error("Private envelope lock path changed during acquisition");
		await parentGuard.operations.sync();
		const lease = { active: true, id: identifier, lockTarget };
		result = await PRIVATE_TRANSACTION_CONTEXT.run(lease, async () => {
			try {
				return await operation(() =>
					assertActivePrivateLease(lockTarget, lease),
				);
			} finally {
				lease.active = false;
			}
		});
	} catch (error) {
		primaryError = error;
	}

	const cleanupErrors = [];
	if (operations !== undefined) {
		try {
			await operations.close();
			handle = undefined;
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	if (identity !== undefined) {
		try {
			const current = await runtime.operations.lstat(lockTarget, {
				bigint: true,
			});
			if (!sameFileState(identity, current)) {
				throw new Error(
					"Private envelope lock ownership changed; retained fail-closed",
				);
			}
			const releasedPath = `${lockTarget}.${identifier}.released`;
			await runtime.operations.rename(lockTarget, releasedPath);
			const released = await runtime.operations.lstat(releasedPath, {
				bigint: true,
			});
			if (!sameFileObject(identity, released)) {
				throw new Error(
					"Private envelope lock release identity changed; retained fail-closed",
				);
			}
			await runtime.operations.unlink(releasedPath);
			await parentGuard.operations.sync();
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	try {
		await parentGuard.operations.close();
	} catch (error) {
		cleanupErrors.push(error);
	}
	throwCombined(
		primaryError,
		cleanupErrors,
		"Private envelope transaction and lock cleanup both failed",
	);
	return result;
}

async function quarantineProvablyDeadLock({
	runtime,
	lockTarget,
	identifier,
	parentGuard,
}) {
	const before = await runtime.operations.lstat(lockTarget, { bigint: true });
	assertPrivateLockFile(before, runtime.effectiveUserId);
	if (before.size <= 0n || before.size > BigInt(LOCK_RECORD_BYTES)) {
		throw new Error("Existing private lock record has an invalid byte length");
	}
	const handle = await openNoFollow(
		runtime.operations,
		lockTarget,
		fsConstants.O_RDONLY,
		"existing private envelope lock",
	);
	const operations = snapshotHandleOperations(handle, [
		"close",
		"read",
		"stat",
	]);
	let closed = false;
	try {
		const opened = await operations.stat({ bigint: true });
		assertPrivateLockFile(opened, runtime.effectiveUserId);
		if (!sameFileState(before, opened)) {
			throw new Error("Existing private lock changed before recovery read");
		}
		const first = await readExactHandleBytes(
			operations,
			Number(opened.size),
			"existing private lock",
		);
		const afterFirst = await operations.stat({ bigint: true });
		const second = await readExactHandleBytes(
			operations,
			Number(opened.size),
			"existing private lock repeat",
		);
		const afterSecond = await operations.stat({ bigint: true });
		const current = await runtime.operations.lstat(lockTarget, {
			bigint: true,
		});
		if (
			!first.equals(second) ||
			!sameFileState(opened, afterFirst) ||
			!sameFileState(afterFirst, afterSecond) ||
			!sameFileState(afterSecond, current)
		) {
			throw new Error("Existing private lock changed during recovery read");
		}
		const record = parseCanonicalPrivateLock(first, lockTarget);
		assertProvablyDeadProcess(record);
		await operations.close();
		closed = true;
		const finalCurrent = await runtime.operations.lstat(lockTarget, {
			bigint: true,
		});
		if (!sameFileState(current, finalCurrent)) {
			throw new Error("Existing private lock changed before quarantine");
		}
		const quarantinePath = `${lockTarget}.${identifier}.quarantine`;
		await runtime.operations.rename(lockTarget, quarantinePath);
		const quarantined = await runtime.operations.lstat(quarantinePath, {
			bigint: true,
		});
		assertPrivateLockFile(quarantined, runtime.effectiveUserId);
		if (!sameFileObject(finalCurrent, quarantined)) {
			throw new Error(
				"Quarantined private lock identity changed during recovery",
			);
		}
		await parentGuard.operations.sync();
	} finally {
		if (!closed) await operations.close();
	}
}

function canonicalPrivateLockBytes({ lockTarget, nonce }) {
	return Buffer.from(
		`${JSON.stringify({
			schemaVersion: 1,
			pid: process.pid,
			processStartIdentity: PROCESS_START_IDENTITY,
			nonce,
			path: lockTarget,
			createdAt: new Date().toISOString(),
		})}\n`,
		"utf8",
	);
}

function parseCanonicalPrivateLock(bytes, lockTarget) {
	let record;
	try {
		record = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		);
	} catch {
		throw new Error("Existing private lock record is malformed");
	}
	const expectedKeys = [
		"schemaVersion",
		"pid",
		"processStartIdentity",
		"nonce",
		"path",
		"createdAt",
	];
	const keys =
		record !== null && typeof record === "object"
			? Reflect.ownKeys(record)
			: [];
	if (
		record === null ||
		typeof record !== "object" ||
		utilTypes.isProxy(record) ||
		Object.getPrototypeOf(record) !== Object.prototype ||
		keys.length !== expectedKeys.length ||
		keys.some((key, index) => key !== expectedKeys[index]) ||
		record.schemaVersion !== 1 ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		(record.processStartIdentity !== null &&
			(typeof record.processStartIdentity !== "string" ||
				record.processStartIdentity.length === 0 ||
				Buffer.byteLength(record.processStartIdentity, "utf8") > 256)) ||
		typeof record.nonce !== "string" ||
		!UUID_PATTERN.test(record.nonce) ||
		record.path !== lockTarget ||
		typeof record.createdAt !== "string" ||
		!LOCK_TIMESTAMP_PATTERN.test(record.createdAt) ||
		Number.isNaN(Date.parse(record.createdAt))
	) {
		throw new Error("Existing private lock record is invalid");
	}
	const canonical = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
	if (!bytes.equals(canonical)) {
		throw new Error("Existing private lock record is not canonical");
	}
	return record;
}

function assertProvablyDeadProcess(record) {
	try {
		process.kill(record.pid, 0);
	} catch (error) {
		if (errorCode(error) === "ESRCH") return;
		throw new Error("Existing private lock owner status is unknown", {
			cause: error,
		});
	}
	throw new Error(
		"Existing private lock owner is live or its PID may have been reused",
	);
}

function assertPrivateLockFile(status, expectedUserId) {
	if (!status.isFile() || status.isSymbolicLink()) {
		throw new Error("Existing private lock must be a regular no-follow file");
	}
	if (status.nlink !== 1n) {
		throw new Error("Existing private lock must have exactly one link");
	}
	if (status.uid !== expectedUserId) {
		throw new Error(
			"Existing private lock must have the current effective owner",
		);
	}
	if (Number(status.mode & 0o7777n) !== PRIVATE_MODE) {
		throw new Error("Existing private lock must have exact mode 0600");
	}
}

async function readExactHandleBytes(operations, size, label) {
	const bytes = Buffer.allocUnsafe(size);
	let offset = 0;
	while (offset < size) {
		const requested = Math.min(IO_CHUNK_BYTES, size - offset);
		const result = await operations.read(bytes, offset, requested, offset);
		const count = resultCount(result, "bytesRead", requested, `${label} read`);
		if (count === 0) break;
		offset += count;
	}
	if (offset !== size)
		throw new Error(`${capitalize(label)} read is incomplete`);
	return bytes;
}

function assertActivePrivateLease(lockTarget, expectedLease) {
	const lease = PRIVATE_TRANSACTION_CONTEXT.getStore();
	if (
		lease === undefined ||
		lease.active !== true ||
		lease.lockTarget !== lockTarget ||
		(expectedLease !== undefined && lease !== expectedLease)
	) {
		throw new Error(
			"Authenticated journal access requires the active exact transaction lease",
		);
	}
	return lease;
}

function privateLockTarget(target) {
	const basename = path.basename(target);
	if (basename !== JOURNAL_BASENAME && basename !== JOURNAL_HEAD_BASENAME)
		return null;
	return path.join(path.dirname(target), `.${JOURNAL_BASENAME}.lock`);
}

function requireNoFollowSupport(needsWrite) {
	const required = [
		fsConstants.O_RDONLY,
		fsConstants.O_NOFOLLOW,
		fsConstants.O_DIRECTORY,
	];
	if (needsWrite) {
		required.push(fsConstants.O_RDWR, fsConstants.O_CREAT, fsConstants.O_EXCL);
	}
	if (
		required.some((value) => !Number.isInteger(value)) ||
		fsConstants.O_NOFOLLOW === 0 ||
		fsConstants.O_DIRECTORY === 0
	) {
		throw new TypeError(
			"Consolidation evidence no-follow containment is unavailable",
		);
	}
}

async function captureParentChain(operations, parentPath, label) {
	const parsed = path.parse(parentPath);
	const relative = parentPath.slice(parsed.root.length);
	const components = relative.length === 0 ? [] : relative.split(path.sep);
	const chain = [];
	let current = parsed.root;
	for (const component of components) {
		current = path.join(current, component);
		const status = await operations.lstat(current, { bigint: true });
		if (!status.isDirectory() || status.isSymbolicLink()) {
			throw new Error(
				`${capitalize(label)} has an unsafe parent symlink or component`,
			);
		}
		chain.push(
			Object.freeze({ dev: status.dev, ino: status.ino, path: current }),
		);
	}
	if (chain.length === 0) {
		const status = await operations.lstat(parsed.root, { bigint: true });
		if (!status.isDirectory() || status.isSymbolicLink()) {
			throw new Error(`${capitalize(label)} has an unsafe parent component`);
		}
		chain.push(
			Object.freeze({ dev: status.dev, ino: status.ino, path: parsed.root }),
		);
	}
	return Object.freeze(chain);
}

async function assertParentChainCurrent(operations, chain, label) {
	for (const expected of chain) {
		const current = await operations.lstat(expected.path, { bigint: true });
		if (
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			current.dev !== expected.dev ||
			current.ino !== expected.ino
		) {
			throw new Error(
				`${capitalize(label)} parent path changed during containment`,
			);
		}
	}
}

async function openParentGuard(
	operations,
	parentPath,
	chain,
	label,
	needsSync,
) {
	const handle = await openNoFollow(
		operations,
		parentPath,
		fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
		`${label} parent`,
	);
	const handleOperations = snapshotHandleOperations(handle, [
		"close",
		"stat",
		...(needsSync ? ["sync"] : []),
	]);
	try {
		const status = await handleOperations.stat({ bigint: true });
		const expected = chain.at(-1);
		if (
			!status.isDirectory() ||
			status.dev !== expected.dev ||
			status.ino !== expected.ino
		) {
			throw new Error(
				`${capitalize(label)} parent path changed while it was opened`,
			);
		}
		await assertParentChainCurrent(operations, chain, label);
		return Object.freeze({ handle, operations: handleOperations });
	} catch (error) {
		await handleOperations.close();
		throw error;
	}
}

async function openNoFollow(operations, filePath, flags, label, mode) {
	try {
		return await operations.open(
			filePath,
			flags | fsConstants.O_NOFOLLOW,
			mode,
		);
	} catch (error) {
		const code = errorCode(error);
		if (code === "ELOOP" || code === "ENOTDIR") {
			throw new Error(`${capitalize(label)} must be a no-follow regular path`, {
				cause: error,
			});
		}
		throw error;
	}
}

function assertSourcePolicy(status, expectedUserId, policy) {
	if (!status.isFile())
		throw new Error(`${capitalize(policy.label)} must be a regular file`);
	if (status.nlink !== 1n)
		throw new Error(`${capitalize(policy.label)} must have exactly one link`);
	if (status.uid !== expectedUserId) {
		throw new Error(
			`${capitalize(policy.label)} must have the current effective owner`,
		);
	}
	const mode = Number(status.mode & 0o7777n);
	if (policy === POLICIES.private) {
		if (mode !== PRIVATE_MODE) {
			throw new Error(`${capitalize(policy.label)} mode must be exactly 0600`);
		}
		return;
	}
	if ((mode & 0o7000) !== 0) {
		throw new Error(
			`${capitalize(policy.label)} mode must not contain special permission bits`,
		);
	}
	if ((mode & 0o111) !== 0) {
		throw new Error(`${capitalize(policy.label)} mode must be nonexecutable`);
	}
	if ((mode & 0o022) !== 0) {
		throw new Error(
			`${capitalize(policy.label)} mode must not be group or other writable`,
		);
	}
}

function assertTemporaryFile(status, expectedUserId, policy, expectedBytes) {
	assertSourcePolicy(status, expectedUserId, policy);
	if (status.size !== BigInt(expectedBytes)) {
		throw new Error(
			`${capitalize(policy.label)} temporary write is incomplete`,
		);
	}
}

async function inspectExistingDestination(
	runtime,
	target,
	policy,
	parentChain,
	expected,
) {
	let handle;
	try {
		handle = await openNoFollow(
			runtime.operations,
			target,
			fsConstants.O_RDONLY,
			policy.label,
		);
	} catch (error) {
		if (
			errorCode(error) === "ENOENT" &&
			(expected === null || expected?.absent === true)
		)
			return null;
		if (errorCode(error) === "ENOENT") {
			throw new Error(
				`${capitalize(policy.label)} authenticated current file is missing`,
				{ cause: error },
			);
		}
		throw error;
	}
	const operations = snapshotHandleOperations(handle, [
		"close",
		"stat",
		...(expected === null ? [] : ["read"]),
	]);
	try {
		const status = await operations.stat({ bigint: true });
		assertSourcePolicy(status, runtime.effectiveUserId, policy);
		if (expected?.absent === true) {
			throw new Error(
				`${capitalize(policy.label)} appeared before authenticated creation`,
			);
		}
		if (expected !== null && !sameIdentityRecord(expected.identity, status)) {
			throw new Error(
				`${capitalize(policy.label)} no longer identifies the authenticated current file`,
			);
		}
		if (expected !== null) {
			if (status.size !== BigInt(expected.bytes.byteLength)) {
				throw new Error(
					`${capitalize(policy.label)} current bytes differ before authenticated replacement`,
				);
			}
			const observed = Buffer.allocUnsafe(expected.bytes.byteLength);
			let offset = 0;
			while (offset < observed.byteLength) {
				const requested = Math.min(
					IO_CHUNK_BYTES,
					observed.byteLength - offset,
				);
				const readResult = await operations.read(
					observed,
					offset,
					requested,
					offset,
				);
				const bytesRead = resultCount(
					readResult,
					"bytesRead",
					requested,
					`${policy.label} authenticated current read`,
				);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			const afterRead = await operations.stat({ bigint: true });
			if (
				offset !== observed.byteLength ||
				!observed.equals(expected.bytes) ||
				!sameFileState(status, afterRead)
			) {
				throw new Error(
					`${capitalize(policy.label)} current bytes changed before authenticated replacement`,
				);
			}
		}
		const current = await runtime.operations.lstat(target, { bigint: true });
		if (current.isSymbolicLink() || !sameFileState(status, current)) {
			throw new Error(
				`${capitalize(policy.label)} destination changed during inspection`,
			);
		}
		assertSourcePolicy(current, runtime.effectiveUserId, policy);
		await assertParentChainCurrent(
			runtime.operations,
			parentChain,
			policy.label,
		);
		return fileIdentity(status);
	} finally {
		await operations.close();
	}
}

async function assertDestinationUnchanged(runtime, target, expected, policy) {
	let current;
	try {
		current = await runtime.operations.lstat(target, { bigint: true });
	} catch (error) {
		if (expected === null && errorCode(error) === "ENOENT") return;
		throw error;
	}
	if (
		expected === null ||
		current.isSymbolicLink() ||
		!sameIdentityRecord(expected, current)
	) {
		throw new Error(
			`${capitalize(policy.label)} destination changed before atomic replacement`,
		);
	}
	assertSourcePolicy(current, runtime.effectiveUserId, policy);
}

async function assertTemporaryPathCurrent(
	operations,
	temporaryPath,
	expected,
	expectedUserId,
	policy,
) {
	const current = await operations.lstat(temporaryPath, { bigint: true });
	if (current.isSymbolicLink() || !sameFileState(expected, current)) {
		throw new Error(
			`${capitalize(policy.label)} temporary path changed before publication`,
		);
	}
	assertTemporaryFile(current, expectedUserId, policy, Number(expected.size));
}

async function verifyPublishedBytes(
	operations,
	descriptor,
	target,
	expected,
	intendedBytes,
	expectedUserId,
	policy,
	includeChangeMetadata,
) {
	const before = await descriptor.stat({ bigint: true });
	if (
		before.dev !== expected.dev ||
		before.ino !== expected.ino ||
		before.size !== expected.size ||
		before.mtimeNs !== expected.mtimeNs ||
		(includeChangeMetadata && !sameIdentityRecord(expected, before))
	) {
		throw new Error(
			`${capitalize(policy.label)} changed during atomic publication`,
		);
	}
	assertTemporaryFile(before, expectedUserId, policy, intendedBytes.byteLength);
	const observedBytes = Buffer.allocUnsafe(intendedBytes.byteLength);
	let offset = 0;
	while (offset < observedBytes.byteLength) {
		const requested = Math.min(
			IO_CHUNK_BYTES,
			observedBytes.byteLength - offset,
		);
		const readResult = await descriptor.read(
			observedBytes,
			offset,
			requested,
			offset,
		);
		const bytesRead = resultCount(
			readResult,
			"bytesRead",
			requested,
			`${policy.label} publication read`,
		);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	const after = await descriptor.stat({ bigint: true });
	const current = await operations.lstat(target, { bigint: true });
	if (
		offset !== intendedBytes.byteLength ||
		!observedBytes.equals(intendedBytes) ||
		!sameFileState(before, after) ||
		current.isSymbolicLink() ||
		!sameFileState(after, current)
	) {
		throw new Error(
			`${capitalize(policy.label)} bytes changed during atomic publication`,
		);
	}
	assertSourcePolicy(after, expectedUserId, policy);
	assertSourcePolicy(current, expectedUserId, policy);
	return fileIdentity(after);
}

async function observeRetainedTemporary(operations, temporaryPath, expected) {
	if (expected === undefined) return "unobservable";
	const first = await retainedPathStatus(operations, temporaryPath);
	if (first === "missing" || first === "unobservable") return first;
	const second = await retainedPathStatus(operations, temporaryPath);
	if (second === "missing" || second === "unobservable") return second;
	if (
		!first.isSymbolicLink() &&
		first.dev === expected.dev &&
		first.ino === expected.ino &&
		sameFileState(first, second)
	) {
		return "owned";
	}
	return "replaced";
}

async function retainedPathStatus(operations, temporaryPath) {
	try {
		return await operations.lstat(temporaryPath, { bigint: true });
	} catch (error) {
		return errorCode(error) === "ENOENT" ? "missing" : "unobservable";
	}
}

function retainedTemporaryMessage(label, temporaryPath, state) {
	const prefix = `${capitalize(label)} failed before publication;`;
	if (state === "owned") {
		return `${prefix} operation-owned temporary artifact ${temporaryPath} was retained for safe inspection`;
	}
	if (state === "missing") {
		return `${prefix} the operation-owned temporary artifact is no longer present at ${temporaryPath}; no pathname was removed`;
	}
	if (state === "replaced") {
		return `${prefix} temporary pathname ${temporaryPath} no longer identifies the operation-owned artifact; the replacement was left untouched`;
	}
	return `${prefix} temporary pathname ${temporaryPath} could not be identified safely and was left untouched`;
}

function sameFileState(before, after) {
	return (
		after.isFile() &&
		after.dev === before.dev &&
		after.ino === before.ino &&
		after.size === before.size &&
		after.nlink === before.nlink &&
		after.mtimeNs === before.mtimeNs &&
		after.ctimeNs === before.ctimeNs
	);
}

function sameFileObject(before, after) {
	return (
		after.isFile() &&
		after.dev === before.dev &&
		after.ino === before.ino &&
		after.size === before.size &&
		after.nlink === before.nlink
	);
}

function fileIdentity(status) {
	return Object.freeze({
		ctimeNs: status.ctimeNs,
		dev: status.dev,
		ino: status.ino,
		mtimeNs: status.mtimeNs,
		nlink: status.nlink,
		size: status.size,
	});
}

function sameIdentityRecord(expected, current) {
	return (
		current.isFile() &&
		current.dev === expected.dev &&
		current.ino === expected.ino &&
		current.size === expected.size &&
		current.nlink === expected.nlink &&
		current.mtimeNs === expected.mtimeNs &&
		current.ctimeNs === expected.ctimeNs
	);
}

function resultCount(result, field, requested, label) {
	if (
		result === null ||
		typeof result !== "object" ||
		utilTypes.isProxy(result)
	) {
		throw new TypeError(`${capitalize(label)} result is unsafe`);
	}
	const descriptor = Object.getOwnPropertyDescriptor(result, field);
	if (
		descriptor === undefined ||
		!("value" in descriptor) ||
		!Number.isSafeInteger(descriptor.value) ||
		descriptor.value < 0 ||
		descriptor.value > requested
	) {
		throw new TypeError(`${capitalize(label)} result is invalid`);
	}
	return descriptor.value;
}

function errorCode(error) {
	if (error === null || typeof error !== "object" || utilTypes.isProxy(error))
		return undefined;
	let current = error;
	while (current !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(current, "code");
		if (descriptor !== undefined)
			return "value" in descriptor ? descriptor.value : undefined;
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

function throwCombined(primaryError, secondaryErrors, message) {
	if (primaryError !== null && secondaryErrors.length > 0) {
		throw new AggregateError([primaryError, ...secondaryErrors], message);
	}
	if (primaryError !== null) throw primaryError;
	if (secondaryErrors.length > 1)
		throw new AggregateError(secondaryErrors, message);
	if (secondaryErrors.length === 1) throw secondaryErrors[0];
}

function capitalize(value) {
	return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function hasControlCharacters(value) {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint <= 0x1f || codePoint === 0x7f) return true;
	}
	return false;
}
