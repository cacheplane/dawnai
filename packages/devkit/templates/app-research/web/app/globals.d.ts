// Ambient declarations for the stylesheet imports in `layout.tsx`.
//
// Next ships `declare module "*.css"` in its own `global.d.ts`, but that file
// is only reachable through the `/// <reference types="next" />` inside
// `next-env.d.ts` — which Next writes during `next dev`/`next build` and which
// `.gitignore` keeps out of the repo. So on a fresh clone, before anyone has
// built, `tsc` has no declaration for a side-effect stylesheet import and
// `npm run typecheck` fails with TS2882 on every `import "...css"` below.
//
// The empty body deliberately matches Next's own declaration: a stylesheet is
// typed identically before and after the first build. The shorthand form
// (`declare module "*.css";`) would instead widen every stylesheet import to
// `any`, so pre-build and post-build type checking would disagree.
//
// Only `*.css` is declared because that is all this app imports. Add the
// matching `*.module.css` shape here too if you start using CSS modules.
declare module "*.css" {}
