/**
 * Compose middleware functions into a single wrapper.
 *
 * Order: the LEFTMOST middleware is the OUTERMOST. Given
 * `compose(a, b, c)(base)`, the call order is `a -> b -> c -> base`,
 * mirroring how function call stacks read top-down.
 *
 * With zero middlewares, returns the base unchanged (no wrapper object).
 */
export function compose<T>(...middlewares: ReadonlyArray<(next: T) => T>): (base: T) => T {
  if (middlewares.length === 0) return (base) => base
  return (base) => middlewares.reduceRight((acc, mw) => mw(acc), base)
}
