export const METADATA_ONLY_PATHS: readonly string[]

export interface GitCommandResult {
  readonly stdout: Buffer
}

export type GitCommandRunner = (file: string, args: readonly string[]) => Promise<GitCommandResult>

export interface MetadataOnlyScopeRequest {
  readonly event: unknown
  readonly base?: unknown
  readonly head?: unknown
}

export function classifyMetadataOnlyScope(
  request: MetadataOnlyScopeRequest,
  runCommand?: GitCommandRunner,
): Promise<boolean>
