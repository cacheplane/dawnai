---
"@dawn-ai/ag-ui": patch
---

Close six gaps in the activity cards' customization ladder. The default
appearance is unchanged.

Rung 1 gains four custom properties — `--dawn-activity-margin`,
`--dawn-activity-padding`, `--dawn-activity-header-weight`, and
`--dawn-activity-badge-bg` — so the card's box spacing, the header's weight, and
the depth badge's background are reachable without ejecting. `--dawn-activity-badge-bg`
defaults to `var(--dawn-activity-border)`, so the badge keeps following the
palette until it is pointed elsewhere. All three of the sheet's token blocks are
now wrapped in `:where()`: they carry no specificity, so an application's own
`:root` override wins in dark mode and under `data-dawn-theme`, not only in
light. Overriding a token used to require a doubled `:root` selector to beat the
package's own dark palettes.

Rung 2 gains two `classNames` keys. `checklist` targets `ActivityChecklist`'s
wrapper, and `marker` targets the disclosure triangle, which is now a real
`aria-hidden` span instead of a `::before` — so it can be restyled, and its glyph
no longer lands in the summary's accessible name.

Four narrow behaviour changes, three of which fail silently rather than erroring:

- `classNames.section` no longer reaches the checklist wrapper. It now applies
  only to a card's labelled region, which means it is inert on
  `PlanActivityCard` and on a standalone `ActivityChecklist`. Pass
  `classNames.checklist` for the wrapper. This is the point of the change: one
  key used to land on two nested elements, so anything box-like drew twice.
- CSS written against `.dawn-activity__header::before` or against
  `.dawn-activity__section` as the checklist wrapper stops applying. The marker
  is `.dawn-activity__marker`; the wrapper is `.dawn-activity__checklist`.
- A `<summary>` element's `textContent` now includes the marker glyph, which
  generated content never contributed. A snapshot or text assertion over a card
  header can flip.
- A plain `:root` palette override now wins in dark mode and under
  `data-dawn-theme` as well as in light, where the package's own dark rules used
  to outrank it. That is the gap being closed, and it changes rendering: a
  PARTIAL override that previously lost to the package's dark palette now leaks
  through. Set palette tokens as a set, or point them at values that are
  themselves theme-aware. Note the README's own rung-1 example was such an
  override, and is corrected here for the same reason.

The README's rung-2 description is corrected as part of this. `classNames`
entries are appended to the package defaults and never substituted, but the
stylesheet is unlayered, so an appended class only takes effect on a property the
sheet leaves unset on that element. The docs now say which properties those are
and which remain rung-4 work.
