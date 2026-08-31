import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { runKubernetesCompatibilityMain } from "./kubernetes-compat/harness.js"

export * from "./kubernetes-compat/harness.js"

const entrypoint = process.argv[1]
if (
  entrypoint !== undefined &&
  pathToFileURL(__filename).href === pathToFileURL(resolve(entrypoint)).href
) {
  void runKubernetesCompatibilityMain().then((exitCode) => {
    process.exitCode = exitCode
  })
}
