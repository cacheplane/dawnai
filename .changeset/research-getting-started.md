---
"create-dawn-ai-app": patch
"@dawn-ai/devkit": patch
---

Improve the getting-started experience for scaffolded apps. `create-dawn-app`
now prints next-steps guidance after creating an app (cd / install / test / run
it live), the templates gain a `dev` script (`dawn dev --port 3000`) so you can
actually run the agent, and the research template README shows the live path
(ask a question via `/agui`) plus a pointer to the web-UI recipe.
