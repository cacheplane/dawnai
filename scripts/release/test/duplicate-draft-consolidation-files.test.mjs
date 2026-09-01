import assert from "node:assert/strict";
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	readPrivateEnvelope,
	readTrackedReceipt,
	writePrivateEnvelope,
	writeTrackedReceipt,
} from "../duplicate-draft-consolidation-files.mjs";

const MAXIMUM_BYTES = 1024 * 1024;
const MAXIMUM_WRITE_BYTES = 96 * 1024 * 1024;
const PRIVATE_MODE = 0o600;
const TRACKED_MODE = 0o644;

test("private envelopes round trip through exact mode 0600 without aliasing caller bytes", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, ".dawn", "proposal.json");
	await mkdir(path.dirname(target), { mode: 0o700 });
	const bytes = Buffer.from("private evidence\n");

	const writing = writePrivateEnvelope(target, bytes);
	bytes.fill(0x78);
	const written = await writing;

	assert.equal((await stat(target)).mode & 0o777, PRIVATE_MODE);
	assert.deepEqual(written, Buffer.from("private evidence\n"));
	const read = await readPrivateEnvelope(target, MAXIMUM_BYTES);
	assert.deepEqual(read, Buffer.from("private evidence\n"));
	read.fill(0x79);
	assert.deepEqual(await readFile(target), Buffer.from("private evidence\n"));
});

test("tracked receipts accept ordinary nonexecutable Git mode 0644", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "receipt.json");
	const bytes = Buffer.from("tracked receipt\n");

	await writeTrackedReceipt(target, bytes);

	assert.equal((await stat(target)).mode & 0o777, TRACKED_MODE);
	assert.deepEqual(await readTrackedReceipt(target, MAXIMUM_BYTES), bytes);
});

test("reads and replacements reject symlinked files and parent path components", async (t) => {
	const repository = await temporaryRepository(t);
	const outside = path.join(repository, "outside");
	const linkedParent = path.join(repository, "linked");
	await mkdir(outside);
	const outsideFile = path.join(outside, "evidence.json");
	await writeFile(outsideFile, "secret\n", { mode: PRIVATE_MODE });
	await symlink(outside, linkedParent, "dir");
	const linkedFile = path.join(linkedParent, "evidence.json");

	await assert.rejects(
		readPrivateEnvelope(linkedFile, MAXIMUM_BYTES),
		/symlink|unsafe/iu,
	);
	await assert.rejects(
		writePrivateEnvelope(linkedFile, Buffer.from("replacement\n")),
		/symlink|unsafe/iu,
	);

	const directLink = path.join(repository, "direct-link.json");
	await symlink(outsideFile, directLink);
	await assert.rejects(
		readPrivateEnvelope(directLink, MAXIMUM_BYTES),
		/regular|symlink/iu,
	);
	await assert.rejects(
		writePrivateEnvelope(directLink, Buffer.from("replacement\n")),
		/regular|symlink/iu,
	);
	assert.deepEqual(await readFile(outsideFile), Buffer.from("secret\n"));
});

test("reads reject non-regular files, hard links, and injected wrong ownership", async (t) => {
	const repository = await temporaryRepository(t);
	const directory = path.join(repository, "directory");
	await mkdir(directory);
	await assert.rejects(
		readPrivateEnvelope(directory, MAXIMUM_BYTES),
		/regular/iu,
	);

	const target = path.join(repository, "private.json");
	const alias = path.join(repository, "alias.json");
	await writeFile(target, "evidence\n", { mode: PRIVATE_MODE });
	await link(target, alias);
	await assert.rejects(readPrivateEnvelope(target, MAXIMUM_BYTES), /link/iu);
	await unlink(alias);

	await assert.rejects(
		readPrivateEnvelope(target, MAXIMUM_BYTES, {
			effectiveUserId: () => effectiveUserId() + 1,
		}),
		/owner/iu,
	);
});

test("private sources require exactly 0600 while tracked sources reject executable or writable modes", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "source.json");
	await writeFile(target, "evidence\n", { mode: 0o640 });
	await assert.rejects(
		readPrivateEnvelope(target, MAXIMUM_BYTES),
		/0600|mode/iu,
	);

	for (const mode of [0o744, 0o664, 0o646]) {
		await chmod(target, mode);
		await assert.rejects(
			readTrackedReceipt(target, MAXIMUM_BYTES),
			/executable|writable|mode/iu,
			mode.toString(8),
		);
	}

	await chmod(target, TRACKED_MODE);
	assert.deepEqual(
		await readTrackedReceipt(target, MAXIMUM_BYTES),
		Buffer.from("evidence\n"),
	);
});

