import type { ComponentType } from "react"
import { getPrompt, type PromptSlug } from "../../../content/prompts"
import { CopyPromptButton } from "../CopyPromptButton"
import { DocsBreadcrumb } from "./DocsBreadcrumb"
import { DocsPrevNext } from "./DocsPrevNext"

interface Props {
  readonly href: string
  readonly Content: ComponentType
  readonly promptSlug?: PromptSlug
  readonly promptPitch?: string
}

export function DocsPage({ href, Content, promptSlug, promptPitch }: Props) {
  const prompt = promptSlug ? getPrompt(promptSlug) : null

  return (
    <>
      <DocsBreadcrumb href={href} />
      <article className="prose-dawn">
        {prompt && (
          <div className="mb-8 p-4 border border-border rounded-lg bg-bg-card/50 flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-text-primary mb-1">
                Skip ahead — hand this to your coding agent
              </p>
              <p className="text-sm text-text-muted leading-relaxed">
                {promptPitch ?? prompt.description}
              </p>
            </div>
            <CopyPromptButton
              prompt={prompt.body}
              label={`Copy ${prompt.slug} prompt`}
              variant="docs"
            />
          </div>
        )}
        <Content />
      </article>
      <DocsPrevNext href={href} />
    </>
  )
}
