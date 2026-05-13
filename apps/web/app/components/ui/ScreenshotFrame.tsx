import Image from "next/image"

interface ScreenshotFrameProps {
  readonly src: string
  readonly alt: string
  readonly width: number
  readonly height: number
  readonly caption?: string
  readonly label?: string
  readonly className?: string
}

/**
 * Image variant of CodeFrame — browser-chrome top bar plus a next/image inside.
 * Used for tooling screenshots (VS Code, terminal, file tree, etc.).
 */
export function ScreenshotFrame({
  src,
  alt,
  width,
  height,
  caption,
  label,
  className = "",
}: ScreenshotFrameProps) {
  return (
    <figure className={className}>
      <div
        className="rounded-xl border border-divider bg-page overflow-hidden"
        style={{
          boxShadow:
            "0 1px 2px rgba(20,17,13,0.04), 0 8px 24px -8px rgba(20,17,13,0.08)",
        }}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-divider bg-surface-sunk">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-divider-strong" />
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-divider-strong" />
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-divider-strong" />
          {label !== undefined ? (
            <span className="ml-3 text-xs text-ink-muted font-mono truncate">{label}</span>
          ) : null}
        </div>
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          className="block w-full h-auto"
        />
      </div>
      {caption !== undefined ? (
        <figcaption className="mt-2 text-xs text-ink-muted text-center">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  )
}
