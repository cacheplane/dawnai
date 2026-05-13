import Image from "next/image"
import Link from "next/link"

interface Props {
  readonly className?: string
  readonly imageClassName?: string
  /**
   * Logo color variant.
   * - `light` (default) — white logo, for use on dark backgrounds (header)
   * - `dark` — black logo, for use on light backgrounds (footer in daylight context)
   */
  readonly variant?: "light" | "dark"
}

export function BrandLogo({ className, imageClassName, variant = "light" }: Props) {
  const src =
    variant === "dark"
      ? "/brand/dawn-logo-horizontal-black.svg"
      : "/brand/dawn-logo-horizontal-white.svg"
  return (
    <Link
      href="/"
      className={`inline-flex items-center text-ink ${className ?? ""}`}
      aria-label="Dawn home"
    >
      <Image
        src={src}
        alt="Dawn"
        width={720}
        height={220}
        className={`block h-7 w-auto ${imageClassName ?? ""}`}
        priority
      />
    </Link>
  )
}
