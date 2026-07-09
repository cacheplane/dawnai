import { config } from "@dawn-ai/cli"
import { dockerSandbox, kubernetesSandbox } from "@dawn-ai/sandbox"

const provider =
  process.env.DAWN_SMOKE_SANDBOX === "docker"
    ? dockerSandbox({ image: "node:22-slim" })
    : kubernetesSandbox({ image: "node:22-slim", namespace: "dawn-sandboxes" })

export default config({
  appDir: "src/app",
  sandbox: {
    provider,
    network: { mode: "deny" },
  },
})
