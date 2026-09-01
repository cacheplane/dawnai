import { spawn as nodeSpawn } from "node:child_process";
import { createServer as nodeCreateServer } from "node:net";

const defaultTimers = {
	setTimeout: globalThis.setTimeout,
	clearTimeout: globalThis.clearTimeout,
};

function assertChild(child) {
	if (
		!child ||
		typeof child.once !== "function" ||
		typeof child.off !== "function"
	) {
		throw new TypeError("child must be a ChildProcess-like event emitter");
	}
}

function assertTimers(timers) {
	if (
		!timers ||
		typeof timers.setTimeout !== "function" ||
		typeof timers.clearTimeout !== "function"
	) {
		throw new TypeError("timers must provide setTimeout() and clearTimeout()");
	}
}

function exitedChildDetail(child) {
	if (child.exitCode !== null && child.exitCode !== undefined) {
		return `code ${child.exitCode}`;
	}
	if (child.signalCode !== null && child.signalCode !== undefined) {
		return `signal ${child.signalCode}`;
	}
	return undefined;
}

export function getAvailableLoopbackPort({
	createServer = nodeCreateServer,
} = {}) {
	if (typeof createServer !== "function") {
		return Promise.reject(new TypeError("createServer must be a function"));
	}

	return new Promise((resolve, reject) => {
		const server = createServer();
		let settled = false;
		const finish = (error, port) => {
			if (settled) return;
			settled = true;
			server.off("error", onError);
			if (error) reject(error);
			else resolve(port);
		};
		const onError = (error) => finish(error);
		server.once("error", onError);
		server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
			server.unref();
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close(() =>
					finish(new Error("node:net did not assign a TCP port")),
				);
				return;
			}
			server.close((error) => finish(error ?? undefined, address.port));
		});
	});
}

export function spawnManaged(
	command,
	args = [],
	{ spawn = nodeSpawn, options = {} } = {},
) {
	if (typeof command !== "string" || command.length === 0) {
		throw new TypeError("command must be a non-empty string");
	}
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
		throw new TypeError("args must be an array of strings");
	}
	if (typeof spawn !== "function")
		throw new TypeError("spawn must be a function");
	if (!options || typeof options !== "object" || Array.isArray(options)) {
		throw new TypeError("options must be an object");
	}

	return spawn(command, args, { ...options, stdio: options.stdio ?? "pipe" });
}

export function waitForHttp(
	url,
	child,
	{
		fetch: fetchImpl = globalThis.fetch,
		timers = defaultTimers,
		timeoutMs = 10_000,
		intervalMs = 100,
		signal,
	} = {},
) {
	if (typeof url !== "string" || url.length === 0) {
		return Promise.reject(new TypeError("url must be a non-empty string"));
	}
	try {
		assertChild(child);
		assertTimers(timers);
	} catch (error) {
		return Promise.reject(error);
	}
	if (typeof fetchImpl !== "function")
		return Promise.reject(new TypeError("fetch must be a function"));
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return Promise.reject(new TypeError("timeoutMs must be a positive number"));
	}
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		return Promise.reject(
			new TypeError("intervalMs must be a positive number"),
		);
	}
	if (
		signal !== undefined &&
		(typeof signal.addEventListener !== "function" ||
			typeof signal.removeEventListener !== "function")
	) {
		return Promise.reject(new TypeError("signal must be an AbortSignal"));
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		let pollTimer;
		let timeoutTimer;

		const cleanup = () => {
			child.off("exit", onExit);
			child.off("error", onError);
			if (signal !== undefined) signal.removeEventListener("abort", onAbort);
			if (timeoutTimer !== undefined) timers.clearTimeout(timeoutTimer);
			if (pollTimer !== undefined) timers.clearTimeout(pollTimer);
		};
		const finish = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve();
		};
		const onExit = (code, signal) => {
			const detail =
				code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`;
			finish(
				new Error(
					`Managed child exited before ${url} became ready (${detail})`,
				),
			);
		};
		const onError = (error) => {
			finish(
				new Error(
					`Managed child failed before ${url} became ready: ${error.message}`,
				),
			);
		};
		const onAbort = () => {
			finish(signal.reason ?? new Error(`Cancelled while waiting for ${url}`));
		};
		const probe = async () => {
			try {
				const response = await fetchImpl(url, { signal });
				if (response?.ok) {
					finish();
					return;
				}
			} catch {
				// Connection failures are expected until the child starts listening.
			}
			if (!settled) pollTimer = timers.setTimeout(probe, intervalMs);
		};

		child.once("exit", onExit);
		child.once("error", onError);
		if (signal !== undefined) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
		}
		const existingExit = exitedChildDetail(child);
		if (existingExit !== undefined) {
			finish(
				new Error(
					`${url} cannot become ready: managed child already exited with ${existingExit}`,
				),
			);
			return;
		}
		timeoutTimer = timers.setTimeout(
			() =>
				finish(new Error(`Timed out after ${timeoutMs}ms waiting for ${url}`)),
			timeoutMs,
		);
		void probe();
	});
}

export function stopManaged(
	child,
	{
		kill = process.kill,
		timers = defaultTimers,
		timeoutMs = 2_000,
		confirmationTimeoutMs = timeoutMs,
	} = {},
) {
	try {
		assertChild(child);
		assertTimers(timers);
	} catch (error) {
		return Promise.reject(error);
	}
	if (typeof kill !== "function")
		return Promise.reject(new TypeError("kill must be a function"));
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return Promise.reject(new TypeError("timeoutMs must be a positive number"));
	}
	if (!Number.isFinite(confirmationTimeoutMs) || confirmationTimeoutMs <= 0) {
		return Promise.reject(
			new TypeError("confirmationTimeoutMs must be a positive number"),
		);
	}

	return new Promise((resolve, reject) => {
		let settled = false;
		let graceTimer;
		let confirmationTimer;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			child.off("exit", onExit);
			child.off("close", onExit);
			if (graceTimer !== undefined) timers.clearTimeout(graceTimer);
			if (confirmationTimer !== undefined)
				timers.clearTimeout(confirmationTimer);
			if (error) reject(error);
			else resolve();
		};
		const onExit = () => finish();
		child.once("exit", onExit);
		child.once("close", onExit);

		if (exitedChildDetail(child) !== undefined) {
			finish();
			return;
		}

		const pid = child.pid;
		if (!Number.isSafeInteger(pid) || pid <= 0) {
			finish(
				new Error(
					"managed child must have a known positive PID before cleanup",
				),
			);
			return;
		}

		graceTimer = timers.setTimeout(() => {
			if (settled) return;
			if (exitedChildDetail(child) !== undefined) {
				finish();
				return;
			}
			try {
				kill(pid, "SIGKILL");
			} catch (error) {
				if (error?.code === "ESRCH") finish();
				else finish(error);
			}
			if (settled) return;
			confirmationTimer = timers.setTimeout(
				() =>
					finish(
						new Error(
							`Managed child PID ${pid} did not exit within ${confirmationTimeoutMs}ms after SIGKILL`,
						),
					),
				confirmationTimeoutMs,
			);
		}, timeoutMs);

		try {
			kill(pid, "SIGTERM");
		} catch (error) {
			if (error?.code === "ESRCH") finish();
			else finish(error);
		}
	});
}
