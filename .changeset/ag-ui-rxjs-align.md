---
"@dawn-ai/ag-ui": patch
---

Align the rxjs devDependency with the one `@ag-ui/client` actually uses.

`@ag-ui/client` and its middleware siblings pin rxjs to exactly `7.8.1`, while
this package's test-only devDependency asked for `7.8.2`. Two copies of rxjs
meant two nominally distinct `Observable` declarations, so a test consuming a
stream produced by `@ag-ui/client` could not describe it in types. rxjs is used
only by the conformance test here; matching the version the objects come from is
the point of the pin.
