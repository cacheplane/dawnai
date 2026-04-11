const packages = [
  {
    name: "@dawn/core",
    body: "Discovery, config loading, validation contracts, route metadata, and type generation inputs.",
  },
  {
    name: "@dawn/langgraph",
    body: "Native-first integration points for route entry contracts and small LangGraph-facing helpers.",
  },
  {
    name: "@dawn/cli",
    body: "The `dawn` binary and command implementations, composed from core discovery and type generation.",
  },
  {
    name: "create-dawn-app",
    body: "The unscoped scaffolder that writes a new Dawn app from a small, understandable template.",
  },
  {
    name: "@dawn/devkit",
    body: "Shared file-writing and template utilities used by the CLI and scaffolder.",
  },
  {
    name: "@dawn/config-biome",
    body: "Shared Biome config published or consumed internally by workspace packages.",
  },
  {
    name: "@dawn/config-typescript",
    body: "Shared TypeScript base configs for library, app, and Node package use cases.",
  },
];

export default function PackagesPage() {
  return (
    <article className="docs-article">
      <p className="eyebrow">Packages</p>
      <h2>The monorepo separates public surfaces early.</h2>
      <p>
        Dawn keeps the website, CLI, and framework packages in one repository, but each package has
        a clear responsibility so release boundaries do not blur as the product grows.
      </p>

      <div className="section-grid docs-grid">
        {packages.map((pkg) => (
          <article className="card" key={pkg.name}>
            <h3>{pkg.name}</h3>
            <p>{pkg.body}</p>
          </article>
        ))}
      </div>
    </article>
  );
}
