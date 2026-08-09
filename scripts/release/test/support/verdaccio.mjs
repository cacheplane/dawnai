import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runServer } from "verdaccio"

const LOOPBACK = "127.0.0.1"

export async function startVerdaccio() {
  const directory = await mkdtemp(join(tmpdir(), "dawn-release-verdaccio-"))
  const storage = join(directory, "storage")
  await mkdir(storage)
  const config = {
    configPath: join(directory, "config.yaml"),
    storage,
    uplinks: {},
    packages: {
      "@fault/*": { access: "$all", publish: "$anonymous", unpublish: "$anonymous" },
      "fault-gate": { access: "$all", publish: "$anonymous", unpublish: "$anonymous" },
      "**": { access: "$all", publish: "$anonymous", unpublish: "$anonymous" },
    },
    log: { type: "stdout", format: "pretty", level: "fatal" },
    max_body_size: "16mb",
  }
  let server
  try {
    const application = await runServer(config)
    server = await new Promise((resolve, reject) => {
      const listening = application.listen(0, LOOPBACK)
      listening.once("listening", () => resolve(listening))
      listening.once("error", reject)
    })
    const address = server.address()
    if (address === null || typeof address === "string" || address.address !== LOOPBACK) {
      throw new Error("Disposable registry did not bind to loopback")
    }
    const url = `http://${LOOPBACK}:${address.port}/`
    let closed = false
    return Object.freeze({
      url,
      directory,
      async close() {
        if (closed) return
        closed = true
        let closeFailed = false
        try {
          await closeServer(server)
        } catch {
          closeFailed = true
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
        if (closeFailed) throw new Error("Disposable registry cleanup failed")
      },
    })
  } catch (error) {
    if (server !== undefined) await closeServer(server)
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
    server.closeAllConnections?.()
  })
}
