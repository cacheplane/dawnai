import { createHighlighter, type BundledLanguage } from "shiki"
import { dawnTheme } from "./dawn-theme"

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [dawnTheme],
      langs: ["typescript", "bash"],
    })
  }
  return highlighterPromise
}

export async function highlight(code: string, lang: BundledLanguage): Promise<string> {
  const highlighter = await getHighlighter()
  return highlighter.codeToHtml(code, { lang, theme: "dawn" })
}
