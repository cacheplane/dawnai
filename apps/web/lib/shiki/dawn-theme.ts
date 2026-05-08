import type { ThemeRegistration } from "shiki"

// Hex values mirror the resolved values of the Dawn brand tokens defined in
// apps/web/app/globals.css. Update both when the palette changes.
//
// Token map:
//   --color-text-secondary       → #c8c8cc (default text)
//   --color-text-muted           → #8b8fa3 (comments)
//   --color-accent-purple        → #c4a7e7 (keywords / control flow)
//   --color-accent-amber-deep    → #f5a524 (type names)
//   --color-accent-amber         → #fbbf24 (constants / numbers)
//   --color-accent-green         → #34c759 (strings)
//   --color-accent-blue          → #7fc8ff (functions / methods)
export const dawnTheme: ThemeRegistration = {
  name: "dawn",
  type: "dark",
  // Transparent background — the surrounding container owns its background.
  colors: {
    "editor.background": "#00000000",
    "editor.foreground": "#c8c8cc",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: "#8b8fa3", fontStyle: "italic" },
    },
    {
      scope: ["string", "string.template", "constant.other.symbol"],
      settings: { foreground: "#34c759" },
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.character"],
      settings: { foreground: "#fbbf24" },
    },
    {
      scope: ["keyword", "keyword.control", "storage", "storage.type", "storage.modifier"],
      settings: { foreground: "#c4a7e7" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "support.type",
        "support.class",
        "entity.other.inherited-class",
      ],
      settings: { foreground: "#f5a524" },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call entity.name.function"],
      settings: { foreground: "#7fc8ff" },
    },
    {
      scope: ["variable", "variable.other", "meta.definition.variable"],
      settings: { foreground: "#c8c8cc" },
    },
    {
      scope: ["punctuation", "meta.brace", "meta.delimiter"],
      settings: { foreground: "#c8c8cc" },
    },
    {
      scope: ["entity.name.tag", "meta.tag"],
      settings: { foreground: "#7fc8ff" },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { foreground: "#fbbf24" },
    },
  ],
}
