/**
 * Resolves complex intersection/mapped types into a flat object shape.
 * Makes IDE hovers show the actual resolved type instead of type algebra.
 */
export type Prettify<T> = { [K in keyof T]: T[K] } & {}
