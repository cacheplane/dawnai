let loaderPromise: Promise<void> | undefined
const TSX_MODULE = "tsx"

export async function registerTsxLoader(): Promise<void> {
  loaderPromise ??= import(TSX_MODULE).then(() => undefined)

  await loaderPromise
}
