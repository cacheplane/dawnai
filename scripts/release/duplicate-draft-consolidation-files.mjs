import { randomUUID as defaultRandomUUID } from "node:crypto";
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
]);
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

export async function writePrivateEnvelope(filePath, bytes, dependencies) {
	return writeEvidence(filePath, bytes, dependencies, POLICIES.private);
}

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

async function writeEvidence(filePath, inputBytes, dependencies, policy) {
	const target = snapshotPath(filePath);
	const bytes = snapshotWriteBytes(inputBytes, policy.label);
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
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
	const operations = snapshotHandleOperations(handle, ["close", "stat"]);
	try {
		const status = await operations.stat({ bigint: true });
		assertSourcePolicy(status, runtime.effectiveUserId, policy);
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
