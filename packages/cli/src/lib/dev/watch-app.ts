import { watch, type FSWatcher } from "node:fs"
import { join } from "node:path"

export interface AppWatcher {
  readonly close: () => void
}

export function watchApp(options: {
  readonly appRoot: string
  readonly onChange: (path: string) => void
}): AppWatcher {
  const watchers: FSWatcher[] = []
  const notify = (fileName: string | Buffer | null) => {
    const relativePath =
      typeof fileName === "string"
        ? fileName
        : fileName instanceof Buffer
          ? fileName.toString("utf8")
          : ""

    options.onChange(relativePath.length > 0 ? join(options.appRoot, relativePath) : options.appRoot)
  }

  watchers.push(
    watch(options.appRoot, { recursive: true }, (_eventType, fileName) => {
      notify(fileName)
    }),
  )

  const configPath = join(options.appRoot, "dawn.config.ts")
  watchers.push(
    watch(configPath, (_eventType, fileName) => {
      notify(fileName ?? "dawn.config.ts")
    }),
  )

  return {
    close: () => {
      for (const watcher of watchers) {
        watcher.close()
      }
    },
  }
}
