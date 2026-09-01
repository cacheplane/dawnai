"use client"

import { useEffect, useRef, useState } from "react"
import type { DemoClip } from "../../lib/demo-media"

interface ClipPlayerProps {
  readonly clip: DemoClip
  readonly className?: string
}

function playVideo(video: HTMLVideoElement | null) {
  const result = video?.play()
  if (result) void result.catch(() => {})
}

export function ClipPlayer({ clip, className = "" }: ClipPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    setPrefersReducedMotion(reducedMotion)
    if (!reducedMotion) playVideo(videoRef.current)
  }, [])

  if (failed) {
    return (
      <div
        className={[
          "relative overflow-hidden rounded-xl border border-divider bg-surface-sunk",
          className,
        ].join(" ")}
      >
        {/* biome-ignore lint/performance/noImgElement: preserve the exact local video poster fallback */}
        <img src={clip.poster} alt={clip.ariaLabel} className="block h-auto w-full" />
        <div className="absolute inset-x-0 bottom-0 bg-page/95 px-4 py-3 text-sm text-ink-muted">
          Video unavailable.{" "}
          <a href={clip.transcript} className="font-medium text-ink underline underline-offset-4">
            Read the transcript
          </a>
          .
        </div>
      </div>
    )
  }

  return (
    <div className={["relative overflow-hidden rounded-xl bg-surface-sunk", className].join(" ")}>
      <video
        ref={videoRef}
        aria-label={clip.ariaLabel}
        poster={clip.poster}
        muted
        playsInline
        loop={!prefersReducedMotion}
        controls
        preload="metadata"
        onError={() => setFailed(true)}
        className="block h-auto w-full"
      >
        <source src={clip.webm} type="video/webm" />
        <source src={clip.mp4} type="video/mp4" />
      </video>
      {prefersReducedMotion ? (
        <button
          type="button"
          onClick={() => playVideo(videoRef.current)}
          className="absolute bottom-4 left-4 rounded-md border border-divider bg-page px-3 py-2 text-sm font-medium text-ink shadow-sm"
        >
          Play video
        </button>
      ) : null}
    </div>
  )
}
