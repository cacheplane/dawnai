# Configurable Env Loading (Design)

**Status:** Approved for planning
**Date:** 2026-05-29
**Roadmap:** Standalone DX fix. Unblocks monorepo consumers of Dawn (e.g. an app nested under a workspace whose `.env` lives at the repo root).

## Problem

`dawn dev` loads `.env` from a single fixed location — the directory it runs in:

```ts
// packages/cli/src/lib/dev/dev-session.ts
const envLoaded = loadEnvFile(options.cwd)   // reads <cwd>/.env only
```

`loadEnvFile(dir)` (`packages/cli/src/lib/dev/load-env.ts`) reads `<dir>/.env`, sets only keys not already in `process.env` (shell wins), and auto-enables LangSmith tracing when `LANGSMITH_API_KEY` is present.

Separately, `dawn verify`'s dependency check (`packages/cli/src/lib/verify/check-dependencies.ts`) does its **own** ad-hoc read of `<appRoot>/.env` to decide whether recommended env vars are satisfied.

Two problems:

1. **No monorepo story.** When a Dawn app lives at `marketing/agent/` and the real `.env` lives at the repo root, `dawn dev` can't find it. Users resort to `dotenv-cli`, symlinks, or copying secrets — all friction, all error-prone.
2. **Two code paths disagree.** `dev` and `verify` each hardcode their own `.env` location. A future change to one silently diverges from the other.

## Prior art (why not just "walk up")

We researched how comparable tools resolve `.env`:

- **LangGraph CLI** (`langgraph.json`): an explicit `env` field naming the env file path. Declared, not discovered.
- **Vite:** loads from `envDir` (defaults to project root); resolved after config. No upward walk.
- **Next.js:** loads from the project root (cwd). No upward walk.
- **Nx:** *does* merge workspace-root + project-level `.env` — and it is a recurring source of confusion and conflict reports.
- **Turborepo:** refuses to auto-load `.env`; defers to `dotenv-cli` / Node `--env-file`.
- **Node 22:** `--env-file` is the emerging standard explicit mechanism.

The ecosystem leans **explicit-over-magic**. The one tool that does upward auto-merge (Nx) is the one generating the most surprises. So this design uses a **declared path + explicit override**, not discovery.

## Solution

A precedence chain for **local** env resolution (`dawn dev` + `dawn verify`):

```
--env-file <path>   (CLI flag, explicit override)
   ↓ falls back to
config.env          (new field in dawn.config.ts)
   ↓ falls back to
./.env              (current default — back-compat)
```

Shell-exported vars still win over file contents (preserve the existing "set only undefined keys" rule). The `LANGSMITH_API_KEY` → `LANGCHAIN_TRACING_V2` auto-enable is preserved. Paths resolve relative to the app root.

**The deploy artifact is unchanged.** `deployment-config.ts` keeps detecting `.env.example` → `.env` for the generated `langgraph.json` `env` field. `config.env` is **local-only** — it does not write through to the deploy artifact (a monorepo `../../.env` path is meaningless inside a deploy bundle and would point at secrets). This keeps deploy behavior exactly as-is.

## Design

### 1. `DawnConfig.env`

Add to `packages/core/src/types.ts`:

```ts
export interface DawnConfig {
  readonly appDir?: string
  readonly backends?: { /* unchanged */ }
  readonly permissions?: { /* unchanged */ }
  readonly checkpointer?: BaseCheckpointSaver
  readonly threadsStore?: ThreadsStore
  /**
   * Path to the env file loaded for local `dawn dev` / `dawn verify`,
   * relative to the app root. Defaults to "./.env". Does NOT affect the
   * deploy artifact (langgraph.json env is detected separately).
   */
  readonly env?: string
}
```

### 2. Shared resolver

New `resolveEnvPath` (e.g. `packages/cli/src/lib/dev/resolve-env-path.ts`):

```ts
export interface ResolveEnvPathOptions {
  readonly appRoot: string
  readonly flag?: string          // from --env-file
  readonly configEnv?: string     // from dawn.config.ts `env`
}

/** Returns the absolute path to load, applying precedence flag > config > "./.env". */
export function resolveEnvPath(opts: ResolveEnvPathOptions): {
  readonly absPath: string
  readonly source: "flag" | "config" | "default"
}
```

- `flag` set → resolve `flag` against `appRoot` (or accept absolute), `source: "flag"`.
- else `configEnv` set → resolve against `appRoot`, `source: "config"`.
- else → `<appRoot>/.env`, `source: "default"`.

### 3. Refactor `load-env.ts`

