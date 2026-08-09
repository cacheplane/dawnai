export function validateLifecycleHooks(value, allowedNames, label) {
	if (
		value === null ||
		Array.isArray(value) ||
		typeof value !== "object" ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new TypeError(`${label} lifecycle hooks are invalid`);
	}
	const names = Object.keys(value);
	if (
		names.some((name) => !allowedNames.includes(name)) ||
		names.some((name) => typeof value[name] !== "function")
	) {
		throw new TypeError(`${label} lifecycle hooks are invalid`);
	}
	return value;
}

export function startupRollbackError({
	initiatingError,
	cancellation,
	cleanupResults,
	rollbackCode,
	cleanupCode,
	message,
}) {
	const cleanupFailures = cleanupResults.filter(
		({ status }) => status === "rejected",
	);
	if (cleanupFailures.length === 0) return null;
	const initiatingCode = cancellation?.aborted
		? "ACQUISITION_ABORTED"
		: safeCode(initiatingError, "STARTUP_FAILED");
	const errors = [
		stableError("Disposable startup failed", initiatingCode),
		...cleanupFailures.map(() =>
			stableError("Disposable startup rollback cleanup failed", cleanupCode),
		),
	];
	return Object.assign(new AggregateError(errors, message), {
		code: rollbackCode,
	});
}

function stableError(message, code) {
	return Object.assign(new Error(message), { code });
}

function safeCode(error, fallback) {
	return typeof error?.code === "string" &&
		/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
		? error.code
		: fallback;
}
