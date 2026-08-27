import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Children, createElement, isValidElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { AUTHORS, loadPostsFromDir, type Post } from "../components/blog/post-index"
import { DocsBreadcrumb } from "../components/docs/DocsBreadcrumb"
import { DocsPage } from "../components/docs/DocsPage"
import { ALL_DOCS_PAGES, breadcrumbsFor } from "../components/docs/nav"
import { JsonLd } from "./JsonLd"
import {
  buildDocsSeoRegistry,
  DOCS_SEO_ENTRIES,
  DOCS_SEO_PAGES,
  type DocsSeoEntry,
  requireValidLastModified,
  STATIC_SEO_PAGES,
} from "./registry"
import * as seoResolvers from "./resolve"
import {
  resolveBlogIndexSeoPage,
  resolveBlogSeoPage,
  resolveBlogTagSeoPage,
  resolveStaticSeoPage,
  toMetadata,
} from "./resolve"
import * as structuredData from "./structured-data"
import {
  blogPostingJsonLd,
  breadcrumbJsonLd,
  collectionPageJsonLd,
  siteJsonLd,
  techArticleJsonLd,
} from "./structured-data"

const seoDirectory = dirname(fileURLToPath(import.meta.url))
const GETTING_STARTED_PATH = "/docs/getting-started"
const GETTING_STARTED_DESCRIPTION =
  "Build a typed Dawn research agent with file-system routes, generated types, local tools, offline tests, and production build targets."
const BLOG_INDEX_DESCRIPTION =
  "Writing on the agent stack, type-safety, and the tools we're building."
const PRODUCTION_AS_OF = "2026-08-26"
const HOME_TITLE = "Dawn AI — TypeScript Meta-Framework for LangGraph.js"
const HOME_DESCRIPTION =
  "Dawn AI is the TypeScript meta-framework for LangGraph.js, with file-system routes, route-local tools, generated types, and durable threads."
const BLOG_CONTENT_DIRECTORY = resolve(seoDirectory, "../../content/blog")
const REPO_ROOT = resolve(seoDirectory, "../../../..")

