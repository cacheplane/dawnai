"use client"

import { type ReactNode, useState } from "react"

interface AccordionItem {
  readonly id: string
  readonly question: string
  readonly answer: ReactNode
}

interface AccordionProps {
  readonly items: readonly AccordionItem[]
  readonly defaultOpenId?: string
}

export function Accordion({ items, defaultOpenId }: AccordionProps) {
  const [openId, setOpenId] = useState<string | null>(defaultOpenId ?? null)

  return (
    <ul className="divide-y divide-divider border-y border-divider">
      {items.map((item) => {
        const isOpen = openId === item.id
        const panelId = `accordion-panel-${item.id}`
        const buttonId = `accordion-button-${item.id}`
        return (
          <li key={item.id}>
            <h3>
              <button
                id={buttonId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenId(isOpen ? null : item.id)}
                className="w-full flex items-center justify-between gap-4 py-5 text-left text-ink font-medium hover:text-accent-saas transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-divider-strong rounded"
              >
                <span>{item.question}</span>
                <span aria-hidden="true" className="text-ink-dim text-xl leading-none select-none">
                  {isOpen ? "−" : "+"}
                </span>
              </button>
            </h3>
            <section
              id={panelId}
              aria-labelledby={buttonId}
              hidden={!isOpen}
              className="pb-5 pr-8 text-ink-muted text-sm leading-relaxed"
            >
              {item.answer}
            </section>
          </li>
        )
      })}
    </ul>
  )
}
