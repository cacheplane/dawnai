import type { Metadata } from "next"
import { Accordion } from "../components/ui/Accordion"
import { Button } from "../components/ui/Button"
import { Card } from "../components/ui/Card"
import { CodeFrame } from "../components/ui/CodeFrame"
import { Eyebrow } from "../components/ui/Eyebrow"
import { ProviderMark } from "../components/ui/ProviderMark"
import { StarBadge } from "../components/ui/StarBadge"

export const metadata: Metadata = {
  title: "Brand",
  description: "Dawn brand and design system.",
}

interface SwatchProps {
  readonly name: string
  readonly token: string
  readonly value: string
}

function Swatch({ name, token, value }: SwatchProps) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span
        className="inline-block w-10 h-10 rounded-md border border-divider"
        style={{ backgroundColor: value }}
        aria-hidden="true"
      />
      <div className="flex flex-col">
        <span className="text-sm text-ink font-medium">{name}</span>
        <span className="text-xs text-ink-muted font-mono">{token}</span>
        <span className="text-xs text-ink-dim font-mono">{value}</span>
      </div>
    </div>
  )
}

const SWATCHES: readonly SwatchProps[] = [
  { name: "Page", token: "--color-page", value: "#ffffff" },
  { name: "Surface", token: "--color-surface", value: "#fafaf7" },
  { name: "Surface (sunk)", token: "--color-surface-sunk", value: "#f4f2ec" },
  { name: "Ink", token: "--color-ink", value: "#14110d" },
  { name: "Ink (muted)", token: "--color-ink-muted", value: "#5a554c" },
  { name: "Ink (dim)", token: "--color-ink-dim", value: "#8a857b" },
  { name: "Divider", token: "--color-divider", value: "#e6e3da" },
  { name: "Divider (strong)", token: "--color-divider-strong", value: "#cfcabd" },
  { name: "Accent", token: "--color-accent-saas", value: "#b45309" },
  { name: "Accent (soft)", token: "--color-accent-saas-soft", value: "#fef3c7" },
]

