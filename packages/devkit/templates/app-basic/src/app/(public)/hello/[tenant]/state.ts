export interface HelloInput {
  readonly tenant: string
}

export interface HelloOutput {
  readonly greeting: string
  readonly tenant: string
}

export interface HelloState {
  greeting?: string
  tenant: string
}
