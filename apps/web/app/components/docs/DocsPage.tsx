import type { ComponentType } from "react"
import { getPrompt, type PromptSlug } from "../../../content/prompts"
import { JsonLd } from "../../seo/JsonLd"
import { resolveStaticSeoPage } from "../../seo/resolve"
import { breadcrumbJsonLd, techArticleJsonLd } from "../../seo/structured-data"
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
  const seoPage = resolveStaticSeoPage(href)
  const slug = href.replace(/^\/docs\//, "")

  return (
    <>
      {seoPage ? (
        <>
          <JsonLd data={techArticleJsonLd(seoPage)} />
          <JsonLd data={breadcrumbJsonLd(seoPage)} />
        </>
      ) : null}
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
