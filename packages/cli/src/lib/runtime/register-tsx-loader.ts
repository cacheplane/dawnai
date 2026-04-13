let loaderPromise: Promise<void> | undefined
const TSX_API_MODULE = "tsx/esm/api"
const TSX_LOADER_NAMESPACE = "dawn-runtime-loader"

export async function registerTsxLoader(): Promise<void> {
  loaderPromise ??= (async () => {
    const tsxApi = (await import(TSX_API_MODULE)) as {
      readonly register?: (options?: { readonly namespace?: string }) => unknown
    }

    tsxApi.register?.({ namespace: TSX_LOADER_NAMESPACE })
  })()

  await loaderPromise
}
