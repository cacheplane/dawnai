<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/dawn-logo-horizontal-black-on-white.png" alt="Dawn" width="180">
</p>

# create-dawn-ai-app

Scaffold a Dawn TypeScript application with a supported starter template and the canonical project layout.

**Use this when:** You are starting a new Dawn application from a supported template.

<p align="center">
  <a href="https://dawnai.org/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/dawnai/main/docs/brand/product-loop.gif" alt="Dawn product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>

## Install

Requires Node.js 24 or later. Run `npm create dawn-ai-app@latest my-agent`; a global installation is not required.

## Example

Create the default research starter and run its fixture-backed test suite:

```bash
npm create dawn-ai-app@latest my-agent
cd my-agent
npm install
npm test
```

The `research` template is the default. Version 0.8.21 generated the earlier single-package research starter; version 0.8.22 introduced the `server` and `web` workspace. Run `npm view create-dawn-ai-app@latest version` to see which release the current dist-tag selects. For a smaller greeter application, select the optional `basic` template with `npm create dawn-ai-app@latest my-agent -- --template basic`.

## Runtime and stability

`create-dawn-ai-app` is a Node-only executable. It creates files in the target directory but does not install dependencies or start the generated application for you. The generated app owns its provider credentials; fixture-backed tests do not silently fall through to a live provider.

## Related

Related packages are [`@dawn-ai/cli`](https://www.npmjs.com/package/@dawn-ai/cli), which develops and builds the generated app, and [`@dawn-ai/sdk`](https://www.npmjs.com/package/@dawn-ai/sdk), which supplies its author-facing declarations. See the [API catalog](https://dawnai.org/docs/api#create-dawn-ai-app), [Getting Started](https://dawnai.org/docs/getting-started), [testing guide](https://dawnai.org/docs/testing-agents), [CLI guide](https://dawnai.org/docs/cli), and [`create-dawn-ai-app` changelog](https://github.com/cacheplane/dawnai/blob/main/packages/create-dawn-app/CHANGELOG.md).

## Maturity and support

Dawn is pre-1.0, and its public surface can change. All publishable Dawn packages release together as a fixed group; review the [changelog](https://github.com/cacheplane/dawnai/blob/main/packages/create-dawn-app/CHANGELOG.md) and [upgrading guide](https://dawnai.org/docs/upgrading) before upgrading. For support, use [GitHub Discussions](https://github.com/cacheplane/dawnai/discussions); report defects in [GitHub Issues](https://github.com/cacheplane/dawnai/issues).

## License

MIT. See the [repository license](https://github.com/cacheplane/dawnai/blob/main/LICENSE).
