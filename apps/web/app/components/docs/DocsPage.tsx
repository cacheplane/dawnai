import type { ComponentType } from "react"
import { getPrompt, type PromptSlug } from "../../../content/prompts"
import { DocsBreadcrumb } from "./DocsBreadcrumb"
import { DocsPrevNext } from "./DocsPrevNext"
import { PageActions } from "./PageActions"

interface Props {
  readonly href: string
  readonly Content: ComponentType
  readonly promptSlug?: PromptSlug
  readonly promptPitch?: string
}

export function DocsPage({ href, Content, promptSlug }: Props) {
  const prompt = promptSlug ? getPrompt(promptSlug) : null
  const slug = href.replace(/^\/docs\//, "")

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <DocsBreadcrumb href={href} />
        <PageActions
          slug={slug}
          {...(promptSlug ? { promptSlug } : {})}
          {...(prompt?.body ? { promptBody: prompt.body } : {})}
        />
      </div>
      <article className="prose-dawn">
        <Content />
      </article>
      <DocsPrevNext href={href} />
    </>
  )
}