function docsSourcePath(href: string): string {
  const slug = href.replace(/^\/docs\//, "")
  return `apps/web/content/docs/${slug === "recipes" ? "recipes/index" : slug}.mdx`
}

function authoredPosts(): readonly Post[] {
  return loadPostsFromDir(BLOG_CONTENT_DIRECTORY, {
    currentDate: "9999-12-31",
    includeDrafts: true,
  })
}

function productionPosts(): readonly Post[] {
  return loadPostsFromDir(BLOG_CONTENT_DIRECTORY, {
    currentDate: PRODUCTION_AS_OF,
    includeDrafts: false,
  })
}

function expectNormalizedDescriptions(
  pages: readonly { readonly path: string; readonly description: string }[],
) {
  const firstRouteByDescription = new Map<string, string>()
  const duplicateRoutePairs: string[] = []

  for (const page of pages) {
    const firstRoute = firstRouteByDescription.get(page.description)
    if (firstRoute !== undefined) duplicateRoutePairs.push(`${firstRoute} = ${page.path}`)
    else firstRouteByDescription.set(page.description, page.path)

    expect(page.description, page.path).toBe(page.description.trim())
    expect(page.description.length, page.path).toBeGreaterThanOrEqual(50)
    expect(page.description.length, page.path).toBeLessThanOrEqual(155)
    expect(page.description, page.path).not.toMatch(/[\r\n]|\s{2,}/)
    expect(page.description, page.path).toMatch(/[.!?]$/)
  }

  expect(firstRouteByDescription).toHaveLength(pages.length)
  expect(duplicateRoutePairs).toEqual([])
}

function productionTags(posts: readonly Post[]): readonly string[] {
  return [...new Set(posts.flatMap((post) => post.tags))].sort()
}

function expectValidDescription(description: string) {
  expect(description.length).toBeGreaterThanOrEqual(50)
  expect(description.length).toBeLessThanOrEqual(155)
}

describe("homepage SEO", () => {
  it("normalizes the homepage with a distinctive absolute title and one complete social descriptor", () => {
    const page = resolveStaticSeoPage("/")

    expect(page).toBeDefined()
    if (!page) return

    expect(page).toMatchObject({
      path: "/",
      canonical: "https://dawnai.org/",
      title: HOME_TITLE,
      description: HOME_DESCRIPTION,
      kind: "WebPage",
      breadcrumbs: [],
    })
    expect(new Date(page.lastModified).toISOString()).toBe(page.lastModified)
    expect(HOME_TITLE).toMatch(/^Dawn AI\b.*(?:TypeScript|LangGraph)/)
    expect(HOME_TITLE.length).toBeLessThanOrEqual(60)
    expectValidDescription(page.description)

    expect(toMetadata(page)).toEqual({
      title: { absolute: HOME_TITLE },
      description: HOME_DESCRIPTION,
      alternates: { canonical: "https://dawnai.org/" },
      openGraph: {
        type: "website",
        url: "https://dawnai.org/",
        siteName: "Dawn AI",
        title: HOME_TITLE,
        description: HOME_DESCRIPTION,
        images: [
          {
            url: "/opengraph-image",
            type: "image/png",
            width: 1200,
            height: 630,
            alt: "Dawn — TypeScript meta-framework for LangGraph.js",
          },
        ],
      },
      twitter: {
        card: "summary_large_image",
        title: HOME_TITLE,
        description: HOME_DESCRIPTION,
        images: [
          {
            url: "/opengraph-image",
            type: "image/png",
            width: 1200,
            height: 630,
            alt: "Dawn — TypeScript meta-framework for LangGraph.js",
          },
        ],
      },
    })
  })

  it("links homepage WebPage data only to the sitewide WebSite and Organization", () => {
    const page = resolveStaticSeoPage("/")
    expect(page).toBeDefined()
    if (!page) return
    expect(page.kind).toBe("WebPage")
    if (page.kind !== "WebPage") return

    const webPageJsonLd = Reflect.get(structuredData, "webPageJsonLd")
    expect(webPageJsonLd).toBeTypeOf("function")
    if (typeof webPageJsonLd !== "function") return

    expect(webPageJsonLd(page)).toEqual({
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": "https://dawnai.org/#webpage",
      url: "https://dawnai.org/",
      name: HOME_TITLE,
      description: HOME_DESCRIPTION,
      isPartOf: { "@id": "https://dawnai.org/#website" },
      publisher: { "@id": "https://dawnai.org/#organization" },
    })
  })

  it("renders resolver-backed metadata and WebPage data from the homepage module", async () => {
    const page = resolveStaticSeoPage("/")
    expect(page).toBeDefined()
    if (!page) return

    const homeModule = await import("../page")
    expect(Reflect.get(homeModule, "metadata")).toEqual(toMetadata(page))

    const tree = homeModule.default()
    const children = Children.toArray(tree.props.children)
    const homepageData = children.flatMap((child) =>
      isValidElement(child) && child.type === JsonLd
        ? [(child.props as { readonly data: unknown }).data]
        : [],
    )

    expect(homepageData).toEqual([
      {
        "@context": "https://schema.org",
        "@type": "WebPage",
        "@id": "https://dawnai.org/#webpage",
        url: "https://dawnai.org/",
        name: HOME_TITLE,
        description: HOME_DESCRIPTION,
        isPartOf: { "@id": "https://dawnai.org/#website" },
        publisher: { "@id": "https://dawnai.org/#organization" },
      },
    ])
  })

  it("bases every snippet claim on visibly rendered homepage sections", () => {
    const homeSource = readFileSync(resolve(seoDirectory, "../page.tsx"), "utf8")
    const visibleSources = [
      "Hero.tsx",
      "FeatureRouting.tsx",
      "FeatureTools.tsx",
      "FeatureTypes.tsx",
      "DurableByDefault.tsx",
    ]
      .map((file) => readFileSync(resolve(seoDirectory, `../components/landing/${file}`), "utf8"))
      .join("\n")

    for (const component of [
      "Hero",
      "FeatureRouting",
      "FeatureTools",
      "FeatureTypes",
      "DurableByDefault",
    ]) {
      expect(homeSource).toContain(`<${component} />`)
    }
    for (const factualTerm of [
      "TypeScript meta-framework",
      "LangGraph.js",
      "File-system routing",
      "Route-local tools",
      "generated types",
      "durable threads",
    ]) {
      expect(visibleSources.toLowerCase()).toContain(factualTerm.toLowerCase())
    }

    expect(readFileSync(resolve(seoDirectory, "../layout.tsx"), "utf8")).not.toContain(
      "webPageJsonLd",
    )
  })
})

describe("production SEO inventory", () => {
  it("applies an explicit UTC as-of date before normalizing posts, tags, and descriptions", () => {
    const visiblePosts = productionPosts().map((post) => ({
      ...post,
      tags: post.tags.filter((tag) => tag !== "typescript"),
    }))
    const sourcePost = visiblePosts[0]
    expect(sourcePost).toBeDefined()
    if (!sourcePost) return

    const futurePost: Post = {
      ...sourcePost,
      slug: "scheduled-inventory-post",
      title: "Scheduled inventory post",
      description:
        "A scheduled Dawn article that verifies date-bound production SEO inventory selection.",
      date: "2026-08-27",
      tags: ["typescript"],
      draft: false,
      sourceFile: "2026-08-27-scheduled-inventory-post.mdx",
    }
    const draftPost: Post = {
      ...futurePost,
      slug: "draft-inventory-post",
      title: "Draft inventory post",
      description:
        "A draft Dawn article that must remain outside production SEO inventory on every date.",
      date: "2026-08-20",
      tags: ["patterns"],
      draft: true,
      sourceFile: "2026-08-20-draft-inventory-post.mdx",
    }
    const buildSeoPageInventory = Reflect.get(seoResolvers, "buildSeoPageInventory")
    expect(buildSeoPageInventory).toBeTypeOf("function")
    if (typeof buildSeoPageInventory !== "function") return

    const pathsAsOf = (currentDate: string) =>
      (
        buildSeoPageInventory([...visiblePosts, futurePost, draftPost], currentDate) as readonly {
          readonly path: string
          readonly description: string
        }[]
      ).map(({ path, description }) => ({ path, description }))

    const before = pathsAsOf("2026-08-26")
    const publicationDate = pathsAsOf("2026-08-27")
    const after = pathsAsOf("2026-08-28")

    expect(before.map(({ path }) => path)).not.toContain("/blog/scheduled-inventory-post")
    expect(before.map(({ path }) => path)).not.toContain("/blog/draft-inventory-post")
    expect(before.map(({ path }) => path)).not.toContain("/blog/tags/typescript")
    expect(before.map(({ path }) => path)).not.toContain("/blog/tags/patterns")
    expect(before).toHaveLength(82)
    expectNormalizedDescriptions(before)
    for (const pages of [publicationDate, after]) {
      expect(pages.map(({ path }) => path)).toContain("/blog/scheduled-inventory-post")
      expect(pages.map(({ path }) => path)).not.toContain("/blog/draft-inventory-post")
      expect(pages.map(({ path }) => path)).toContain("/blog/tags/typescript")
      expect(pages.map(({ path }) => path)).not.toContain("/blog/tags/patterns")
      expect(pages).toHaveLength(84)
      expectNormalizedDescriptions(pages)
    }
  })

  it("resolves an injected publication date from authored posts, not the environment route cache", async () => {
    const sourcePost = productionPosts()[0]
    expect(sourcePost).toBeDefined()
    if (!sourcePost) return

    const futurePost: Post = {
      ...sourcePost,
      slug: "scheduled-authored-post",
      title: "Scheduled authored post",
      description:
        "A scheduled authored Dawn article used to verify production resolver date injection.",
      date: "2026-08-27",
      tags: ["agents"],
      draft: false,
      sourceFile: "2026-08-27-scheduled-authored-post.mdx",
    }

    vi.resetModules()
    vi.doMock("../components/blog/post-index", async () => {
      const actual = await vi.importActual<typeof import("../components/blog/post-index")>(
        "../components/blog/post-index",
      )
      return {
        ...actual,
        getAllPosts: () => [sourcePost],
        getAuthoredPosts: () => [sourcePost, futurePost],
      }
    })

    try {
      const { resolveProductionSeoPages } = await import("./resolve")
      const paths = resolveProductionSeoPages("2026-08-27").map(({ path }) => path)
      expect(paths).toContain("/blog/scheduled-authored-post")
    } finally {
      vi.doUnmock("../components/blog/post-index")
      vi.resetModules()
    }
  })

  it("builds one normalized route-kind union for the current 83 indexable routes", () => {
    const buildSeoPageInventory = Reflect.get(seoResolvers, "buildSeoPageInventory")
    expect(buildSeoPageInventory).toBeTypeOf("function")
    if (typeof buildSeoPageInventory !== "function") return

    const pages = buildSeoPageInventory(authoredPosts(), PRODUCTION_AS_OF) as readonly {
      readonly path: string
      readonly routeKind: string
    }[]

    expect(pages.map(({ path }) => path)).toEqual([
      "/",
      "/blog",
      ...ALL_DOCS_PAGES.map(({ href }) => href),
      "/blog/eve-validates-the-shape",
      "/blog/app-router-for-ai-agents",
      "/blog/why-we-built-dawn",
      "/blog/tags/philosophy",
      "/blog/tags/agents",
      "/blog/tags/typescript",
    ])
    expect(pages).toHaveLength(83)
    expect(pages.map(({ routeKind }) => routeKind)).toEqual([
      "home",
      "blog-index",
      ...Array.from({ length: 75 }, () => "docs"),
      ...Array.from({ length: 3 }, () => "blog-post"),
      ...Array.from({ length: 3 }, () => "blog-tag"),
    ])
  })

  it("keeps all 83 production descriptions normalized and globally unique", () => {
    const buildSeoPageInventory = Reflect.get(seoResolvers, "buildSeoPageInventory")
    expect(buildSeoPageInventory).toBeTypeOf("function")
    if (typeof buildSeoPageInventory !== "function") return

    const pages = buildSeoPageInventory(authoredPosts(), PRODUCTION_AS_OF) as readonly {
      readonly path: string
      readonly description: string
    }[]
    expect(pages).toHaveLength(83)
    expectNormalizedDescriptions(pages)
  })
})

describe("blog SEO API", () => {
  it("exposes shared blog resolvers and structured-data builders", () => {
    expect(seoResolvers).toEqual(
      expect.objectContaining({
        resolveBlogIndexSeoPage: expect.any(Function),
        resolveBlogTagSeoPage: expect.any(Function),
        resolveBlogSeoPage: expect.any(Function),
      }),
    )
    expect(structuredData).toEqual(
      expect.objectContaining({
        siteJsonLd: expect.any(Function),
        collectionPageJsonLd: expect.any(Function),
        blogPostingJsonLd: expect.any(Function),
      }),
    )
  })

  it("normalizes the production blog index, tag routes, and post routes", () => {
    const posts = productionPosts()
    const tags = productionTags(posts)
    const tagPages = tags.map((tag) =>
      resolveBlogTagSeoPage(
        tag,
        posts.filter((post) => post.tags.includes(tag)),
      ),
    )
    const postPages = posts.map(resolveBlogSeoPage)

    expect(posts).toHaveLength(3)
    expect(tags).toEqual(["agents", "philosophy", "typescript"])
    expect([
      resolveBlogIndexSeoPage().path,
      ...tagPages.map((page) => page.path),
      ...postPages.map((page) => page.path),
    ]).toEqual([
      "/blog",
      "/blog/tags/agents",
      "/blog/tags/philosophy",
      "/blog/tags/typescript",
      "/blog/eve-validates-the-shape",
      "/blog/app-router-for-ai-agents",
      "/blog/why-we-built-dawn",
    ])
  })

  it("keeps every resolved blog description factual and between 50 and 155 characters", () => {
    const visiblePosts = productionPosts()
    const tags = productionTags(visiblePosts)
    const index = resolveBlogIndexSeoPage()

    expect(index.description).toBe(BLOG_INDEX_DESCRIPTION)
    expectValidDescription(index.description)

    const tagDescriptions = tags.map((tag) => {
      const posts = visiblePosts.filter((post) => post.tags.includes(tag))
      const description = resolveBlogTagSeoPage(tag, posts).description

      expectValidDescription(description)
      expect(description).toContain(tag)
      expect(description).toContain(String(posts.length))
      for (const post of posts) expect(description).toContain(post.title)
      return description
    })
    expect(new Set(tagDescriptions).size).toBe(tagDescriptions.length)

    for (const post of authoredPosts()) {
      expect(resolveBlogSeoPage(post).description).toBe(post.description)
      expectValidDescription(post.description)
    }
  })

  it("preserves blog RSS discovery while adding the index canonical", () => {
    const page = resolveBlogIndexSeoPage()

    expect(toMetadata(page).alternates).toEqual({
      canonical: page.canonical,
      types: { "application/rss+xml": "/blog/rss.xml" },
    })
  })

  it("uses one exact description across metadata, social metadata, and page JSON-LD", () => {
    const posts = productionPosts()
    const collectionPages = [
      resolveBlogIndexSeoPage(),
      ...productionTags(posts).map((tag) =>
        resolveBlogTagSeoPage(
          tag,
          posts.filter((post) => post.tags.includes(tag)),
        ),
      ),
    ]

    for (const page of collectionPages) {
      const metadata = toMetadata(page)
      const entity = collectionPageJsonLd(page) as Record<string, unknown>

      expect(metadata.description).toBe(page.description)
      expect(metadata.openGraph?.description).toBe(page.description)
      expect(metadata.twitter?.description).toBe(page.description)
      expect(entity.description).toBe(page.description)
      expect(metadata.openGraph).toMatchObject({
        type: "website",
        url: page.canonical,
        siteName: "Dawn AI",
        title: page.title,
        images: expect.any(Array),
      })
      expect(metadata.twitter).toMatchObject({
        card: "summary_large_image",
        title: page.title,
        images: expect.any(Array),
      })
    }

    for (const post of posts) {
      const page = resolveBlogSeoPage(post)
      const metadata = toMetadata(page)
      const entity = blogPostingJsonLd(page) as Record<string, unknown>
      const author = AUTHORS[post.author]
      if (!author) throw new Error(`Expected published author ${post.author}`)

      expect(metadata.description).toBe(page.description)
      expect(metadata.openGraph?.description).toBe(page.description)
      expect(metadata.twitter?.description).toBe(page.description)
      expect(entity.description).toBe(page.description)
      expect(metadata.openGraph).toMatchObject({
        type: "article",
        url: page.canonical,
        publishedTime: post.date,
        authors: [author.name],
        siteName: "Dawn AI",
        title: page.title,
      })
      expect(metadata.twitter).toMatchObject({
        card: "summary_large_image",
        title: page.title,
      })
    }
  })

  it("leaves posts without an explicit image to their co-located social image route", () => {
    const post = productionPosts()[0]
    if (!post) throw new Error("Expected a production blog post")

    const metadata = toMetadata(resolveBlogSeoPage(post))

    expect(metadata.openGraph).not.toHaveProperty("images")
    expect(metadata.twitter).not.toHaveProperty("images")
  })

  it("publishes only supported site identity fields and a real logo URL", () => {
    expect(siteJsonLd()).toEqual({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": "https://dawnai.org/#organization",
          name: "Dawn AI",
          url: "https://dawnai.org/",
          logo: {
            "@type": "ImageObject",
            "@id": "https://dawnai.org/#logo",
            url: "https://dawnai.org/brand/dawn-logo-horizontal-black.svg",
          },
        },
        {
          "@type": "WebSite",
          "@id": "https://dawnai.org/#website",
          name: "Dawn AI",
          url: "https://dawnai.org/",
          publisher: { "@id": "https://dawnai.org/#organization" },
        },
      ],
    })

    const serialized = JSON.stringify(siteJsonLd())
    expect(serialized).not.toContain('"description"')
    expect(serialized).not.toContain('"sameAs"')
    expect(serialized).not.toContain('"potentialAction"')
  })

  it("publishes each blog author as the display-name Person without biography claims", () => {
    const forbiddenPersonFields = [
      "description",
      "jobTitle",
      "worksFor",
      "award",
      "alumniOf",
      "knowsAbout",
      "hasCredential",
    ]

    for (const post of authoredPosts()) {
      const entity = blogPostingJsonLd(resolveBlogSeoPage(post)) as {
        author: Record<string, unknown>
      }
      const author = AUTHORS[post.author]
      if (!author) throw new Error(`Expected published author ${post.author}`)

      expect(entity.author).toEqual({
        "@type": "Person",
        "@id": author.url,
        name: author.name,
        url: author.url,
        image: new URL(author.avatar, "https://dawnai.org").href,
      })
      expect(entity.author.name).not.toBe(post.author)
      for (const field of forbiddenPersonFields) {
        expect(entity.author).not.toHaveProperty(field)
      }
    }
  })

  it("uses absolute Home-to-Blog breadcrumbs for post and tag pages", () => {
    const posts = productionPosts()
    const post = posts[0]
    if (!post) throw new Error("Expected a production blog post")
    const tag = post.tags[0]
    if (!tag) throw new Error("Expected a production blog tag")

    const postPage = resolveBlogSeoPage(post)
    const tagPage = resolveBlogTagSeoPage(
      tag,
      posts.filter((candidate) => candidate.tags.includes(tag)),
    )

    expect(
      breadcrumbJsonLd(postPage).itemListElement.map(({ name, item }) => ({ name, item })),
    ).toEqual([
      { name: "Home", item: "https://dawnai.org/" },
      { name: "Blog", item: "https://dawnai.org/blog" },
      { name: post.title, item: postPage.canonical },
    ])
    expect(
      breadcrumbJsonLd(tagPage).itemListElement.map(({ name, item }) => ({ name, item })),
    ).toEqual([
      { name: "Home", item: "https://dawnai.org/" },
      { name: "Blog", item: "https://dawnai.org/blog" },
      { name: `Posts tagged ${tag}`, item: tagPage.canonical },
    ])
  })
})

