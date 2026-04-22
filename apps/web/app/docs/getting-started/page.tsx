import type { Metadata } from "next"
import GettingStarted from "../../../content/docs/getting-started.mdx"
import { getPrompt } from "../../../content/prompts"
import { CopyPromptButton } from "../../components/CopyPromptButton"
import { DocsBreadcrumb } from "../../components/docs/DocsBreadcrumb"
import { DocsPrevNext } from "../../components/docs/DocsPrevNext"

export const metadata: Metadata = {
  title: "Getting Started",
}

const scaffoldPrompt = getPrompt("scaffold")
const HREF = "/docs/getting-started"

export default function GettingStartedPage() {
  return (
    <>
      <DocsBreadcrumb href={HREF} />
      <article className="prose-dawn">
        <div className="mb-8 p-4 border border-border rounded-lg bg-bg-card/50 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-text-primary mb-1">
              Skip ahead — hand this to your coding agent
            </p>
            <p className="text-sm text-text-muted leading-relaxed">
              Copy a prompt that instructs Claude Code, Cursor, or any coding agent to scaffold a
              Dawn app and walk through the structure with you.
            </p>
          </div>
          <CopyPromptButton
            prompt={scaffoldPrompt.body}
            label="Copy scaffold prompt"
            variant="docs"
          />
        </div>
        <GettingStarted />
      </article>
      <DocsPrevNext href={HREF} />
    </>
  )
}
