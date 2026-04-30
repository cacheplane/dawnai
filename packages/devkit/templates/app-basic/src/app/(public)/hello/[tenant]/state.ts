export interface HelloInput {
  readonly tenant: string
  readonly message: string
}

export interface HelloOutput {
  readonly response: string
}
