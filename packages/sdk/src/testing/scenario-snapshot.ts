import { isPromise, isWeakMap, isWeakSet } from "node:util/types"

const SNAPSHOT_DATA = Symbol.for("dawn.scenario-readonly-snapshot-data.v1")
const DATE_MUTATORS = new Set<PropertyKey>([
  "setDate",
  "setFullYear",
  "setHours",
  "setMilliseconds",
  "setMinutes",
  "setMonth",
  "setSeconds",
  "setTime",
  "setUTCDate",
  "setUTCFullYear",
  "setUTCHours",
  "setUTCMilliseconds",
  "setUTCMinutes",
  "setUTCMonth",
  "setUTCSeconds",
  "setYear",
])

const MAP_MUTATORS = new Set<PropertyKey>(["clear", "delete", "set"])
const SET_MUTATORS = new Set<PropertyKey>(["add", "clear", "delete"])
const ARRAY_BUFFER_MUTATORS = new Set<PropertyKey>(["resize", "transfer", "transferToFixedLength"])
const SHARED_ARRAY_BUFFER_MUTATORS = new Set<PropertyKey>(["grow"])
const TYPED_ARRAY_MUTATORS = new Set<PropertyKey>(["copyWithin", "fill", "reverse", "set", "sort"])

const TYPED_ARRAY_CONSTRUCTORS = {
  BigInt64Array,
  BigUint64Array,
  Float32Array,
  Float64Array,
  Int16Array,
  Int32Array,
  Int8Array,
  Uint16Array,
  Uint32Array,
  Uint8Array,
  Uint8ClampedArray,
} as const
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object
const UNSUPPORTED_INTRINSIC_PROTOTYPES: readonly {
  readonly name: string
  readonly prototype: object
}[] = [
  { name: "Promise", prototype: Promise.prototype },
  { name: "WeakMap", prototype: WeakMap.prototype },
  { name: "WeakSet", prototype: WeakSet.prototype },
  ...(typeof WeakRef === "function" ? [{ name: "WeakRef", prototype: WeakRef.prototype }] : []),
  ...(typeof FinalizationRegistry === "function"
    ? [{ name: "FinalizationRegistry", prototype: FinalizationRegistry.prototype }]
    : []),
  ...(typeof URL === "function" ? [{ name: "URL", prototype: URL.prototype }] : []),
  ...(typeof URLSearchParams === "function"
    ? [{ name: "URLSearchParams", prototype: URLSearchParams.prototype }]
    : []),
]

type BinaryBuffer = ArrayBuffer | SharedArrayBuffer
type BinaryBufferKind = "ArrayBuffer" | "SharedArrayBuffer"
type SupportedTypedArray = InstanceType<
  (typeof TYPED_ARRAY_CONSTRUCTORS)[keyof typeof TYPED_ARRAY_CONSTRUCTORS]
>
type TypedArrayName = keyof typeof TYPED_ARRAY_CONSTRUCTORS

interface BinaryBufferSnapshotData {
  readonly bytes: Uint8Array
  readonly kind: BinaryBufferKind
  readonly maxByteLength: number
  readonly resizable: boolean
}

interface DataViewSnapshotData {
  readonly buffer: BinaryBuffer
  readonly byteLength: number
  readonly byteOffset: number
  readonly kind: "DataView"
}

interface TypedArraySnapshotData {
  readonly buffer: BinaryBuffer
  readonly byteOffset: number
  readonly kind: "TypedArray"
  readonly length: number
  readonly name: TypedArrayName
}

