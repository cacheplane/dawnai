import {
  type LocalRegistry,
  publishWorkspace,
  REGISTRY_URL_ENV,
  startLocalRegistry,
} from "./local-registry.ts"

let registry: LocalRegistry | undefined

// Vitest runs globalSetup once per lane process, before workers fork. Setting the
// env var here propagates to forked workers (vitest default pool). Workers read it
// via getTestRegistryUrl().
export async function setup(): Promise<void> {
  registry = await startLocalRegistry()
  try {
    await publishWorkspace(registry.url)
  } catch (err) {
    await registry.stop()
    registry = undefined
    throw err
  }
  process.env[REGISTRY_URL_ENV] = registry.url
}

export async function teardown(): Promise<void> {
  await registry?.stop()
  delete process.env[REGISTRY_URL_ENV]
}
