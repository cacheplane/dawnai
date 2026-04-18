// Bare function tools receive only input — no context parameter.
// This contract ensures the pattern compiles and has the correct shape.

type ToolFn<TInput = unknown, TOutput = unknown> = (input: TInput) => Promise<TOutput> | TOutput

const validBareToolUsage: ToolFn<
  { readonly tenant: string },
  { readonly greeting: string }
> = async (input) => ({ greeting: `Hello, ${input.tenant}!` })

void validBareToolUsage
