import type { RouteKind } from "@dawn-ai/sdk"

export type { RouteKind }

export interface DawnConfig {
  readonly appDir?: string
}

export type RouteSegment =
  | {
      readonly kind: "static"
      readonly raw: string
    }
  | {
      readonly kind: "dynamic" | "catchall" | "optional-catchall"
      readonly name: string
      readonly raw: string
    }

export interface RouteDefinition {
  readonly id: string
  readonly pathname: string
  readonly kind: RouteKind
  readonly entryFile: string
  readonly routeDir: string
  readonly segments: RouteSegment[]
}

export interface RouteManifest {
  readonly appRoot: string
  readonly routes: RouteDefinition[]
}

export interface LoadDawnConfigOptions {
  readonly appRoot: string
}

export interface LoadedDawnConfig {
  readonly appRoot: string
  readonly config: DawnConfig
  readonly configPath: string
}

export interface FindDawnAppOptions {
  readonly appRoot?: string
  readonly cwd?: string
}

export interface DiscoveredDawnApp {
  readonly appRoot: string
  readonly configPath: string
  readonly dawnDir: string
  readonly routesDir: string
}

export interface DiscoverRoutesOptions {
  readonly appRoot?: string
  readonly cwd?: string
}

export interface ExtractedToolType {
  readonly name: string
  readonly inputType: string
  readonly outputType: string
}

export interface RouteToolTypes {
  readonly pathname: string
  readonly tools: readonly ExtractedToolType[]
}

export interface JsonSchemaProperty {
  readonly type: string
  readonly description?: string
  readonly items?: JsonSchemaProperty
  readonly properties?: Record<string, JsonSchemaProperty>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly enum?: readonly string[]
}

export interface ExtractedToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: "object"
    readonly properties: Record<string, JsonSchemaProperty>
    readonly required: readonly string[]
    readonly additionalProperties: false
  }
}

export interface RouteToolSchemas {
  readonly pathname: string
  readonly tools: readonly ExtractedToolSchema[]
}