test("private and tracked reads reject every special permission bit", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "special-mode.json");
	await writeFile(target, "evidence\n", { mode: PRIVATE_MODE });

	for (const specialBit of [0o4000, 0o2000, 0o1000]) {
		await chmod(target, PRIVATE_MODE | specialBit);
		assert.equal((await stat(target)).mode & 0o7777, PRIVATE_MODE | specialBit);
		await assert.rejects(
			readPrivateEnvelope(target, MAXIMUM_BYTES),
			/0600|special|mode/iu,
			`private ${specialBit.toString(8)}`,
		);

		await chmod(target, TRACKED_MODE | specialBit);
		assert.equal((await stat(target)).mode & 0o7777, TRACKED_MODE | specialBit);
		await assert.rejects(
			readTrackedReceipt(target, MAXIMUM_BYTES),
			/special|mode/iu,
			`tracked ${specialBit.toString(8)}`,
		);
	}
});

test("replacement refuses unsafe existing destinations before creating a temporary file", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "destination.json");
	const alias = path.join(repository, "destination-alias.json");
	const replacement = Buffer.from("replacement\n");

	await mkdir(target);
	await assert.rejects(writePrivateEnvelope(target, replacement), /regular/iu);
	await rm(target, { recursive: true });

	await writeFile(target, "previous\n", { mode: PRIVATE_MODE });
	await link(target, alias);
	await assert.rejects(writePrivateEnvelope(target, replacement), /link/iu);
	await unlink(alias);

	await chmod(target, 0o640);
	await assert.rejects(
		writePrivateEnvelope(target, replacement),
		/0600|mode/iu,
	);
	await chmod(target, PRIVATE_MODE);
	await assert.rejects(
		writePrivateEnvelope(target, replacement, {
			effectiveUserId: () => effectiveUserId() + 1,
		}),
		/owner/iu,
	);

	await chmod(target, 0o664);
	await assert.rejects(
		writeTrackedReceipt(target, replacement),
		/writable|mode/iu,
	);
	assert.deepEqual(await readFile(target), Buffer.from("previous\n"));
	assert.deepEqual(
		(await entries(repository)).filter((name) => name.endsWith(".tmp")),
		[],
	);
});

test("replacement refuses existing private and tracked destinations with special permission bits", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "destination.json");
	const replacement = Buffer.from("replacement\n");
	await writeFile(target, "previous\n", { mode: PRIVATE_MODE });

	for (const specialBit of [0o4000, 0o2000, 0o1000]) {
		await chmod(target, PRIVATE_MODE | specialBit);
		await assert.rejects(
			writePrivateEnvelope(target, replacement),
			/0600|special|mode/iu,
			`private ${specialBit.toString(8)}`,
		);

		await chmod(target, TRACKED_MODE | specialBit);
		await assert.rejects(
			writeTrackedReceipt(target, replacement),
			/special|mode/iu,
			`tracked ${specialBit.toString(8)}`,
		);
	}
	assert.deepEqual(await readFile(target), Buffer.from("previous\n"));
});

test("temporary-file validation rejects injected special permission bits before publication", async (t) => {
	const repository = await temporaryRepository(t);
	for (const [label, writeEnvelope, injectedMode] of [
		["private", writePrivateEnvelope, 0o4600],
		["tracked", writeTrackedReceipt, 0o4644],
	]) {
		const target = path.join(repository, `${label}.json`);
		const temporaryBefore = new Set(
			(await entries(repository)).filter((name) => name.endsWith(".tmp")),
		);
		let renames = 0;
		const fileSystem = fileSystemWith({
			async open(filePath, flags, mode) {
				const handle = await open(filePath, flags, mode);
				if (!filePath.endsWith(".tmp")) return handle;
				return wrapHandle(handle, {
					async stat(options) {
						return statusWithMode(await handle.stat(options), injectedMode);
					},
				});
			},
			async rename(from, to) {
				renames += 1;
				return rename(from, to);
			},
		});

		await assert.rejects(
			writeEnvelope(target, Buffer.from("replacement\n"), { fileSystem }),
			/retained/iu,
			label,
		);
		assert.equal(renames, 0, label);
		await assert.rejects(lstat(target), { code: "ENOENT" });
		const retained = (await entries(repository)).filter(
			(name) => name.endsWith(".tmp") && !temporaryBefore.has(name),
		);
		assert.equal(retained.length, 1, label);
		await rm(path.join(repository, retained[0]));
	}
	assert.deepEqual(
		(await entries(repository)).filter((name) => name.endsWith(".tmp")),
		[],
	);
});