`loadEnvFile(dir)` → `loadEnvFiles(absPaths: readonly string[])` (array to keep the door open for a future repeatable flag, but v1 passes one path). Keep the existing line parser, quote-stripping, undefined-only assignment, and LangSmith auto-trace. Returns count loaded.

A thin back-compat wrapper `loadEnvFile(dir)` may remain (delegates to `loadEnvFiles([join(dir, ".env")])`) if any other caller depends on it; otherwise update callers.

### 4. Wire into `dev-session.ts`

```ts
const { absPath, source } = resolveEnvPath({
  appRoot: discoveredApp.appRoot,   // resolved after discovery, or options.cwd pre-discovery
  flag: options.envFile,
  configEnv: loadedConfig?.config.env,
});
const envLoaded = loadEnvFiles([absPath]);
if (envLoaded > 0) writeLine(io.stdout, `Loaded ${envLoaded} variable(s) from ${relativeToCwd(absPath)}`);
```

(Resolve ordering note: dawn config is loaded during app discovery; if env must be loaded *before* discovery, the resolver runs with `appRoot = options.cwd` for the flag/default and re-checks config.env once the config is loaded. The plan will pin the exact ordering against `startDevSession`.)

### 5. `--env-file` flag

Add to `dawn dev` and `dawn verify` arg parsing. Single path in v1. Behavior:

- Flagged file **must exist** → if missing, exit with a clear error (`--env-file <path>: file not found`). An explicit request that can't be honored is an error, not a silent skip.
- config / default file missing → silent no-op (today's behavior — many apps rely purely on shell env).

### 6. Unify `verify`

`check-dependencies.ts` replaces its ad-hoc `<appRoot>/.env` read with `resolveEnvPath(...)` + a read of the resolved path, so `verify` checks the same file `dev` would load. (It checks for var *names* present, same as today, just at the resolved path.)

### 7. Deploy untouched

No change to `deployment-config.ts` / `detectEnvFilePath`. A short doc note clarifies `config.env` is local-only.

## File structure

**Modified:**
- `packages/core/src/types.ts` — add `DawnConfig.env`
- `packages/cli/src/lib/dev/load-env.ts` — `loadEnvFile` → `loadEnvFiles`
- `packages/cli/src/lib/dev/dev-session.ts` — use resolver + `loadEnvFiles`; accept `envFile` option
- `packages/cli/src/lib/verify/check-dependencies.ts` — use the shared resolver
- `dawn dev` + `dawn verify` command definitions — add `--env-file` flag, thread it through

**New:**
- `packages/cli/src/lib/dev/resolve-env-path.ts` — `resolveEnvPath`
- `packages/cli/src/lib/dev/resolve-env-path.test.ts`
- `packages/cli/src/lib/dev/load-env.test.ts` (if not already covered)

## Testing

**Unit:**
- `resolveEnvPath`: flag wins over config wins over default; absolute flag passes through; relative resolves against appRoot; reports correct `source`.
- `loadEnvFiles`: undefined-only assignment (shell wins); quote-stripping; comment/blank skip; `LANGSMITH_API_KEY` auto-enables `LANGCHAIN_TRACING_V2`; missing file → 0; multiple paths load in order.
- `--env-file` missing file → error; config/default missing → silent 0.

**Integration:**
- `dawn dev` in a temp monorepo layout (`app/` with `dawn.config.ts` `env: "../.env"`, `.env` at parent) loads the parent file; a shell-exported var is not overridden.
- `dawn verify` resolves the same path and reports a var present there as satisfied.
- `--env-file ../custom.env` overrides `config.env`.

**Regression:** an app with a plain `<appRoot>/.env` and no config/flag behaves exactly as today.

## Out of scope

- Upward auto-discovery / merge (research: skip — surprising, bug-prone).
- Repeatable `--env-file` / multiple env files (the `loadEnvFiles` array leaves the door open; not wired in v1).
- `.env.local` / mode layering (`.env.development` etc.).
- Writing `config.env` into the deploy `langgraph.json`.
- Changing the deploy `env` detection.

## Risks

| # | Risk | Mitigation |
|--:|------|------------|
| 1 | Env must load before app discovery, but `config.env` comes from the discovered config | Resolve flag/default pre-discovery; re-resolve with `config.env` post-discovery and load then. Plan pins exact ordering against `startDevSession`. |
| 2 | Back-compat: a caller relies on `loadEnvFile(dir)` | Keep a thin `loadEnvFile` wrapper delegating to `loadEnvFiles`. |
| 3 | Users expect upward discovery (Nx muscle memory) | Doc the explicit model; `config.env: "../../.env"` is the one-line monorepo answer. |
