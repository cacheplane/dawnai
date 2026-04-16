let loaderPromise: Promise<void> | undefined
const TSX_API_MODULE = "tsx/esm/api"

export async function registerTsxLoader(): Promise<void> {
  loaderPromise ??= (async () => {
    const { register } = (await import(TSX_API_MODULE)) as {
      readonly register: () => unknown
    }
    register()
  })()

  await loaderPromise
}
