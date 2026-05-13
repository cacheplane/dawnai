import { Eyebrow } from "../ui/Eyebrow"
import { ProviderMark } from "../ui/ProviderMark"

interface CategoryItem {
  readonly name: string
  readonly href?: string | undefined
  readonly logoSrc?: string | undefined
  readonly logoIsWordmark?: boolean | undefined
}

interface Category {
  readonly label: string
  readonly items: ReadonlyArray<CategoryItem>
}

const CATEGORIES: readonly Category[] = [
  {
    label: "Models",
    items: [
      {
        name: "OpenAI",
        href: "https://openai.com",
        logoSrc: "/logos/providers/openai.svg",
      },
      {
        name: "Anthropic",
        href: "https://www.anthropic.com",
        logoSrc: "/logos/providers/anthropic.svg",
      },
      {
        name: "Google",
        href: "https://ai.google.dev",
        logoSrc: "/logos/providers/google.svg",
      },
      { name: "Mistral", href: "https://mistral.ai" },
      {
        name: "Ollama",
        href: "https://ollama.com",
        logoSrc: "/logos/providers/ollama.svg",
        logoIsWordmark: true,
      },
      { name: "Any LangGraph-compatible model" },
    ],
  },
  {
    label: "Observability",
    items: [
      { name: "LangSmith", href: "https://smith.langchain.com" },
      { name: "OpenTelemetry", href: "https://opentelemetry.io" },
    ],
  },
  {
    label: "Vector stores",
    items: [
      { name: "Pinecone", href: "https://www.pinecone.io" },
      { name: "Qdrant", href: "https://qdrant.tech" },
      { name: "Weaviate", href: "https://weaviate.io" },
      { name: "pgvector", href: "https://github.com/pgvector/pgvector" },
    ],
  },
  {
    label: "Deploy targets",
    items: [
      { name: "Vercel", href: "https://vercel.com" },
      { name: "Cloudflare Workers", href: "https://workers.cloudflare.com" },
      { name: "Node", href: "https://nodejs.org" },
      { name: "Docker", href: "https://www.docker.com" },
    ],
  },
]

export function Ecosystem() {
  return (
    <section className="bg-page border-b border-divider">
      <div className="max-w-[1200px] mx-auto px-6 md:px-8 py-20 md:py-28">
        <Eyebrow>Ecosystem</Eyebrow>
        <h2
          className="font-display font-semibold text-ink mt-3 text-[32px] leading-[38px] md:text-[44px] md:leading-[50px]"
          style={{
            fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
            letterSpacing: "-0.01em",
          }}
        >
          Plays well with your stack.
        </h2>
        <p className="mt-5 text-base text-ink-muted leading-[26px] max-w-[58ch]">
          Anything LangGraph.js supports, Dawn supports. Bring your own models, observability,
          vector storage, and deployment target.
        </p>

        <div className="mt-12 grid sm:grid-cols-2 lg:grid-cols-4 gap-x-10 gap-y-10">
          {CATEGORIES.map((cat) => (
            <div key={cat.label}>
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-dim">
                {cat.label}
              </p>
              <ul className="mt-4 space-y-2">
                {cat.items.map((item) => (
                  <li key={item.name}>
                    <ProviderMark
                      name={item.name}
                      {...(item.href ? { href: item.href } : {})}
                      {...(item.logoSrc ? { logoSrc: item.logoSrc } : {})}
                      {...(item.logoIsWordmark ? { logoIsWordmark: true } : {})}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