export default function BrandPage() {
  return (
    <div className="bg-page">
      <div className="max-w-[1100px] mx-auto px-6 md:px-8 py-16 md:py-24">
        <section className="mb-16 md:mb-24">
          <Eyebrow>Design system · v2 (in progress)</Eyebrow>
          <h1
            className="font-display text-[56px] leading-[60px] md:text-[72px] md:leading-[76px] font-semibold text-ink mt-3"
            style={{
              fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
              letterSpacing: "-0.01em",
            }}
          >
            Dawn brand.
          </h1>
          <p className="text-lg text-ink-muted mt-5 max-w-2xl leading-relaxed">
            The visual language for Dawn — a restrained, infrastructure-grade system built on
            off-white surfaces, near-black ink, and a single amber accent. This page is the source
            of truth as the SaaS rebrand lands across the site.
          </p>
        </section>

        <section className="mb-16 md:mb-24">
          <Eyebrow>Color</Eyebrow>
          <h2 className="font-display text-3xl md:text-4xl font-semibold text-ink mt-2 mb-6">
            Tokens
          </h2>
          <Card className="p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-1">
              {SWATCHES.map((s) => (
                <Swatch key={s.token} {...s} />
              ))}
            </div>
          </Card>
        </section>

        <section className="mb-16 md:mb-24">
          <Eyebrow>Type</Eyebrow>
          <h2 className="font-display text-3xl md:text-4xl font-semibold text-ink mt-2 mb-6">
            Scale
          </h2>
          <Card className="p-6 space-y-6 overflow-hidden">
            <div>
              <p className="text-xs text-ink-dim font-mono mb-1">
                Display XL · Fraunces 600 · 72/76
              </p>
              <p
                className="font-display text-[48px] leading-[52px] sm:text-[72px] sm:leading-[76px] font-semibold text-ink break-words"
                style={{
                  fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0",
                  letterSpacing: "-0.01em",
                }}
              >
                Build LangGraph agents.
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-dim font-mono mb-1">H1 · Fraunces 600 · 40/44</p>
              <p
                className="font-display text-[40px] leading-[44px] font-semibold text-ink"
                style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50, 'WONK' 0" }}
              >
                Routes for agents, not just pages.
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-dim font-mono mb-1">Body L · Inter 400 · 18/30</p>
              <p className="text-lg text-ink leading-[30px] max-w-2xl">
                Dawn adds file-system routing, route-local tools, generated types, and HMR to your
                existing LangGraph.js stack.
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-dim font-mono mb-1">Body · Inter 400 · 16/26</p>
              <p className="text-base text-ink leading-[26px] max-w-2xl">
                Keep the runtime. Drop the boilerplate.
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-dim font-mono mb-1">Small · Inter 400 · 14/22</p>
              <p className="text-sm text-ink-muted leading-[22px] max-w-2xl">
                Production caveats, links, and supporting copy live at this size.
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-dim font-mono mb-1">
                Code · JetBrains Mono 400 · 14/22
              </p>
              <code className="text-sm text-ink font-mono">pnpm create dawn-ai-app my-agent</code>
            </div>
          </Card>
        </section>

        <section className="mb-16 md:mb-24">
          <Eyebrow>Primitives</Eyebrow>
          <h2 className="font-display text-3xl md:text-4xl font-semibold text-ink mt-2 mb-6">
            Components
          </h2>

          <div className="space-y-6">
            <Card className="p-6">
              <p className="text-xs text-ink-dim font-mono mb-3">Button</p>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" href="/docs/getting-started">
                  Read the docs
                </Button>
                <Button variant="secondary" href="https://github.com/cacheplane/dawnai" external>
                  Star on GitHub
                </Button>
              </div>
            </Card>

            <Card className="p-6">
              <p className="text-xs text-ink-dim font-mono mb-3">StarBadge</p>
              <StarBadge />
            </Card>

            <Card className="p-6">
              <p className="text-xs text-ink-dim font-mono mb-3">ProviderMark</p>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <ProviderMark name="OpenAI" href="https://openai.com" />
                <ProviderMark name="Anthropic" href="https://www.anthropic.com" />
                <ProviderMark name="Google" />
                <ProviderMark name="Ollama" />
              </div>
            </Card>

            <Card className="p-6">
              <p className="text-xs text-ink-dim font-mono mb-3">CodeFrame</p>
              <CodeFrame label="src/app/(public)/support/index.ts">
                <pre className="m-0 px-4 py-4 text-sm font-mono text-ink leading-[22px] overflow-x-auto">
                  {`import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "openai:gpt-4o-mini",
  systemPrompt: "Answer for {tenant}.",
})`}
                </pre>
              </CodeFrame>
            </Card>

            <Card className="p-6">
              <p className="text-xs text-ink-dim font-mono mb-3">Accordion</p>
              <Accordion
                defaultOpenId="ex-1"
                items={[
                  {
                    id: "ex-1",
                    question: "What is this primitive used for?",
                    answer: (
                      <p>
                        The FAQ section on the rebranded landing page uses this primitive. It's
                        keyboard-accessible and respects prefers-reduced-motion.
                      </p>
                    ),
                  },
                  {
                    id: "ex-2",
                    question: "Can multiple items be open at once?",
                    answer: <p>No — only one item is open at a time by design.</p>,
                  },
                ]}
              />
            </Card>
          </div>
        </section>

        <section>
          <Eyebrow>Status</Eyebrow>
          <h2 className="font-display text-3xl md:text-4xl font-semibold text-ink mt-2 mb-3">
            Rebrand progress
          </h2>
          <p className="text-base text-ink-muted leading-relaxed max-w-2xl">
            This page reflects PR 1 of the SaaS-style rebrand: tokens, primitives, refreshed Header
            and Footer. The landing page, docs, and blog are migrated in subsequent PRs. See{" "}
            <a
              className="text-accent-saas hover:opacity-80"
              href="https://github.com/cacheplane/dawnai/pulls"
              target="_blank"
              rel="noopener noreferrer"
            >
              open PRs on GitHub
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  )
}