test("read and write byte bounds fail before reading or publishing oversized input", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "oversized.json");
	await writeFile(target, Buffer.alloc(32, 0x61), { mode: PRIVATE_MODE });
	let descriptorReads = 0;
	const fileSystem = fileSystemWith({
		async open(filePath, flags, mode) {
			const handle = await open(filePath, flags, mode);
			if (filePath !== target) return handle;
			return wrapHandle(handle, {
				async read(...arguments_) {
					descriptorReads += 1;
					return handle.read(...arguments_);
				},
			});
		},
	});
	await assert.rejects(
		readPrivateEnvelope(target, 16, { fileSystem }),
		/bound|limit|large/iu,
	);
	assert.equal(descriptorReads, 0);

	const oversized = new Uint8Array(MAXIMUM_WRITE_BYTES + 1);
	await assert.rejects(
		writePrivateEnvelope(target, oversized),
		/bound|limit|large/iu,
	);
	assert.deepEqual(await readFile(target), Buffer.alloc(32, 0x61));
});

test("reads reject pathname replacement and same-size mutation while the descriptor is open", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "private.json");
	const displaced = path.join(repository, "displaced.json");
	const original = Buffer.alloc(128 * 1024, 0x61);
	await writeFile(target, original, { mode: PRIVATE_MODE });

	let replaced = false;
	const replacementFileSystem = fileSystemWith({
		async open(filePath, flags, mode) {
			const handle = await open(filePath, flags, mode);
			if (filePath !== target) return handle;
			return wrapHandle(handle, {
				async read(...arguments_) {
					const result = await handle.read(...arguments_);
					if (!replaced) {
						replaced = true;
						await rename(target, displaced);
						await writeFile(target, Buffer.alloc(original.length, 0x62), {
							mode: PRIVATE_MODE,
						});
					}
					return result;
				},
			});
		},
	});
	await assert.rejects(
		readPrivateEnvelope(target, original.length, {
			fileSystem: replacementFileSystem,
		}),
		/changed/iu,
	);

	await rm(target);
	await rename(displaced, target);
	let mutated = false;
	const mutationFileSystem = fileSystemWith({
		async open(filePath, flags, mode) {
			const handle = await open(filePath, flags, mode);
			if (filePath !== target) return handle;
			return wrapHandle(handle, {
				async read(...arguments_) {
					const result = await handle.read(...arguments_);
					if (!mutated) {
						mutated = true;
						await writeFile(target, Buffer.alloc(original.length, 0x63), {
							mode: PRIVATE_MODE,
						});
					}
					return result;
				},
			});
		},
	});
	await assert.rejects(
		readPrivateEnvelope(target, original.length, {
			fileSystem: mutationFileSystem,
		}),
		/changed/iu,
	);
});

test("reads revalidate the final pathname after consuming the descriptor", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "private.json");
	await writeFile(target, "evidence\n", { mode: PRIVATE_MODE });
	let targetLstats = 0;
	const fileSystem = fileSystemWith({
		async lstat(filePath, options) {
			if (filePath === target) {
				targetLstats += 1;
				throw new Error("final-path-revalidation");
			}
			return lstat(filePath, options);
		},
	});

	await assert.rejects(
		readPrivateEnvelope(target, MAXIMUM_BYTES, { fileSystem }),
		/final-path-revalidation/,
	);
	assert.equal(targetLstats, 1);
});

test("partial writes and every pre-rename failure preserve the destination and retain the temporary pathname", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "private.json");
	const previous = Buffer.from("previous complete evidence\n");
	await writeFile(target, previous, { mode: PRIVATE_MODE });

	for (const fault of ["partial-write", "file-sync", "rename"]) {
		const temporaryBefore = new Set(
			(await entries(repository)).filter((name) => name.endsWith(".tmp")),
		);
		const fileSystem = fileSystemWith({
			async open(filePath, flags, mode) {
				const handle = await open(filePath, flags, mode);
				if (!filePath.endsWith(".tmp")) return handle;
				if (fault === "partial-write") {
					let writes = 0;
					return wrapHandle(handle, {
						async write(...arguments_) {
							writes += 1;
							if (writes > 1) throw new Error("injected partial write failure");
							const [buffer, offset, length, position] = arguments_;
							return handle.write(
								buffer,
								offset,
								Math.min(3, length),
								position,
							);
						},
					});
				}
				if (fault === "file-sync") {
					return wrapHandle(handle, {
						async sync() {
							throw new Error("injected file sync failure");
						},
					});
				}
				return handle;
			},
			async rename(from, to) {
				if (fault === "rename" && to === target)
					throw new Error("injected rename failure");
				return rename(from, to);
			},
		});

		await assert.rejects(
			writePrivateEnvelope(target, Buffer.from(`replacement ${fault}\n`), {
				fileSystem,
			}),
			/retained/iu,
			fault,
		);
		assert.deepEqual(await readFile(target), previous, fault);
		const retained = (await entries(repository)).filter(
			(name) => name.endsWith(".tmp") && !temporaryBefore.has(name),
		);
		assert.equal(retained.length, 1, fault);
		await rm(path.join(repository, retained[0]));
	}
});