export function createScenarioSnapshotter(): (value: unknown) => unknown {
  const seen = new WeakMap<object, unknown>()
  const binaryBackings = new WeakMap<object, BinaryBuffer>()

  function snapshot(value: unknown): unknown {
    if (typeof value === "function") {
      throw new TypeError("Function snapshot values are not supported")
    }

    if (typeof value !== "object" || value === null) {
      return value
    }

    if (seen.has(value)) {
      return seen.get(value)
    }

    if (Array.isArray(value)) {
      const copy: unknown[] = []
      copy.length = value.length
      remember(value, copy)
      snapshotOwnProperties(value, copy, snapshot, (key) => key === "length")
      return Object.freeze(copy)
    }

    if (value instanceof Date) {
      const target = new Date(readDateTime(value))
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      const proxy = createReadOnlyDateSnapshot(target)
      remember(value, proxy)
      snapshotOwnProperties(value, target, snapshot)
      Object.freeze(target)
      return proxy
    }

    if (value instanceof Map) {
      const target = new Map<unknown, unknown>()
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      const proxy = createReadOnlyMapSnapshot(target)
      remember(value, proxy)

      for (const [key, item] of readMapEntries(value)) {
        Map.prototype.set.call(target, snapshot(key), snapshot(item))
      }

      snapshotOwnProperties(value, target, snapshot)
      Object.freeze(target)
      return proxy
    }

    if (value instanceof Set) {
      const target = new Set<unknown>()
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      const proxy = createReadOnlySetSnapshot(target)
      remember(value, proxy)

      for (const item of readSetValues(value)) {
        Set.prototype.add.call(target, snapshot(item))
      }

      snapshotOwnProperties(value, target, snapshot)
      Object.freeze(target)
      return proxy
    }

    if (value instanceof RegExp) {
      const state = readRegExpState(value)
      const target = new RegExp(state.source, state.flags)
      target.lastIndex = state.lastIndex
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      const proxy = createReadOnlyRegExpSnapshot(target)
      remember(value, proxy)
      snapshotOwnProperties(value, target, snapshot, (key) => key === "lastIndex")
      Object.freeze(target)
      return proxy
    }

    if (value instanceof ArrayBuffer) {
      return snapshotBinaryBuffer(value, "ArrayBuffer")
    }

    if (value instanceof SharedArrayBuffer) {
      return snapshotBinaryBuffer(value, "SharedArrayBuffer")
    }

    if (value instanceof DataView) {
      const state = readDataViewState(value)
      const buffer = snapshot(state.buffer)
      const cycleSnapshot = seen.get(value)

      if (cycleSnapshot) {
        return cycleSnapshot
      }

      const backing = isRecord(buffer) ? binaryBackings.get(buffer) : undefined

      if (!backing) {
        throw new TypeError("DataView snapshot buffer is malformed")
      }

      const target = new DataView(backing, state.byteOffset, state.byteLength)
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      const proxy = createReadOnlyDataViewSnapshot(target, buffer as BinaryBuffer)
      remember(value, proxy)
      snapshotOwnProperties(value, target, snapshot)
      Object.freeze(target)
      return proxy
    }

    const typedArrayName = getTypedArrayName(value)

    if (typedArrayName) {
      const typedArray = value as SupportedTypedArray
      const state = readTypedArrayState(typedArray, typedArrayName)
      const buffer = snapshot(state.buffer)
      const cycleSnapshot = seen.get(typedArray)

      if (cycleSnapshot) {
        return cycleSnapshot
      }

      const backing = isRecord(buffer) ? binaryBackings.get(buffer) : undefined

      if (!backing) {
        throw new TypeError(`${typedArrayName} snapshot buffer is malformed`)
      }

      const target = createTypedArrayTarget(typedArrayName, backing, state.byteOffset, state.length)
      Object.setPrototypeOf(target, Object.getPrototypeOf(typedArray))
      const proxy = createReadOnlyTypedArraySnapshot(target, typedArrayName, buffer as BinaryBuffer)
      remember(typedArray, proxy)
      snapshotOwnProperties(typedArray, target, snapshot, isTypedArrayElementKey)
      Object.preventExtensions(target)
      return proxy
    }

    if (value instanceof Number) {
      return snapshotBoxedPrimitive(
        value,
        new Number(Number.prototype.valueOf.call(value)),
        snapshot,
      )
    }

    if (value instanceof String) {
      return snapshotBoxedPrimitive(
        value,
        new String(String.prototype.valueOf.call(value)),
        snapshot,
        (key) => key === "length" || isCanonicalArrayIndex(key),
      )
    }

    if (value instanceof Boolean) {
      return snapshotBoxedPrimitive(
        value,
        new Boolean(Boolean.prototype.valueOf.call(value)),
        snapshot,
      )
    }

    const boxedBigInt = readBoxedBigInt(value)

    if (boxedBigInt !== undefined) {
      return snapshotBoxedPrimitive(value, Object(boxedBigInt), snapshot)
    }

    if (typeof File !== "undefined" && value instanceof File) {
      const name = readBuiltInAccessor(File.prototype, "name", value)
      const lastModified = readBuiltInAccessor(File.prototype, "lastModified", value)
      const type = readBuiltInAccessor(Blob.prototype, "type", value)

      if (
        typeof name !== "string" ||
        typeof lastModified !== "number" ||
        typeof type !== "string"
      ) {
        throw new TypeError("File state is malformed")
      }

      const target = new File([value], name, {
        lastModified,
        type,
      })
      const intrinsicKeys = new Set<PropertyKey>(Reflect.ownKeys(target))
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      remember(value, target)
      snapshotOwnProperties(value, target, snapshot, (key) => intrinsicKeys.has(key))
      recursivelyFreezeOwnData(target)
      return target
    }

    if (typeof Blob !== "undefined" && value instanceof Blob) {
      const size = readBuiltInAccessor(Blob.prototype, "size", value)
      const type = readBuiltInAccessor(Blob.prototype, "type", value)

      if (typeof size !== "number" || typeof type !== "string") {
        throw new TypeError("Blob state is malformed")
      }

      const target = Blob.prototype.slice.call(value, 0, size, type) as Blob
      const intrinsicKeys = new Set<PropertyKey>(Reflect.ownKeys(target))
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      remember(value, target)
      snapshotOwnProperties(value, target, snapshot, (key) => intrinsicKeys.has(key))
      recursivelyFreezeOwnData(target)
      return target
    }

    if (typeof DOMException !== "undefined" && value instanceof DOMException) {
      const message = readBuiltInAccessor(DOMException.prototype, "message", value)
      const name = readBuiltInAccessor(DOMException.prototype, "name", value)

      if (typeof message !== "string" || typeof name !== "string") {
        throw new TypeError("DOMException state is malformed")
      }

      const target = new DOMException(message, name)
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      remember(value, target)
      snapshotOwnProperties(value, target, snapshot, (key) => key === "stack")
      materializeStack(value, target, snapshot)
      return Object.freeze(target)
    }

    if (value instanceof Error) {
      const target = new Error()
      Object.setPrototypeOf(target, Object.getPrototypeOf(value))
      remember(value, target)
      snapshotOwnProperties(value, target, snapshot, (key) => key === "stack")
      materializeStack(value, target, snapshot)
      return Object.freeze(target)
    }

    const unsupportedType = readUnsupportedIntrinsicType(value)

    if (unsupportedType) {
      throw new TypeError(`${unsupportedType} snapshot values are not supported`)
    }

    const tag = readObjectTagWithoutAccessors(value)

    if (tag !== "[object Object]") {
      throw new TypeError(`${readSnapshotTypeName(tag)} snapshot values are not supported`)
    }

    const copy = Object.create(Object.getPrototypeOf(value)) as object
    remember(value, copy)
    snapshotOwnProperties(value, copy, snapshot)
    return Object.freeze(copy)
  }

  function snapshotBinaryBuffer(source: BinaryBuffer, kind: BinaryBufferKind): BinaryBuffer {
    const data = readBinaryBufferState(source, kind)
    const target = createBinaryBufferTarget(data)
    Object.setPrototypeOf(target, Object.getPrototypeOf(source))
    const proxy = createReadOnlyBinaryBufferSnapshot(target, kind)
    remember(source, proxy)
    binaryBackings.set(proxy, target)
    snapshotOwnProperties(source, target, snapshot)
    Object.freeze(target)
    return proxy
  }

  function snapshotBoxedPrimitive(
    source: object,
    target: object,
    snapshotValue: (value: unknown) => unknown,
    skip?: (key: PropertyKey) => boolean,
  ): object {
    Object.setPrototypeOf(target, Object.getPrototypeOf(source))
    remember(source, target)
    snapshotOwnProperties(source, target, snapshotValue, skip)
    return Object.freeze(target)
  }

  function remember(original: object, copy: object): void {
    seen.set(original, copy)
  }

  return snapshot
}

