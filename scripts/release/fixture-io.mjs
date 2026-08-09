import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"

const MAX_FIXTURE_BYTES = 4 * 1024 * 1024

export async function readBoundedFixture(file, { root, maxBytes = MAX_FIXTURE_BYTES } = {}) {
  try {
    const resolvedRoot = path.resolve(root)
    const resolvedFile = path.resolve(file)
    assertContained(resolvedRoot, resolvedFile)
    await assertNoSymlinkComponents(resolvedRoot, resolvedFile)
    const before = await lstat(resolvedFile)
    if (!before.isFile() || before.size > maxBytes) throw new Error("unsafe")
    const handle = await open(resolvedFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (
        !opened.isFile() ||
        opened.size > maxBytes ||
        before.dev !== opened.dev ||
        before.ino !== opened.ino
      ) {
        throw new Error("unsafe")
      }
      const canonicalRoot = await realpath(resolvedRoot)
      const canonicalFile = await realpath(resolvedFile)
      assertContained(canonicalRoot, canonicalFile)
      const bytes = Buffer.alloc(opened.size)
      let offset = 0
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (result.bytesRead === 0) break
        offset += result.bytesRead
      }
      if (offset !== opened.size) throw new Error("unsafe")
      const after = await handle.stat()
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
        throw new Error("unsafe")
      }
      return bytes.toString("utf8")
    } finally {
      await handle.close()
    }
  } catch {
    throw new TypeError("Invalid fixture file")
  }
}

function assertContained(root, file) {
  const relative = path.relative(root, file)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("unsafe")
}

async function assertNoSymlinkComponents(root, file) {
  const relative = path.relative(root, file)
  let current = root
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component)
    if ((await lstat(current)).isSymbolicLink()) throw new Error("unsafe")
  }
}
