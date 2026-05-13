import { highlightLight } from "../../../lib/shiki/highlight-light"
import { CodeFrame } from "../ui/CodeFrame"
import { FeatureBlock } from "./FeatureBlock"

const TERMINAL = `$ pnpm dev

  ▲ Dawn dev server

  - Local:        http://localhost:3000
  - Network:      http://192.168.1.42:3000

  ✓ Compiled in 412ms
  ✓ Graph state preserved across reload

  ‒ Watching for changes…

  ✓ Updated route /support in 87ms
  ✓ Tool tools/lookup-order updated in 31ms`

export async function FeatureDevLoop() {
  const html = await highlightLight(TERMINAL, "bash")
  return (
    <FeatureBlock
      eyebrow="Dev loop"
      heading="Edit, save, reload — without restarting the graph."
      paragraph="Dawn's dev server keeps your graph state across edits. Change a prompt, save, and the next conversation continues from where you left off. Tool handlers, system prompts, route files, and Zod schemas all hot-reload — only schema-incompatible state changes cost a graph restart."
      bullets={[
        "HMR for routes, tools, and prompts",
        "Graph state preserved across compatible edits",
        "Type errors surface in the terminal and in your editor",
        "First compile in ~400ms; incremental in tens of ms",
      ]}
      link={{ href: "/docs/dev-server", label: "See dev server docs" }}
      imageSide="left"
      visual={
        <CodeFrame label="pnpm dev">
          <div
            className="px-4 py-4 text-sm font-mono leading-[22px] overflow-x-auto"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is server-generated
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </CodeFrame>
      }
    />
  )
}