function createReadOnlyDateSnapshot(target: Date): Date {
  return new Proxy(target, {
    get(date, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return Object.freeze({ kind: "Date", time: Date.prototype.getTime.call(date) })
      }

      if (DATE_MUTATORS.has(property)) {
        return rejectSnapshotMutation
      }

      const result = Reflect.get(date, property, receiver)
      const descriptor = Object.getOwnPropertyDescriptor(Date.prototype, property)

      if (
        typeof result === "function" &&
        property !== "constructor" &&
        descriptor &&
        "value" in descriptor &&
        result === descriptor.value
      ) {
        return result.bind(date)
      }

      return result
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
}

function createReadOnlyMapSnapshot(target: Map<unknown, unknown>): Map<unknown, unknown> {
  let proxy: Map<unknown, unknown>
  proxy = new Proxy(target, {
    get(map, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return createMapSnapshotData(map)
      }

      if (MAP_MUTATORS.has(property)) {
        return rejectSnapshotMutation
      }

      if (property === "size") {
        return Reflect.get(map, property, map)
      }

      if (property === "forEach") {
        return (
          callback: (value: unknown, key: unknown, map: Map<unknown, unknown>) => void,
          thisArg?: unknown,
        ): void => {
          Map.prototype.forEach.call(map, (value, key) => {
            callback.call(thisArg, value, key, proxy)
          })
        }
      }

      const result = Reflect.get(map, property, receiver)
      const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, property)

      if (
        typeof result === "function" &&
        property !== "constructor" &&
        descriptor &&
        "value" in descriptor &&
        result === descriptor.value
      ) {
        return result.bind(map)
      }

      return result
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
  return proxy
}

function createReadOnlySetSnapshot(target: Set<unknown>): Set<unknown> {
  let proxy: Set<unknown>
  proxy = new Proxy(target, {
    get(set, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return createSetSnapshotData(set)
      }

      if (SET_MUTATORS.has(property)) {
        return rejectSnapshotMutation
      }

      if (property === "size") {
        return Reflect.get(set, property, set)
      }

      if (property === "forEach") {
        return (
          callback: (value: unknown, key: unknown, set: Set<unknown>) => void,
          thisArg?: unknown,
        ): void => {
          Set.prototype.forEach.call(set, (value) => {
            callback.call(thisArg, value, value, proxy)
          })
        }
      }

      const result = Reflect.get(set, property, receiver)
      const descriptor = Object.getOwnPropertyDescriptor(Set.prototype, property)

      if (
        typeof result === "function" &&
        property !== "constructor" &&
        descriptor &&
        "value" in descriptor &&
        result === descriptor.value
      ) {
        return result.bind(set)
      }

      return result
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
  return proxy
}

function createReadOnlyRegExpSnapshot(target: RegExp): RegExp {
  return new Proxy(target, {
    get(regexp, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return createRegExpSnapshotData(regexp)
      }

      if (property === "compile") {
        return rejectSnapshotMutation
      }

      const result = readProxyProperty(regexp, property, receiver)

      if (typeof result !== "function" || property === "constructor") {
        return result
      }

      return (...args: unknown[]): unknown => {
        const working = new RegExp(regexp.source, regexp.flags)
        working.lastIndex = regexp.lastIndex
        Object.setPrototypeOf(working, Object.getPrototypeOf(regexp))
        return Reflect.apply(result, working, args)
      }
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
}

function createReadOnlyBinaryBufferSnapshot(
  target: BinaryBuffer,
  kind: BinaryBufferKind,
): BinaryBuffer {
  const prototype = kind === "ArrayBuffer" ? ArrayBuffer.prototype : SharedArrayBuffer.prototype
  const mutators = kind === "ArrayBuffer" ? ARRAY_BUFFER_MUTATORS : SHARED_ARRAY_BUFFER_MUTATORS

  return new Proxy(target, {
    get(buffer, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return Object.freeze(readBinaryBufferState(buffer, kind))
      }

      if (mutators.has(property)) {
        return rejectSnapshotMutation
      }

      const descriptor = Object.getOwnPropertyDescriptor(prototype, property)

      if (descriptor?.get) {
        return Reflect.apply(descriptor.get, buffer, [])
      }

      const result = Reflect.get(buffer, property, receiver)

      if (
        typeof result === "function" &&
        property !== "constructor" &&
        descriptor &&
        "value" in descriptor &&
        result === descriptor.value
      ) {
        return result.bind(buffer)
      }

      return result
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
}

function createReadOnlyDataViewSnapshot(target: DataView, buffer: BinaryBuffer): DataView {
  return new Proxy(target, {
    get(view, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return Object.freeze({
          buffer,
          byteLength: view.byteLength,
          byteOffset: view.byteOffset,
          kind: "DataView",
        } satisfies DataViewSnapshotData)
      }

      if (property === "buffer") {
        return buffer
      }

      if (typeof property === "string" && property.startsWith("set")) {
        return rejectSnapshotMutation
      }

      const descriptor = Object.getOwnPropertyDescriptor(DataView.prototype, property)

      if (descriptor?.get) {
        return Reflect.apply(descriptor.get, view, [])
      }

      const result = Reflect.get(view, property, receiver)

      if (
        typeof result === "function" &&
        property !== "constructor" &&
        descriptor &&
        "value" in descriptor &&
        result === descriptor.value
      ) {
        return result.bind(view)
      }

      return result
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
}

function createReadOnlyTypedArraySnapshot(
  target: SupportedTypedArray,
  name: TypedArrayName,
  buffer: BinaryBuffer,
): SupportedTypedArray {
  return new Proxy(target, {
    get(typedArray, property, receiver) {
      if (property === SNAPSHOT_DATA) {
        return Object.freeze({
          buffer,
          byteOffset: readTypedArrayNumber(typedArray, "byteOffset"),
          kind: "TypedArray",
          length: readTypedArrayNumber(typedArray, "length"),
          name,
        } satisfies TypedArraySnapshotData)
      }

      if (property === "buffer") {
        return buffer
      }

      if (TYPED_ARRAY_MUTATORS.has(property)) {
        return rejectSnapshotMutation
      }

      const result = readProxyProperty(typedArray, property, receiver)

      if (typeof result !== "function" || property === "constructor") {
        return result
      }

      return (...args: unknown[]): unknown => {
        const working = cloneTypedArrayTarget(typedArray, name)
        const method = Reflect.get(working, property, working)

        if (typeof method !== "function") {
          throw new TypeError(`${String(property)} is not callable on ${name}`)
        }

        return Reflect.apply(method, working, args)
      }
    },
    defineProperty: rejectSnapshotMutation,
    deleteProperty: rejectSnapshotMutation,
    set: rejectSnapshotMutation,
    setPrototypeOf: rejectSnapshotMutation,
  })
}

function readDateTime(source: Date): number {
  try {
    return Date.prototype.getTime.call(source)
  } catch {
    const data = readSnapshotData(source, "Date")

    if (typeof data.time !== "number") {
      throw new TypeError("Date snapshot data is malformed")
    }

    return data.time
  }
}

function readMapEntries(source: Map<unknown, unknown>): readonly (readonly [unknown, unknown])[] {
  try {
    const entries: (readonly [unknown, unknown])[] = []

    for (const [key, value] of Map.prototype.entries.call(source)) {
      entries.push([key, value])
    }

    return entries
  } catch {
    const data = readSnapshotData(source, "Map")
    const entries = assertDenseArray(data.entries, "Map snapshot entries")
    const parsed: (readonly [unknown, unknown])[] = []

    for (let index = 0; index < entries.length; index += 1) {
      const pair = assertDenseArray(entries[index], `Map snapshot entry at index ${index}`)

      if (pair.length !== 2) {
        throw new TypeError(`Map snapshot entry at index ${index} must contain two values`)
      }

      parsed.push([pair[0], pair[1]])
    }

    return parsed
  }
}

function readSetValues(source: Set<unknown>): readonly unknown[] {
  try {
    const values: unknown[] = []

    for (const value of Set.prototype.values.call(source)) {
      values.push(value)
    }

    return values
  } catch {
    const data = readSnapshotData(source, "Set")
    const values = assertDenseArray(data.values, "Set snapshot values")
    const parsed: unknown[] = []

    for (let index = 0; index < values.length; index += 1) {
      parsed.push(values[index])
    }

    return parsed
  }
}

function readRegExpState(source: RegExp): {
  readonly flags: string
  readonly lastIndex: number
  readonly source: string
} {
  try {
    const pattern = readBuiltInAccessor(RegExp.prototype, "source", source)
    const flags = readBuiltInAccessor(RegExp.prototype, "flags", source)

    if (typeof pattern !== "string" || typeof flags !== "string") {
      throw new TypeError("RegExp state is malformed")
    }

    return { flags, lastIndex: source.lastIndex, source: pattern }
  } catch {
    const data = readSnapshotData(source, "RegExp")

    if (
      typeof data.source !== "string" ||
      typeof data.flags !== "string" ||
      typeof data.lastIndex !== "number"
    ) {
      throw new TypeError("RegExp snapshot data is malformed")
    }

    return { flags: data.flags, lastIndex: data.lastIndex, source: data.source }
  }
}

function readBinaryBufferState(
  source: BinaryBuffer,
  kind: BinaryBufferKind,
): BinaryBufferSnapshotData {
  try {
    const prototype = kind === "ArrayBuffer" ? ArrayBuffer.prototype : SharedArrayBuffer.prototype
    const byteLength = readBuiltInAccessor(prototype, "byteLength", source)
    const maxByteLength = readBuiltInAccessor(prototype, "maxByteLength", source)
    const resizable = readBuiltInAccessor(
      prototype,
      kind === "ArrayBuffer" ? "resizable" : "growable",
      source,
    )

    if (
      typeof byteLength !== "number" ||
      typeof maxByteLength !== "number" ||
      typeof resizable !== "boolean"
    ) {
      throw new TypeError(`${kind} state is malformed`)
    }

    const bytes = new Uint8Array(byteLength)
    bytes.set(new Uint8Array(source))
    return { bytes, kind, maxByteLength, resizable }
  } catch {
    return parseBinaryBufferSnapshotData(readSnapshotData(source, kind), kind)
  }
}

function parseBinaryBufferSnapshotData(
  data: Record<PropertyKey, unknown>,
  kind: BinaryBufferKind,
): BinaryBufferSnapshotData {
  if (
    !(data.bytes instanceof Uint8Array) ||
    typeof data.maxByteLength !== "number" ||
    !Number.isSafeInteger(data.maxByteLength) ||
    data.maxByteLength < data.bytes.byteLength ||
    typeof data.resizable !== "boolean"
  ) {
    throw new TypeError(`${kind} snapshot data is malformed`)
  }

  let bytes: Uint8Array

  try {
    bytes = Uint8Array.prototype.slice.call(data.bytes) as Uint8Array
  } catch {
    throw new TypeError(`${kind} snapshot bytes are malformed`)
  }

  return {
    bytes,
    kind,
    maxByteLength: data.maxByteLength,
    resizable: data.resizable,
  }
}

function createBinaryBufferTarget(data: BinaryBufferSnapshotData): BinaryBuffer {
  const BufferConstructor = data.kind === "ArrayBuffer" ? ArrayBuffer : SharedArrayBuffer
  const args = data.resizable
    ? [data.bytes.byteLength, { maxByteLength: data.maxByteLength }]
    : [data.bytes.byteLength]
  const target = Reflect.construct(BufferConstructor, args) as BinaryBuffer
  new Uint8Array(target).set(data.bytes)
  return target
}

function readDataViewState(source: DataView): DataViewSnapshotData {
  try {
    const buffer = readBuiltInAccessor(DataView.prototype, "buffer", source)
    const byteLength = readBuiltInAccessor(DataView.prototype, "byteLength", source)
    const byteOffset = readBuiltInAccessor(DataView.prototype, "byteOffset", source)

    if (
      !(buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer) ||
      typeof byteLength !== "number" ||
      typeof byteOffset !== "number"
    ) {
      throw new TypeError("DataView state is malformed")
    }

    return { buffer, byteLength, byteOffset, kind: "DataView" }
  } catch {
    const data = readSnapshotData(source, "DataView")

    if (
      !(data.buffer instanceof ArrayBuffer || data.buffer instanceof SharedArrayBuffer) ||
      typeof data.byteLength !== "number" ||
      !Number.isSafeInteger(data.byteLength) ||
      data.byteLength < 0 ||
      typeof data.byteOffset !== "number" ||
      !Number.isSafeInteger(data.byteOffset) ||
      data.byteOffset < 0
    ) {
      throw new TypeError("DataView snapshot data is malformed")
    }

    return {
      buffer: data.buffer,
      byteLength: data.byteLength,
      byteOffset: data.byteOffset,
      kind: "DataView",
    }
  }
}

function getTypedArrayName(value: object): TypedArrayName | undefined {
  for (const name of Object.keys(TYPED_ARRAY_CONSTRUCTORS) as TypedArrayName[]) {
    if (value instanceof TYPED_ARRAY_CONSTRUCTORS[name]) {
      return name
    }
  }

  return undefined
}

function readTypedArrayState(
  source: SupportedTypedArray,
  name: TypedArrayName,
): TypedArraySnapshotData {
  try {
    const buffer = readBuiltInAccessor(TYPED_ARRAY_PROTOTYPE, "buffer", source)
    const byteOffset = readBuiltInAccessor(TYPED_ARRAY_PROTOTYPE, "byteOffset", source)
    const length = readBuiltInAccessor(TYPED_ARRAY_PROTOTYPE, "length", source)

    if (
      !(buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer) ||
      typeof byteOffset !== "number" ||
      typeof length !== "number"
    ) {
      throw new TypeError(`${name} state is malformed`)
    }

    return { buffer, byteOffset, kind: "TypedArray", length, name }
  } catch {
    const data = readSnapshotData(source, "TypedArray")

    if (
      data.name !== name ||
      !(data.buffer instanceof ArrayBuffer || data.buffer instanceof SharedArrayBuffer) ||
      typeof data.byteOffset !== "number" ||
      !Number.isSafeInteger(data.byteOffset) ||
      data.byteOffset < 0 ||
      typeof data.length !== "number" ||
      !Number.isSafeInteger(data.length) ||
      data.length < 0
    ) {
      throw new TypeError(`${name} snapshot data is malformed`)
    }

    return {
      buffer: data.buffer,
      byteOffset: data.byteOffset,
      kind: "TypedArray",
      length: data.length,
      name,
    }
  }
}

function createTypedArrayTarget(
  name: TypedArrayName,
  buffer: BinaryBuffer,
  byteOffset: number,
  length: number,
): SupportedTypedArray {
  const Constructor = TYPED_ARRAY_CONSTRUCTORS[name] as unknown as new (
    buffer: BinaryBuffer,
    byteOffset?: number,
    length?: number,
  ) => SupportedTypedArray
  return new Constructor(buffer, byteOffset, length)
}

function cloneTypedArrayTarget(
  source: SupportedTypedArray,
  name: TypedArrayName,
): SupportedTypedArray {
  const state = readTypedArrayState(source, name)
  const buffer = createBinaryBufferTarget(
    readBinaryBufferState(state.buffer, getBufferKind(state.buffer)),
  )
  const target = createTypedArrayTarget(name, buffer, state.byteOffset, state.length)
  Object.setPrototypeOf(target, Object.getPrototypeOf(source))
  return target
}

function readTypedArrayNumber(
  source: SupportedTypedArray,
  property: "byteOffset" | "length",
): number {
  const value = readBuiltInAccessor(TYPED_ARRAY_PROTOTYPE, property, source)

  if (typeof value !== "number") {
    throw new TypeError(`Typed array ${property} is malformed`)
  }

  return value
}

function getBufferKind(value: BinaryBuffer): BinaryBufferKind {
  return value instanceof ArrayBuffer ? "ArrayBuffer" : "SharedArrayBuffer"
}

function readBuiltInAccessor(prototype: object, property: PropertyKey, receiver: object): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, property)

  if (!descriptor?.get) {
    throw new TypeError(`${String(property)} accessor is unavailable`)
  }

  return Reflect.apply(descriptor.get, receiver, [])
}

function readProxyProperty(target: object, property: PropertyKey, receiver: object): unknown {
  try {
    return Reflect.get(target, property, receiver)
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error
    }

    return Reflect.get(target, property, target)
  }
}

function readSnapshotData(value: object, kind: string): Record<PropertyKey, unknown> {
  const data = Reflect.get(value, SNAPSHOT_DATA)

  if (!isRecord(data) || data.kind !== kind) {
    throw new TypeError(`${kind} snapshot data is malformed`)
  }

  return data
}

function createMapSnapshotData(target: Map<unknown, unknown>): Readonly<Record<string, unknown>> {
  const entries: (readonly [unknown, unknown])[] = []

  for (const [key, value] of Map.prototype.entries.call(target)) {
    entries.push(Object.freeze([key, value]))
  }

  return Object.freeze({ entries: Object.freeze(entries), kind: "Map" })
}

function createSetSnapshotData(target: Set<unknown>): Readonly<Record<string, unknown>> {
  const values: unknown[] = []

  for (const value of Set.prototype.values.call(target)) {
    values.push(value)
  }

  return Object.freeze({ kind: "Set", values: Object.freeze(values) })
}

function createRegExpSnapshotData(target: RegExp): Readonly<Record<string, unknown>> {
  return Object.freeze({
    flags: target.flags,
    kind: "RegExp",
    lastIndex: target.lastIndex,
    source: target.source,
  })
}

function isCanonicalArrayIndex(key: PropertyKey): boolean {
  if (typeof key !== "string" || key.length === 0) {
    return false
  }

  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key
}

function isTypedArrayElementKey(key: PropertyKey): boolean {
  return isCanonicalArrayIndex(key)
}

function readSnapshotTypeName(tag: string): string {
  return tag.startsWith("[object ") && tag.endsWith("]") ? tag.slice(8, -1) : tag
}

function readBoxedBigInt(value: object): bigint | undefined {
  try {
    return Reflect.apply(BigInt.prototype.valueOf, value, []) as bigint
  } catch {
    return undefined
  }
}

function readUnsupportedIntrinsicType(value: object): string | undefined {
  if (isPromise(value)) {
    return "Promise"
  }

  if (isWeakMap(value)) {
    return "WeakMap"
  }

  if (isWeakSet(value)) {
    return "WeakSet"
  }

  const seen = new Set<object>()
  let current: object | null = value

  while (current && !seen.has(current)) {
    seen.add(current)

    for (const intrinsic of UNSUPPORTED_INTRINSIC_PROTOTYPES) {
      if (current === intrinsic.prototype) {
        return intrinsic.name
      }
    }

    current = Object.getPrototypeOf(current) as object | null
  }

  return undefined
}

function readObjectTagWithoutAccessors(value: object): string {
  const seen = new Set<object>()
  let current: object | null = value

  while (current && !seen.has(current)) {
    seen.add(current)
    const descriptor = Object.getOwnPropertyDescriptor(current, Symbol.toStringTag)

    if (descriptor && !("value" in descriptor)) {
      throw new TypeError(
        `Snapshot accessor property ${String(Symbol.toStringTag)} is not supported`,
      )
    }

    if (descriptor) {
      break
    }

    current = Object.getPrototypeOf(current) as object | null
  }

  return Object.prototype.toString.call(value)
}

function materializeStack(
  source: Error | DOMException,
  target: Error | DOMException,
  snapshot: (value: unknown) => unknown,
): void {
  const sourceDescriptor = Object.getOwnPropertyDescriptor(source, "stack")
  const targetDescriptor = Object.getOwnPropertyDescriptor(target, "stack")

  if (!sourceDescriptor) {
    Reflect.deleteProperty(target, "stack")
    return
  }

  let value: unknown

  if ("value" in sourceDescriptor) {
    value = snapshot(sourceDescriptor.value)
  } else if (
    sourceDescriptor.get &&
    targetDescriptor &&
    !("value" in targetDescriptor) &&
    sourceDescriptor.get === targetDescriptor.get &&
    sourceDescriptor.set === targetDescriptor.set
  ) {
    value = Reflect.apply(sourceDescriptor.get, source, [])
  } else {
    throw new TypeError("Snapshot accessor property stack is not supported")
  }

  Object.defineProperty(target, "stack", {
    configurable: false,
    enumerable: sourceDescriptor.enumerable ?? false,
    value,
    writable: false,
  })
}

function recursivelyFreezeOwnData(value: object): void {
  const seen = new Set<object>()

  function freeze(current: object): void {
    if (seen.has(current)) {
      return
    }

    seen.add(current)

    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)

      if (
        descriptor &&
        "value" in descriptor &&
        (typeof descriptor.value === "object" || typeof descriptor.value === "function") &&
        descriptor.value !== null
      ) {
        freeze(descriptor.value)
      }
    }

    Object.freeze(current)
  }

  freeze(value)
}

function snapshotOwnProperties(
  source: object,
  target: object,
  snapshot: (value: unknown) => unknown,
  skip: ((key: PropertyKey) => boolean) | undefined = undefined,
): void {
  for (const key of Reflect.ownKeys(source)) {
    if (skip?.(key)) {
      continue
    }

    const descriptor = Object.getOwnPropertyDescriptor(source, key)

    if (!descriptor) {
      throw new TypeError(`Snapshot property ${String(key)} descriptor is unavailable`)
    }

    if ("value" in descriptor) {
      Object.defineProperty(target, key, {
        ...descriptor,
        value: snapshot(descriptor.value),
      })
      continue
    }

    throw new TypeError(`Snapshot accessor property ${String(key)} is not supported`)
  }
}

function rejectSnapshotMutation(): never {
  throw new TypeError("Cannot mutate a read-only snapshot")
}

function assertDenseArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`)
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error(`${label} must not contain a hole at index ${index}`)
    }
  }

  return value
}
function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null
}
