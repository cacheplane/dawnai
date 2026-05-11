import type { MDXComponents } from "mdx/types"
import { RelatedCards } from "./app/components/docs/RelatedCards"
import { Callout } from "./app/components/mdx/Callout"
import { InlineCode, Pre, RehypeFigure } from "./app/components/mdx/CodeBlock"
import { CodeGroup } from "./app/components/mdx/CodeGroup"
import { Step, Steps } from "./app/components/mdx/Steps"
import { Tab, Tabs } from "./app/components/mdx/Tabs"

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    Callout,
    CodeGroup,
    Steps,
    Step,
    Tabs,
    Tab,
    RelatedCards,
    h1: ({ children }) => (
      <h1
        className="font-display text-4xl md:text-5xl font-semibold text-text-primary mb-6 tracking-tight"
        style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
      >
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2
        className="font-display text-2xl md:text-3xl font-semibold text-text-primary mt-10 mb-4 tracking-tight"
        style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
      >
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-lg font-semibold text-text-primary mt-8 mb-3">{children}</h3>
    ),
    p: ({ children }) => <p className="text-text-secondary leading-7 mb-4">{children}</p>,
    code: InlineCode,
    pre: Pre,
    figure: RehypeFigure,
    ul: ({ children }) => (
      <ul className="list-disc list-inside text-text-secondary leading-7 mb-4 space-y-1">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal list-inside text-text-secondary leading-7 mb-4 space-y-1">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="text-text-secondary">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-4 border-accent-amber-deep bg-bg-secondary px-5 py-3 my-6 text-text-secondary italic">
        {children}
      </blockquote>
    ),
    strong: ({ children }) => (
      <strong className="text-text-primary font-semibold">{children}</strong>
    ),
    table: ({ children }) => (
      <div className="my-6 overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-bg-secondary">{children}</thead>,
    tbody: ({ children }) => (
      <tbody className="[&>tr]:border-t [&>tr]:border-border-subtle">{children}</tbody>
    ),
    tr: ({ children }) => <tr>{children}</tr>,
    th: ({ children }) => (
      <th className="text-left px-4 py-2 text-xs font-semibold text-text-secondary uppercase tracking-wide bg-bg-secondary border-b border-border-subtle">
        {children}
      </th>
    ),
    td: ({ children }) => <td className="px-4 py-2 text-text-secondary align-top">{children}</td>,
    a: ({ children, href }) => (
      <a
        href={href}
        className="text-accent-amber hover:text-accent-amber-deep underline underline-offset-2 transition-colors"
      >
        {children}
      </a>
    ),
    ...components,
  }
}
