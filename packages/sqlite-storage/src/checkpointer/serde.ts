const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeBlob(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

export function decodeBlob(buf: Uint8Array): unknown {
  return JSON.parse(decoder.decode(buf))
}
