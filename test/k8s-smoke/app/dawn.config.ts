import { config } from "@dawn-ai/cli"
import { dockerSandbox, kubernetesSandbox } from "@dawn-ai/sandbox"

const provider =
  process.env.DAWN_SMOKE_SANDBOX === "docker"
    ? dockerSandbox({
        image:
          "docker.io/library/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436",
      })
    : kubernetesSandbox({
        image:
          "docker.io/library/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436",
        namespace: "dawn-sandboxes",
      })

export default config({
  appDir: "src/app",
  sandbox: {
    provider,
    network: { mode: "deny" },
  },
})
