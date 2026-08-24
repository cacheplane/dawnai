import "@copilotkit/react-core/v2/styles.css"

import { CopilotChatAssistantMessage } from "@copilotkit/react-core/v2"
import mermaid from "dawn-resolved-mermaid"
import { createRoot } from "react-dom/client"

interface MermaidConfigInspection {
  readonly markerAbsent: boolean
  readonly prototypeClean: boolean
}

interface MermaidBrowserHarness {
  readonly inspectMermaidConfig: (marker: string) => MermaidConfigInspection
  readonly initializeMermaid: (config: Readonly<Record<string, unknown>>) => void
  readonly render: (content: string) => void
  readonly renderMermaid: (id: string, source: string) => Promise<void>
  readonly unmount: () => void
}

declare global {
  interface Window {
    __dawnMermaidHarness?: Readonly<MermaidBrowserHarness>
  }
}

const host = document.querySelector<HTMLElement>("#root")
if (host === null) throw new Error("browser harness root is missing")

const root = createRoot(host)
const MarkdownRenderer = CopilotChatAssistantMessage.MarkdownRenderer
let mounted = true

window.__dawnMermaidHarness = Object.freeze({
  inspectMermaidConfig(marker: string) {
    if (!mounted) throw new Error("browser harness is unmounted")
    if (!/^mermaid[A-Za-z]+PrototypePollutionMarker$/u.test(marker)) {
      throw new Error("browser harness config marker is invalid")
    }
    const activeConfig = mermaid.mermaidAPI.getConfig() as Readonly<Record<string, unknown>>
    const activeConfigPrototype = Object.getPrototypeOf(activeConfig)
    return {
      markerAbsent: activeConfig[marker] === undefined,
      prototypeClean:
        activeConfigPrototype === Object.prototype && !Object.hasOwn(activeConfigPrototype, marker),
    }
  },
  initializeMermaid(config: Readonly<Record<string, unknown>>) {
    if (!mounted) throw new Error("browser harness is unmounted")
    mermaid.initialize(config)
  },
  render(content: string) {
    if (!mounted) throw new Error("browser harness is unmounted")
    if (typeof content !== "string" || content.length > 8_192) {
      throw new Error("browser harness content is invalid")
    }
    root.render(<MarkdownRenderer content={content} />)
  },
  async renderMermaid(id: string, source: string) {
    if (!mounted) throw new Error("browser harness is unmounted")
    if (
      !/^dawn-browser-[a-z-]{1,80}$/u.test(id) ||
      typeof source !== "string" ||
      source.length > 8_192
    ) {
      throw new Error("direct Mermaid render input is invalid")
    }
    await mermaid.render(id, source)
  },
  unmount() {
    if (!mounted) return
    mounted = false
    root.unmount()
  },
})
