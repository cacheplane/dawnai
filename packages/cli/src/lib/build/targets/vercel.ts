import type { BuildTarget } from "./index.js"

export const vercelTarget: BuildTarget = {
  name: "vercel",
  async emit() {
    throw new Error("vercel target output is not implemented")
  },
}
