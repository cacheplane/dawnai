import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const COMMAND_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const IDENTITY = Object.freeze({
	name: "Release Fault Fixture",
	email: "fault@example.invalid",
});
const FIRST_DATE = "2024-01-01T00:00:00Z";
const SECOND_DATE = "2024-01-02T00:00:00Z";

export async function createGitFixture({ sourceDirectory, signal }) {
	const cancellation = optionalAbortSignal(signal);
	cancellation?.throwIfAborted();
	if (typeof sourceDirectory !== "string" || !isAbsolute(sourceDirectory)) {
		throw new TypeError("Git fixture source must be an absolute path");
	}
	await readFile(join(sourceDirectory, "package.json"));
	const directory = await mkdtemp(join(tmpdir(), "dawn-release-git-"));
	const workingDirectory = join(directory, "working");
	const bareRemoteDirectory = join(directory, "remote.git");
	const homeDirectory = join(directory, "home");
	const configDirectory = join(directory, "xdg-config");
	const templateDirectory = join(directory, "empty-template");
	const tempDirectory = join(directory, "tmp");
	try {
		await Promise.all([
			mkdir(homeDirectory),
			mkdir(configDirectory),
			mkdir(templateDirectory),
			mkdir(tempDirectory),
		]);
		const environment = gitEnvironment({
			homeDirectory,
			configDirectory,
			templateDirectory,
			tempDirectory,
			signal: cancellation,
		});
		await cp(sourceDirectory, workingDirectory, {
			recursive: true,
			errorOnExist: true,
		});
		cancellation?.throwIfAborted();
		await git(
			directory,
			["init", "--object-format=sha1", "--bare", bareRemoteDirectory],
			environment,
		);
		await git(
			workingDirectory,
			["init", "--object-format=sha1", "-b", "main"],
			environment,
		);
		await git(
			workingDirectory,
			["config", "--local", "user.name", IDENTITY.name],
			environment,
		);
		await git(
			workingDirectory,
			["config", "--local", "user.email", IDENTITY.email],
			environment,
		);
		await git(workingDirectory, ["add", "--all"], environment);
		await git(
			workingDirectory,
			["commit", "-m", "fixture base"],
			environment,
			FIRST_DATE,
		);
		const oldCommitSha = await revParse(workingDirectory, "HEAD", environment);
		await git(
			workingDirectory,
			["tag", "-a", "v1.2.3", "-m", "fixture release 1.2.3", oldCommitSha],
			environment,
			FIRST_DATE,
		);
		await writeFile(
			join(workingDirectory, "REVISION"),
			"main advanced\n",
			"utf8",
		);
		await git(workingDirectory, ["add", "REVISION"], environment);
		await git(
			workingDirectory,
			["commit", "-m", "advance main"],
			environment,
			SECOND_DATE,
		);
		const mainCommitSha = await revParse(workingDirectory, "HEAD", environment);
		await git(
			workingDirectory,
			["remote", "add", "origin", bareRemoteDirectory],
			environment,
		);
		await git(
			workingDirectory,
			["push", "--set-upstream", "origin", "main"],
			environment,
		);
		await git(
			workingDirectory,
			["push", "origin", "refs/tags/v1.2.3"],
			environment,
		);
		cancellation?.throwIfAborted();
		let closePromise = null;
		return Object.freeze({
			directory,
			workingDirectory,
			bareRemoteDirectory,
			oldCommitSha,
			mainCommitSha,
			close() {
				if (closePromise !== null) return closePromise;
				closePromise = deadline(
					rm(directory, { recursive: true, force: true }),
					CLEANUP_TIMEOUT_MS,
					"Git fixture cleanup",
				).catch(() => {
					closePromise = null;
					throw new Error("Temporary Git fixture cleanup failed");
				});
				return closePromise;
			},
		});
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		if (cancellation?.aborted) throw cancellation.reason;
		throw error;
	}
}

async function revParse(directory, ref, environment) {
	return (
		await git(directory, ["rev-parse", "--verify", ref], environment)
	).trim();
}

function git(directory, args, environment, date) {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{
				cwd: directory,
				shell: false,
				timeout: COMMAND_TIMEOUT_MS,
				maxBuffer: MAX_OUTPUT_BYTES,
				encoding: "utf8",
				windowsHide: true,
				signal: environment.signal ?? undefined,
				env: {
					...environment.variables,
					...(date === undefined
						? {}
						: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
				},
			},
			(error, stdout) => {
				if (error !== null) {
					reject(
						Object.assign(new Error("Temporary Git fixture command failed"), {
							code: "GIT_FIXTURE_FAILED",
						}),
					);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

function gitEnvironment({
	homeDirectory,
	configDirectory,
	templateDirectory,
	tempDirectory,
	signal,
}) {
	return {
		signal,
		variables: {
			PATH: requiredPath(),
			HOME: homeDirectory,
			TMPDIR: tempDirectory,
			XDG_CONFIG_HOME: configDirectory,
			LANG: "C",
			LC_ALL: "C",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_COUNT: "0",
			GIT_TEMPLATE_DIR: templateDirectory,
			GIT_TERMINAL_PROMPT: "0",
		},
	};
}

function optionalAbortSignal(value) {
	if (value === undefined) return null;
	if (!(value instanceof AbortSignal)) {
		throw new TypeError("Git fixture signal is invalid");
	}
	return value;
}

function requiredPath() {
	const value = Reflect.get(process.env, "PATH");
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new TypeError("Git fixture requires a safe PATH");
	}
	return value;
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
