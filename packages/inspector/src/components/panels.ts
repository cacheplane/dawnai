export interface InspectorPanel {
  readonly id: string
  readonly label: string
  readonly href: string
}
/** Registry the shell renders; future panels (threads, runs, sandbox) append here. */
export const PANELS: readonly InspectorPanel[] = [
  { id: "memory", label: "Memory", href: "/memory" },
]
