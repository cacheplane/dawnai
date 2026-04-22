import type { MDXComponents } from "mdx/types"
import { Callout } from "./app/components/mdx/Callout"
import { Step, Steps } from "./app/components/mdx/Steps"
import { Tab, Tabs } from "./app/components/mdx/Tabs"

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    Callout,
    Steps,
    Step,
    Tabs,
    Tab,
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
    code: ({ children }) => (
      <code className="bg-bg-card border border-border rounded px-1.5 py-0.5 text-sm font-mono text-text-secondary">
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="bg-bg-card border border-border rounded-lg p-4 overflow-x-auto mb-4 text-sm font-mono leading-relaxed">
        {children}
      </pre>
    ),
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
    strong: ({ children }) => (
      <strong className="text-text-primary font-semibold">{children}</strong>
    ),
    table: ({ children }) => (
      <div className="my-6 overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-bg-card">{children}</thead>,
    tbody: ({ children }) => (
      <tbody className="[&>tr]:border-t [&>tr]:border-border-subtle">{children}</tbody>
    ),
    tr: ({ children }) => <tr>{children}</tr>,
    th: ({ children }) => (
      <th className="text-left px-4 py-2 text-xs font-semibold text-text-secondary uppercase tracking-wide">
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
