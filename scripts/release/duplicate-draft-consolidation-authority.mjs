import { types as utilTypes } from "node:util"

export {
  assertFreshWriterAuthority,
  captureNpmInventory,
} from "./duplicate-draft-consolidation-authority-core.mjs"

export async function captureConsolidationAuthority(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    utilTypes.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  ) {
    throw new TypeError("authority capture input must be a plain non-proxy object")
  }
  const adapterDescriptor = Object.getOwnPropertyDescriptor(input, "adapters")
  if (
    adapterDescriptor === undefined ||
    !("value" in adapterDescriptor) ||
    adapterDescriptor.get !== undefined ||
    adapterDescriptor.set !== undefined
  ) {
    throw new TypeError("authority capture input adapters descriptor is unavailable")
  }
  const adapters = adapterDescriptor.value
  if (
    adapters === null ||
    typeof adapters !== "object" ||
    utilTypes.isProxy(adapters) ||
    !Object.isFrozen(adapters)
  ) {
    throw new TypeError("authority capture adapters are invalid")
  }
  const captureDescriptor = Object.getOwnPropertyDescriptor(
    adapters,
    "captureConsolidationAuthority",
  )
  if (
    captureDescriptor?.enumerable !== false ||
    captureDescriptor.writable !== false ||
    captureDescriptor.configurable !== false ||
    typeof captureDescriptor.value !== "function" ||
    utilTypes.isProxy(captureDescriptor.value)
  ) {
    throw new TypeError("safe authority capture entrypoint is unavailable")
  }
  return Reflect.apply(captureDescriptor.value, adapters, [input])
}
