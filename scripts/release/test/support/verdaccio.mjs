import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runServer } from "verdaccio";

const LOOPBACK = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

export async function startVerdaccio() {
	const directory = await mkdtemp(join(tmpdir(), "dawn-release-verdaccio-"));
	const storage = join(directory, "storage");
	await mkdir(storage);
	const config = {
		configPath: join(directory, "config.yaml"),
		storage,
		uplinks: {},
		packages: {
			"@fault/*": {
				access: "$all",
				publish: "$anonymous",
				unpublish: "$anonymous",
			},
			"**": { access: "$all", publish: "$anonymous", unpublish: "$anonymous" },
		},
		log: { type: "stdout", format: "pretty", level: "fatal" },
		max_body_size: "16mb",
	};
	let server;
	try {
		const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS;
		const application = await deadline(
			runServer(config),
			Math.max(1, startupDeadline - Date.now()),
			"registry startup",
		);
		const listening = application.listen(0, LOOPBACK);
		server = listening;
		await deadline(
			new Promise((resolve, reject) => {
				listening.once("listening", resolve);
				listening.once("error", reject);
			}),
			Math.max(1, startupDeadline - Date.now()),
			"registry readiness",
		);
		const address = server.address();
		if (
			address === null ||
			typeof address === "string" ||
			address.address !== LOOPBACK
		) {
			throw new Error("Disposable registry did not bind to loopback");
		}
		const url = `http://${LOOPBACK}:${address.port}/`;
		let closePromise = null;
		let serverClosed = false;
		let directoryRemoved = false;
		return Object.freeze({
			url,
			directory,
			close() {
				if (closePromise !== null) return closePromise;
				closePromise = Promise.allSettled([
					serverClosed
						? Promise.resolve()
						: deadline(
								closeServer(server),
								SHUTDOWN_TIMEOUT_MS,
								"registry shutdown",
							).then(() => {
								serverClosed = true;
							}),
					directoryRemoved
						? Promise.resolve()
						: rm(directory, { recursive: true, force: true }).then(() => {
								directoryRemoved = true;
							}),
				]).then((results) => {
					if (results.some(({ status }) => status === "rejected")) {
						closePromise = null;
						throw new Error("Disposable registry cleanup failed");
					}
				});
				return closePromise;
			},
		});
	} catch (error) {
		await Promise.allSettled([
			server === undefined
				? Promise.resolve()
				: deadline(
						closeServer(server),
						SHUTDOWN_TIMEOUT_MS,
						"registry rollback",
					),
			rm(directory, { recursive: true, force: true }),
		]);
		throw Object.assign(new Error("Disposable registry startup failed"), {
			code: safeCode(error, "REGISTRY_START_FAILED"),
		});
	}
}

async function closeServer(server) {
	await new Promise((resolve, reject) => {
		server.close((error) =>
			error === undefined || error?.code === "ERR_SERVER_NOT_RUNNING"
				? resolve()
				: reject(error),
		);
		server.closeAllConnections?.();
	});
}

function deadline(promise, timeoutMs, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${label} exceeded its deadline`)),
			timeoutMs,
		);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function safeCode(error, fallback) {
	return typeof error?.code === "string" &&
		/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
		? error.code
		: fallback;
}
