const commands = [
  {
    name: "dawn check",
    body: "Validate a Dawn app by discovering routes and surfacing route entry issues.",
  },
  {
    name: "dawn routes",
    body: "List discovered Dawn routes or emit the route metadata as JSON.",
  },
  {
    name: "dawn typegen",
    body: "Generate route types for a target app from the discovered manifest.",
  },
  {
    name: "create-dawn-app",
    body: "Scaffold a new Dawn app. The first supported template is `basic`.",
  },
]

export default function CliPage() {
  return (
    <article className="docs-article">
      <p className="eyebrow">CLI</p>
      <h2>The first CLI surface stays close to app discovery and type generation.</h2>
      <p>
        The current command set is intentionally narrow. It validates Dawn apps, lists routes, and
        writes generated types. Scaffolding stays in the separate `create-dawn-app` package.
      </p>

      <div className="section-grid docs-grid">
        {commands.map((command) => (
          <article className="card" key={command.name}>
            <h3>{command.name}</h3>
            <p>{command.body}</p>
          </article>
        ))}
      </div>

      <pre className="code-block">
        <code>{`dawn check --cwd ./my-dawn-app
dawn routes --json --cwd ./my-dawn-app
dawn typegen --cwd ./my-dawn-app`}</code>
      </pre>
    </article>
  )
}
