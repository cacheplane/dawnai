declare module "@copilotkit/react-core/v2/styles.css"

declare module "dawn-resolved-mermaid" {
  interface MermaidBrowserApi {
    initialize(config: Readonly<Record<string, unknown>>): void
    readonly mermaidAPI: {
      getConfig(): Readonly<Record<string, unknown>>
    }
    render(id: string, source: string): Promise<{ readonly svg: string }>
  }

  const mermaid: MermaidBrowserApi
  export default mermaid
}