test("failure retention reports a replacement swapped after identity observation and never unlinks it", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "private.json");
	const identifier = "11111111-1111-4111-8111-111111111111";
	const temporary = path.join(
		repository,
		`.private.json.${process.pid}.${identifier}.tmp`,
	);
	const sibling = path.join(repository, "operation-owned-sibling.tmp");
	await writeFile(target, "previous\n", { mode: PRIVATE_MODE });
	let attacked = false;
	let writeFailed = false;
	let unlinkCalls = 0;
	const fileSystem = fileSystemWith({
		async lstat(filePath, options) {
			const status = await lstat(filePath, options);
			if (filePath === temporary && writeFailed && !attacked) {
				attacked = true;
				await rename(temporary, sibling);
				await writeFile(temporary, "attacker replacement\n", {
					mode: PRIVATE_MODE,
				});
			}
			return status;
		},
		async open(filePath, flags, mode) {
			const handle = await open(filePath, flags, mode);
			if (filePath !== temporary) return handle;
			return wrapHandle(handle, {
				async write(...arguments_) {
					await handle.write(...arguments_);
					writeFailed = true;
					throw new Error("injected post-attack write failure");
				},
			});
		},
		async unlink(filePath) {
			unlinkCalls += 1;
			return unlink(filePath);
		},
	});

	await assert.rejects(
		writePrivateEnvelope(target, Buffer.from("replacement\n"), {
			fileSystem,
			randomUUID: () => identifier,
		}),
		/no longer identifies|replacement.*untouched/iu,
	);
	assert.deepEqual(await readFile(target), Buffer.from("previous\n"));
	assert.deepEqual(
		await readFile(temporary),
		Buffer.from("attacker replacement\n"),
	);
	assert.equal((await lstat(sibling)).isFile(), true);
	assert.equal(unlinkCalls, 0);
});

test("failure retention reports when the operation-owned temporary inode is missing", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "private.json");
	const identifier = "22222222-2222-4222-8222-222222222222";
	const temporary = path.join(
		repository,
		`.private.json.${process.pid}.${identifier}.tmp`,
	);
	const displaced = path.join(repository, "displaced-operation-temp.tmp");
	let unlinkCalls = 0;
	const fileSystem = fileSystemWith({
		async open(filePath, flags, mode) {
			const handle = await open(filePath, flags, mode);
			if (filePath !== temporary) return handle;
			return wrapHandle(handle, {
				async write(...arguments_) {
					await handle.write(...arguments_);
					await rename(temporary, displaced);
					throw new Error("injected missing retained temp");
				},
			});
		},
		async unlink(filePath) {
			unlinkCalls += 1;
			return unlink(filePath);
		},
	});

	await assert.rejects(
		writePrivateEnvelope(target, Buffer.from("replacement\n"), {
			fileSystem,
			randomUUID: () => identifier,
		}),
		/no longer present/iu,
	);
	await assert.rejects(lstat(temporary), { code: "ENOENT" });
	assert.equal((await lstat(displaced)).isFile(), true);
	assert.equal(unlinkCalls, 0);
});

test("same-inode same-size mutation immediately after rename is reported as ambiguous publication", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "private.json");
	const intended = Buffer.from("AAAA\n");
	const changed = Buffer.from("BBBB\n");
	let inodeBeforeMutation;
	let inodeAfterMutation;
	const fileSystem = fileSystemWith({
		async rename(from, to) {
			await rename(from, to);
			inodeBeforeMutation = (await lstat(to)).ino;
			await writeFile(to, changed, { mode: PRIVATE_MODE });
			inodeAfterMutation = (await lstat(to)).ino;
		},
	});

	await assert.rejects(
		writePrivateEnvelope(target, intended, { fileSystem }),
		/ambiguous|publication|durability/iu,
	);
	assert.equal(inodeAfterMutation, inodeBeforeMutation);
	assert.deepEqual(await readFile(target), changed);
});

