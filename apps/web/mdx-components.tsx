import type { MDXComponents } from "mdx/types"

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: ({ children }) => (
      <h1 className="text-3xl font-bold text-text-primary mb-4">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-2xl font-bold text-text-primary mt-10 mb-4">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-lg font-semibold text-text-primary mt-8 mb-3">{children}</h3>
    ),
    p: ({ children }) => (
      <p className="text-text-secondary leading-7 mb-4">{children}</p>
    ),
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
    ...components,
  }
}
