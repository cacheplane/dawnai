/**
 * Guard SQL identifiers that are interpolated into DDL (Postgres cannot bind
 * them as `$1` placeholders). `prefix`/`schema` come from the store's own
 * config, not untrusted query input, but a malformed config must not produce
 * broken/injected DDL — so reject anything that isn't a plain identifier.
 */
export function assertIdentifier(name: string, value: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value))
    throw new Error(
      `postgres-storage: ${name} must be a valid SQL identifier (/^[a-z_][a-z0-9_]*$/i), got ${JSON.stringify(value)}`,
    )
}

/** Default table/index prefix. Two apps can share one database by varying it. */
export const DEFAULT_TABLE_PREFIX = "dawn"

/** Default Postgres schema the stores create their tables in. */
export const DEFAULT_SCHEMA = "public"
