/**
 * The workbench's one secondary button.
 *
 * Shared rather than copied because `PermissionInterrupt` and `RunError` had
 * byte-identical class strings: two copies of a decision is one copy too many,
 * and a reader cannot tell whether a divergence between them was intentional.
 * Compose for the local extras, e.g. `${SECONDARY_BUTTON} shrink-0`.
 */
export const SECONDARY_BUTTON =
  "wb-focus rounded-wb-sm border border-wb-border bg-wb-surface px-2.5 py-1 text-[12px] font-medium transition-colors hover:border-wb-muted"
