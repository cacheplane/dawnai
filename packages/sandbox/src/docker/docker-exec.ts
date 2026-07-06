import type { BackendContext, ExecBackend } from "@dawn-ai/workspace"
import type { Docker } from "./docker-cli.ts"

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** ExecBackend that runs commands inside a docker container via `docker exec sh -c`. */
export function dockerExec(docker: Docker, container: string): ExecBackend {
  return {
    async runCommand(args, ctx: BackendContext) {
      const envPrefix = args.env
        ? Object.entries(args.env)
            .map(([k, v]) => {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
                throw new Error(
                  `Invalid environment variable name ${JSON.stringify(k)}: keys must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
                )
              }
              return `${k}=${shellQuote(v)} `
            })
            .join("")
        : ""
      const cdPrefix = args.cwd ? `cd ${shellQuote(args.cwd)} && ` : ""
      const r = await docker.exec(
        container,
        ["sh", "-c", `${envPrefix}${cdPrefix}${args.command}`],
        {
          signal: ctx.signal,
        },
      )
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
    },
  }
}
