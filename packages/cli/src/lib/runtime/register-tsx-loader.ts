let loaderPromise: Promise<void> | undefined
const TSX_ESM_MODULE = "tsx/esm"

export async function registerTsxLoader(): Promise<void> {
  loaderPromise ??= import(TSX_ESM_MODULE).then(() => undefined)
  await loaderPromise
}
