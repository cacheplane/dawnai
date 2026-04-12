import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

export interface CreateArtifactRootOptions {
  readonly baseDir?: string
  readonly lane?: string
  readonly runId: string
}

export async function createArtifactRoot(options: CreateArtifactRootOptions): Promise<string> {
  const artifactRoot = resolve(
    options.baseDir ?? process.cwd(),
    "artifacts",
    "testing",
    options.runId,
    options.lane ?? "",
  )

  await mkdir(artifactRoot, { recursive: true })

  return artifactRoot
}
