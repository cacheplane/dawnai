import { createHighlighter, type BundledLanguage } from "shiki"

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-light"],
      langs: ["typescript", "bash", "tsx"],
    })
  }
  return highlighterPromise
}

/**
 * Highlight code with shiki's bundled `github-light` theme. Intended for the
 * cream SaaS-rebrand surfaces where a dark theme would be unreadable.
 * Background is owned by the surrounding container (transparent).
 */
export async function highlightLight(
  code: string,
  lang: BundledLanguage
): Promise<string> {
  const highlighter = await getHighlighter()
  return highlighter.codeToHtml(code, {
    lang,
    theme: "github-light",
  })
}