describe("static SEO pages", () => {
  it("resolves one normalized Getting Started description across metadata and TechArticle data", () => {
    const page = resolveStaticSeoPage(GETTING_STARTED_PATH)
    expect(page).toBeDefined()
    if (!page) throw new Error("Getting Started SEO page is not registered")

    const metadata = toMetadata(page)
    const article = techArticleJsonLd(page)

    expect(page.description).toBe(GETTING_STARTED_DESCRIPTION)
    expect(metadata.description).toBe(page.description)
    expect(metadata.openGraph?.description).toBe(page.description)
    expect(metadata.twitter?.description).toBe(page.description)
    expect(article.description).toBe(page.description)
  })

  it("returns complete social metadata without dropping shared fields", () => {
    const page = resolveStaticSeoPage(GETTING_STARTED_PATH)
    expect(page).toBeDefined()
    if (!page) throw new Error("Getting Started SEO page is not registered")

    expect(toMetadata(page)).toEqual({
      title: "Getting Started",
      description: GETTING_STARTED_DESCRIPTION,
      alternates: { canonical: "https://dawnai.org/docs/getting-started" },
      openGraph: {
        type: "article",
        url: "https://dawnai.org/docs/getting-started",
        siteName: "Dawn AI",
        title: "Getting Started",
        description: GETTING_STARTED_DESCRIPTION,
        images: [
          {
            url: "/opengraph-image",
            type: "image/png",
            width: 1200,
            height: 630,
            alt: "Dawn — TypeScript meta-framework for LangGraph.js",
          },
        ],
      },
      twitter: {
        card: "summary_large_image",
        title: "Getting Started",
        description: GETTING_STARTED_DESCRIPTION,
        images: [
          {
            url: "/opengraph-image",
            type: "image/png",
            width: 1200,
            height: 630,
            alt: "Dawn — TypeScript meta-framework for LangGraph.js",
          },
        ],
      },
    })
  })

  it("uses an absolute self-referencing canonical for Getting Started", () => {
    const page = resolveStaticSeoPage(GETTING_STARTED_PATH)
    expect(page).toBeDefined()
    if (!page) throw new Error("Getting Started SEO page is not registered")

    expect(page.canonical).toBe("https://dawnai.org/docs/getting-started")
    expect(toMetadata(page).alternates?.canonical).toBe(page.canonical)
    expect(techArticleJsonLd(page).url).toBe(page.canonical)
  })

  it("derives valid BreadcrumbList trails from the visible breadcrumbs for all 75 docs routes", () => {
    for (const { href, label } of ALL_DOCS_PAGES) {
      const page = resolveStaticSeoPage(href)
      expect(page, `${href} SEO page`).toBeDefined()
      if (!page) continue

      const visibleBreadcrumbs = breadcrumbsFor(href)
      const visibleMarkup = renderToStaticMarkup(createElement(DocsBreadcrumb, { href }))
      const visibleLabels = [...visibleMarkup.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(
        (match) => match[1]?.match(/<(?:a [^>]*|span class="text-ink-muted")>([^<]+)</)?.[1] ?? "",
      )
      const breadcrumbItems = breadcrumbJsonLd(page).itemListElement

      expect(page.breadcrumbs, `${href} shared visible trail`).toEqual(visibleBreadcrumbs)
      expect(visibleLabels, `${href} rendered visible labels`).toEqual(
        visibleBreadcrumbs.map(({ label: crumbLabel }) => crumbLabel),
      )
      expect(
        breadcrumbItems.map(({ name }) => name),
        `${href} JSON-LD labels and order`,
      ).toEqual(visibleBreadcrumbs.map(({ label: crumbLabel }) => crumbLabel))
      expect(breadcrumbItems.at(-1), `${href} current-page crumb`).toEqual({
        "@type": "ListItem",
        position: breadcrumbItems.length,
        name: label,
      })

      const ancestorItems = breadcrumbItems.slice(0, -1).map(({ item }) => item)
      expect(
        ancestorItems.every((item) => typeof item === "string" && item.startsWith("https://")),
        `${href} absolute ancestor items`,
      ).toBe(true)
      expect(new Set(ancestorItems).size, `${href} unique ancestor URLs`).toBe(ancestorItems.length)
      expect(ancestorItems, `${href} excludes current canonical from ancestors`).not.toContain(
        page.canonical,
      )
    }
  })

  it("returns undefined for an unregistered page", () => {
    expect(resolveStaticSeoPage("/docs/not-registered")).toBeUndefined()
  })

  it("registers exactly the 75 authored docs routes without the redirect", () => {
    const expectedHrefs = ALL_DOCS_PAGES.map(({ href }) => href).sort()
    const registeredHrefs = Object.keys(DOCS_SEO_PAGES).sort()

    expect(expectedHrefs).toHaveLength(75)
    expect(registeredHrefs).toEqual(expectedHrefs)
    expect(registeredHrefs).not.toContain("/docs")
  })

  it("keeps the exact docs registry distinct from the future-wide static registry", () => {
    expect(STATIC_SEO_PAGES).not.toBe(DOCS_SEO_PAGES)
    expect(STATIC_SEO_PAGES).toMatchObject(DOCS_SEO_PAGES)
  })

  it("rejects duplicate, missing, and extra source entries before registry keys can collapse", () => {
    const firstEntry = DOCS_SEO_ENTRIES[0]
    expect(firstEntry).toBeDefined()
    if (!firstEntry) return

    expect(() => buildDocsSeoRegistry([...DOCS_SEO_ENTRIES, firstEntry])).toThrow(
      "Duplicate docs SEO entry: /docs/getting-started",
    )
    expect(() => buildDocsSeoRegistry(DOCS_SEO_ENTRIES.slice(1))).toThrow(
      "Missing docs SEO entry: /docs/getting-started",
    )
    const extraEntry = {
      ...firstEntry,
      path: "/docs/not-authored",
    } as unknown as DocsSeoEntry
    expect(() => buildDocsSeoRegistry([...DOCS_SEO_ENTRIES, extraEntry])).toThrow(
      "Extra docs SEO entry: /docs/not-authored",
    )
  })

  it("uses one unique, normalized, query-answering description per docs route", () => {
    const descriptions = Object.values(DOCS_SEO_PAGES).map((page) => page.description)

    expect(descriptions).toHaveLength(75)
    expect(new Set(descriptions).size).toBe(descriptions.length)
    for (const description of descriptions) {
      expect(description).toBe(description.trim())
      expect(description.length).toBeGreaterThanOrEqual(75)
      expect(description.length).toBeLessThanOrEqual(155)
      expect(description).not.toMatch(/[\r\n]/)
      expect(description).not.toMatch(/\s{2,}/)
      expect(description).toMatch(/[.!?]$/)
    }
  })

  it("binds every docs registry entry to its exact existing MDX source", () => {
    const failures: string[] = []

    for (const { href } of ALL_DOCS_PAGES) {
      const expectedSourcePath = docsSourcePath(href)
      const page = DOCS_SEO_PAGES[href]
      const sourcePath = page && "sourcePath" in page ? page.sourcePath : undefined

      if (sourcePath !== expectedSourcePath) {
        failures.push(`${href}: expected ${expectedSourcePath}, received ${String(sourcePath)}`)
      } else if (!existsSync(resolve(REPO_ROOT, sourcePath))) {
        failures.push(`${href}: missing ${sourcePath}`)
      }
    }

    expect(failures).toEqual([])
  })

  it("requires a checked valid last-modified value", () => {
    const page = resolveStaticSeoPage(GETTING_STARTED_PATH)
    expect(page).toBeDefined()
    if (!page) throw new Error("Getting Started SEO page is not registered")

    const registrySource = readFileSync(resolve(seoDirectory, "registry.ts"), "utf8")
    expect(registrySource).not.toContain("as string")
    expect(page.lastModified).toBe("2026-08-25T19:40:17.000Z")
    expect(Number.isNaN(Date.parse(page.lastModified))).toBe(false)
    expect(techArticleJsonLd(page).dateModified).toBe(page.lastModified)
  })

  it("fails closed when a last-modified value is missing or invalid", () => {
    expect(() => requireValidLastModified({}, GETTING_STARTED_PATH)).toThrow(
      `Missing or invalid last-modified date for ${GETTING_STARTED_PATH}`,
    )
    expect(() =>
      requireValidLastModified({ [GETTING_STARTED_PATH]: "not-an-ISO-date" }, GETTING_STARTED_PATH),
    ).toThrow(`Missing or invalid last-modified date for ${GETTING_STARTED_PATH}`)
  })

  it("marks the registry as server-only", () => {
    const registrySource = readFileSync(resolve(seoDirectory, "registry.ts"), "utf8")

    expect(registrySource).toMatch(/^import ["']server-only["']/m)
  })

  it("renders structured data for registered docs routes only", () => {
    function Content() {
      return createElement("h1", null, "Docs page")
    }

    const registered = renderToStaticMarkup(
      createElement(DocsPage, { href: GETTING_STARTED_PATH, Content }),
    )
    const secondRegistered = renderToStaticMarkup(
      createElement(DocsPage, { href: "/docs/agents", Content }),
    )
    const unregistered = renderToStaticMarkup(
      createElement(DocsPage, { href: "/unregistered", Content }),
    )

    expect(registered).toContain('type="application/ld+json"')
    expect(registered).toContain('"@type":"TechArticle"')
    expect(registered).toContain('"@type":"BreadcrumbList"')
    expect(secondRegistered).toContain('"@type":"TechArticle"')
    expect(secondRegistered).toContain('"@type":"BreadcrumbList"')
    expect(unregistered).not.toContain('type="application/ld+json"')
  })
})

describe("JsonLd", () => {
  it("renders JSON-LD with less-than signs escaped", () => {
    const html = renderToStaticMarkup(
      createElement(JsonLd, { data: { value: "</script><script>alert(1)</script>" } }),
    )

    expect(html).toContain('type="application/ld+json"')
    expect(html).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>")
    expect(html).not.toContain("</script><script>")
  })
})
