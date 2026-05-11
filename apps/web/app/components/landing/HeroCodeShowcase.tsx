"use client"

import { useRef, useState } from "react"
import { CodeHeaderRow, CopyButton, TabPill } from "../mdx/CodeBlock"

interface File {
  readonly label: string
  readonly html: string
  readonly raw: string
}

interface Props {
  readonly files: readonly File[]
  readonly defaultIndex?: number
}

export function HeroCodeShowcase({ files, defaultIndex = 0 }: Props) {
  const [active, setActive] = useState(defaultIndex)
  const [copied, setCopied] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const activeFile = files[active]
  if (!activeFile) return null

  const copy = async () => {
    await navigator.clipboard.writeText(activeFile.raw)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative mt-10 max-w-2xl mx-auto text-left">
      <div
        ref={containerRef}
        className="rounded-lg border border-border bg-bg-card overflow-hidden"
      >
        <CodeHeaderRow
          left={files.map((file, i) => (
            <TabPill
              key={file.label}
              label={file.label}
              active={i === active}
              onClick={() => setActive(i)}
            />
          ))}
          right={<CopyButton onCopy={copy} copied={copied} />}
        />
        <div
          className="text-[13px] leading-[1.55] font-mono overflow-x-auto [&_pre]:bg-transparent [&_pre]:m-0 [&_pre]:pl-3 [&_pre]:pr-4 [&_pre]:py-3"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is server-generated
          dangerouslySetInnerHTML={{ __html: activeFile.html }}
        />
      </div>
    </div>
  )
}
