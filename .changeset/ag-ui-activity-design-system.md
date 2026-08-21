---
"@dawn-ai/ag-ui": patch
---

Give the plan and subagent activity cards Dawn's visual identity, plus a
customization ladder. Import `@dawn-ai/ag-ui/react/styles.css` for the default
look in light and dark; override CSS custom properties to restyle; pass
`classNames` to layer your own classes onto any part; pass `components` to
replace a todo or tool row outright. Cards render structured-but-unstyled when
the stylesheet is not imported, and every rule that styles an element is
scoped so the sheet cannot affect the rest of your app.

The cards' previous inline styles are gone. Existing consumers who upgrade
without importing the new stylesheet will see bare, unstyled cards — add
`import "@dawn-ai/ag-ui/react/styles.css"` to keep the appearance they
already had.
