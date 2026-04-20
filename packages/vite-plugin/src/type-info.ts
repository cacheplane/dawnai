export type TypeInfo =
  | { readonly kind: "string" }
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "null" }
  | { readonly kind: "unknown" }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | { readonly kind: "array"; readonly element: TypeInfo }
  | { readonly kind: "tuple"; readonly elements: readonly TypeInfo[] }
  | { readonly kind: "object"; readonly properties: readonly PropertyInfo[] }
  | { readonly kind: "record"; readonly key: TypeInfo; readonly value: TypeInfo }
  | { readonly kind: "map"; readonly key: TypeInfo; readonly value: TypeInfo }
  | { readonly kind: "set"; readonly element: TypeInfo }
  | { readonly kind: "union"; readonly members: readonly TypeInfo[] }
  | { readonly kind: "intersection"; readonly members: readonly TypeInfo[] }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "optional"; readonly inner: TypeInfo }

export interface PropertyInfo {
  readonly name: string
  readonly type: TypeInfo
  readonly optional: boolean
  readonly description?: string
}
