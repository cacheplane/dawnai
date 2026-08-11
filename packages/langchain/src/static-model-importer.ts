/**
 * Fail-closed fallback for bundles whose generated entry installs a static
 * provider map before serving requests.
 */
export async function defaultModelImporter(specifier: string): Promise<never> {
  throw new Error(
    `Model provider package ${JSON.stringify(specifier)} was requested before the generated deployment entry installed its static provider importer. Do not construct models at module scope; construct them while handling a request after the provider map has been seeded.`,
  )
}
