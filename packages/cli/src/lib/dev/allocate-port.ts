import { createServer } from "node:net"

/** Allocate a free localhost TCP port. Shared by dawn dev and dawn inspect. */
export async function allocateFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once("error", rejectPromise)
    server.unref()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        rejectPromise(new Error("Failed to allocate a TCP port"))
        return
      }
      server.close((error) => {
        if (error) {
          rejectPromise(error)
          return
        }
        resolvePromise(address.port)
      })
    })
  })
}