test("mutate-then-restore after rename is rejected or the restored intended bytes are re-fsynced before the parent", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "private.json");
	const intended = Buffer.from("AAAA\n");
	const events = [];
	const fileSystem = fileSystemWith({
		async open(filePath, flags, mode) {
			const handle = await open(filePath, flags, mode);
			if (filePath.endsWith(".tmp")) {
				return wrapHandle(handle, {
					async sync() {
						events.push("file-sync");
						return handle.sync();
					},
				});
			}
			if (filePath === repository) {
				return wrapHandle(handle, {
					async sync() {
						events.push("directory-sync");
						return handle.sync();
					},
				});
			}
			return handle;
		},
		async rename(from, to) {
			await rename(from, to);
			await writeFile(to, "BBBB\n", { mode: PRIVATE_MODE });
			await writeFile(to, intended, { mode: PRIVATE_MODE });
			events.push("restored");
		},
	});

	let rejected = false;
	try {
		await writePrivateEnvelope(target, intended, { fileSystem });
	} catch (error) {
		rejected = true;
		assert.match(String(error), /ambiguous|publication|durability/iu);
	}
	assert.deepEqual(await readFile(target), intended);
	if (!rejected) {
		assert.deepEqual(events, [
			"file-sync",
			"restored",
			"file-sync",
			"directory-sync",
		]);
	}
});

test("writes fsync the file before rename and the parent directory after rename", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "private.json");
	const events = [];
	const fileSystem = fileSystemWith({
		async open(filePath, flags, mode) {
			const handle = await open(filePath, flags, mode);
			if (filePath.endsWith(".tmp")) {
				return wrapHandle(handle, {
					async sync() {
						events.push("file-sync");
						return handle.sync();
					},
				});
			}
			if (filePath === repository) {
				return wrapHandle(handle, {
					async sync() {
						events.push("directory-sync");
						return handle.sync();
					},
				});
			}
			return handle;
		},
		async rename(from, to) {
			events.push("rename");
			return rename(from, to);
		},
	});

	await writePrivateEnvelope(target, Buffer.from("replacement\n"), {
		fileSystem,
	});

	assert.deepEqual(events, [
		"file-sync",
		"rename",
		"file-sync",
		"directory-sync",
	]);
});

test("a post-rename directory fsync failure reports ambiguous durability without rolling back", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "private.json");
	await writeFile(target, "previous\n", { mode: PRIVATE_MODE });
	const fileSystem = fileSystemWith({
		async open(filePath, flags, mode) {
			const handle = await open(filePath, flags, mode);
			if (filePath !== repository) return handle;
			return wrapHandle(handle, {
				async sync() {
					throw new Error("injected directory sync failure");
				},
			});
		},
	});

	await assert.rejects(
		writePrivateEnvelope(target, Buffer.from("replacement\n"), { fileSystem }),
		/ambiguous|durability/iu,
	);
	assert.deepEqual(await readFile(target), Buffer.from("replacement\n"));
});

test("dependency accessors are rejected without invocation", async (t) => {
	const repository = await temporaryRepository(t);
	const target = path.join(repository, "private.json");
	await writeFile(target, "evidence\n", { mode: PRIVATE_MODE });
	let invoked = false;
	const dependencies = {};
	Object.defineProperty(dependencies, "fileSystem", {
		enumerable: true,
		get() {
			invoked = true;
			return fileSystemWith();
		},
	});

	await assert.rejects(
		readPrivateEnvelope(target, MAXIMUM_BYTES, dependencies),
		/dependencies|unsafe/iu,
	);
	assert.equal(invoked, false);
});

function fileSystemWith(overrides = {}) {
	return {
		lstat,
		open,
		rename,
		unlink,
		...overrides,
	};
}

function wrapHandle(handle, overrides) {
	return {
		chmod: handle.chmod.bind(handle),
		close: handle.close.bind(handle),
		read: handle.read.bind(handle),
		stat: handle.stat.bind(handle),
		sync: handle.sync.bind(handle),
		write: handle.write.bind(handle),
		...overrides,
	};
}

function statusWithMode(status, mode) {
	const result = Object.create(Object.getPrototypeOf(status));
	Object.assign(result, status);
	result.mode = (status.mode & ~0o7777n) | BigInt(mode);
	return result;
}

async function temporaryRepository(t) {
	const temporary = await realpath(
		await mkdtemp(path.join(os.tmpdir(), "dawn-file-evidence-")),
	);
	t.after(() => rm(temporary, { recursive: true, force: true }));
	return temporary;
}

async function entries(directory) {
	return readdir(directory);
}

function effectiveUserId() {
	assert.equal(typeof process.geteuid, "function");
	return process.geteuid();
}
