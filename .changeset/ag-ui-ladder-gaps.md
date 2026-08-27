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

Four details worth knowing about the resulting surface:

- `classNames.section` targets a card's labelled region only, so it is inert on
  `PlanActivityCard` and on a standalone `ActivityChecklist`. Use
  `classNames.checklist` for the checklist wrapper. Keeping them separate means
  one key cannot land on two nested elements and draw a box twice.
- The disclosure marker is `.dawn-activity__marker` and the checklist wrapper is
  `.dawn-activity__checklist`.
- Because the marker is a real element rather than generated content, its glyph
  is part of a `<summary>`'s `textContent`. Text assertions over a card header
  should expect it.
- A partial `:root` palette override applies in dark mode and under
  `data-dawn-theme`, not only in light. Set palette tokens as a set, or point
  them at values that are themselves theme-aware, so a half-overridden palette
  does not mix with the package's.

The package README documents this precisely. `classNames`
entries are appended to the package defaults and never substituted, but the
stylesheet is unlayered, so an appended class only takes effect on a property the
sheet leaves unset on that element. The docs now say which properties those are
and which remain rung-4 work.
