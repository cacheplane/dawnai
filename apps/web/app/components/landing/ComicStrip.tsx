import Image from "next/image"

interface Panel {
  readonly speaker: "Dev A" | "Dev B"
  readonly line: string
  readonly src: string
  readonly alt: string
}

const PANELS: readonly Panel[] = [
  {
    speaker: "Dev A",
    line: "Fifth StateGraph this month.",
    src: "/comic/panel-1.png",
    alt: "Developer at a cluttered desk, frowning at a monitor full of code, hand on chin.",
  },
  {
    speaker: "Dev A",
    line: "This isn't agent code. This is project structure.",
    src: "/comic/panel-2.png",
    alt: "Same developer slumped forward with both hands pressed against their temples, the monitor still cluttered.",
  },
  {
    speaker: "Dev B",
    line: "You know Next.js, right? Same thing for LangGraph.",
    src: "/comic/panel-3.png",
    alt: "A second developer in a mustard hoodie walks in with a coffee mug, leaning toward the first developer's screen with a small smile.",
  },
  {
    speaker: "Dev A",
    line: "…wait, that's it?",
    src: "/comic/panel-4.png",
    alt: "The first developer sits upright, wide-eyed in surprise, the monitor now showing a clean three-line file tree.",
  },
]

export function ComicStrip() {
  return (
    <section className="relative py-20 px-8">
      <div className="text-center max-w-2xl mx-auto mb-12">
        <p className="landing-text-muted text-xs uppercase tracking-widest mb-3 inline-flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-accent-amber" aria-hidden />
          Meanwhile…
        </p>
      </div>

      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {PANELS.map((p) => (
          <div
            key={p.line}
            className="landing-surface border border-border-subtle rounded-lg overflow-hidden"
          >
            <div className="aspect-square relative bg-bg-card">
              <Image
                src={p.src}
                alt={p.alt}
                fill
                sizes="(min-width: 1024px) 25vw, (min-width: 768px) 50vw, 100vw"
                className="object-cover"
              />
            </div>
            <div className="p-5">
              <p className="text-sm leading-relaxed">
                <strong className="text-text-primary font-medium">{p.speaker}:</strong>{" "}
                <span className="landing-text-muted">{p.line}</span>
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
