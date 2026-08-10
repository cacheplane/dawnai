import { constants as FS_CONSTANTS } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";

import { canonicalJsonBytes, EvidenceError } from "./github-evidence.mjs";

function fail(code) {
	throw new EvidenceError(code);
}

export async function readEvidenceInputBytes(
	file,
	{ contained, cwd, maxBytes = 1024 * 1024 },
) {
	if (
		typeof file !== "string" ||
		file.length === 0 ||
		file.includes("\0") ||
		Buffer.byteLength(file, "utf8") > 4096 ||
		typeof contained !== "boolean" ||
		typeof cwd !== "string" ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > 4 * 1024 * 1024
	) {
		fail("INVALID_RECONCILIATION_INPUT");
	}
	let handle;
	try {
		const requestedRoot = resolve(cwd);
		const requestedPath = resolve(cwd, file);
		let canonicalPath;
		if (contained) {
			assertContainedPath(requestedRoot, requestedPath);
			await assertNoSymlinkInputComponents(requestedRoot, requestedPath);
			const canonicalRoot = await realpath(requestedRoot);
			canonicalPath = await realpath(requestedPath);
			assertContainedPath(canonicalRoot, canonicalPath);
		} else {
			const canonicalParent = await realpath(dirname(requestedPath));
			canonicalPath = resolve(canonicalParent, basename(requestedPath));
		}
		const before = await lstat(canonicalPath);
		if (
			!before.isFile() ||
			before.isSymbolicLink() ||
			before.size < 1 ||
			before.size > maxBytes
		) {
			fail("INVALID_RECONCILIATION_INPUT");
		}
		handle = await open(
			canonicalPath,
			FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0),
		);
		const opened = await handle.stat();
		if (
			!opened.isFile() ||
			opened.size !== before.size ||
			opened.dev !== before.dev ||
			opened.ino !== before.ino
		) {
			fail("INVALID_RECONCILIATION_INPUT");
		}
		const bytes = Buffer.alloc(opened.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(
				bytes,
				offset,
				bytes.length - offset,
				offset,
			);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const after = await handle.stat();
		if (
			offset !== bytes.length ||
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			after.size !== opened.size ||
			after.mtimeMs !== opened.mtimeMs ||
			after.ctimeMs !== opened.ctimeMs
		) {
			fail("INVALID_RECONCILIATION_INPUT");
		}
		return bytes;
	} catch (error) {
		if (error instanceof EvidenceError) throw error;
		fail("INVALID_RECONCILIATION_INPUT");
	} finally {
		await handle?.close().catch(() => {});
	}
}

function assertContainedPath(root, file) {
	const pathFromRoot = relative(root, file);
	if (
		pathFromRoot === "" ||
		pathFromRoot.startsWith(`..${sep}`) ||
		isAbsolute(pathFromRoot)
	) {
		fail("INVALID_RECONCILIATION_INPUT");
	}
}

async function assertNoSymlinkInputComponents(root, file) {
	const components = relative(root, file).split(sep);
	let current = root;
	for (const component of components) {
		current = join(current, component);
		if ((await lstat(current)).isSymbolicLink())
			fail("INVALID_RECONCILIATION_INPUT");
	}
}

export async function writeCanonicalEvidenceFile(file, value, { cwd }) {
	if (
		typeof file !== "string" ||
		file.length === 0 ||
		file.includes("\0") ||
		Buffer.byteLength(file, "utf8") > 4096
	) {
		fail("INVALID_EVIDENCE_OUTPUT");
	}
	const requestedPath = resolve(cwd, file);
	const name = basename(requestedPath);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(name)) {
		fail("INVALID_EVIDENCE_OUTPUT");
	}
	const requestedParent = dirname(requestedPath);
	let parentStat;
	let parentPath;
	try {
		parentPath = await realpath(requestedParent);
		parentStat = await lstat(parentPath);
	} catch {
		fail("INVALID_EVIDENCE_OUTPUT");
	}
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
		fail("INVALID_EVIDENCE_OUTPUT");
	const output = resolve(parentPath, name);
	const bytes = canonicalJsonBytes(value);
	const flags =
		FS_CONSTANTS.O_WRONLY |
		FS_CONSTANTS.O_CREAT |
		FS_CONSTANTS.O_EXCL |
		(FS_CONSTANTS.O_NOFOLLOW ?? 0);
	let handle;
	try {
		handle = await open(output, flags, 0o600);
		await handle.writeFile(bytes);
		await handle.sync();
		const opened = await handle.stat();
		if (!opened.isFile() || opened.nlink !== 1) fail("INVALID_EVIDENCE_OUTPUT");
		await handle.close();
		handle = undefined;
		const closed = await lstat(output);
		if (
			!closed.isFile() ||
			closed.isSymbolicLink() ||
			closed.nlink !== 1 ||
			closed.dev !== opened.dev ||
			closed.ino !== opened.ino ||
			closed.size !== bytes.byteLength
		) {
			fail("INVALID_EVIDENCE_OUTPUT");
		}
	} catch (error) {
		if (error instanceof EvidenceError) throw error;
		fail("INVALID_EVIDENCE_OUTPUT");
	} finally {
		await handle?.close().catch(() => {});
	}
	return output;
}
