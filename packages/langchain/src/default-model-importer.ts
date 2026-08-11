/** Ordinary Node fallback for model packages selected at request time. */
export async function defaultModelImporter(specifier: string): Promise<Record<string, unknown>> {
  return (await import(specifier)) as Record<string, unknown>
}
