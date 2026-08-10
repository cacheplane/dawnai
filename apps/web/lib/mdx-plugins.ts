/**
 * The MDX pipeline, in one place.
 *
 * Turbopack requires serializable plugin references, so plugins are named by
 * module path rather than imported. `next.config.ts` feeds these to `@next/mdx`;
 * tests resolve the same list so they exercise the shipped pipeline instead of a
 * hand-maintained copy of it.
 */
// Mutable on purpose: `@next/mdx` accepts a mutable `PluggableList`.
export type MdxPluginSpec = [name: string, options: Record<string, unknown>]

export const MDX_REMARK_PLUGINS: MdxPluginSpec[] = [
  ["remark-gfm", {}],
  ["remark-frontmatter", { type: "yaml", marker: "-" }],
  ["remark-mdx-frontmatter", { name: "frontmatter" }],
]

export const MDX_REHYPE_PLUGINS: MdxPluginSpec[] = [
  // Gives every heading a stable, server-rendered id so in-page anchors resolve
  // at every level — including `####`, which the client-side TOC never walks.
  ["rehype-slug", {}],
  [
    "rehype-pretty-code",
    {
      theme: "github-light",
      keepBackground: false,
      defaultLang: "plaintext",
    },
  ],
]
