import Image from "next/image"
import Link from "next/link"

interface Props {
  readonly className?: string
  readonly imageClassName?: string
}

export function BrandLogo({ className, imageClassName }: Props) {
  return (
    <Link
      href="/"
      className={`inline-flex items-center text-text-primary ${className ?? ""}`}
      aria-label="Dawn home"
    >
      <Image
        src="/brand/dawn-logo-horizontal-white.svg"
        alt="Dawn"
        width={720}
        height={220}
        className={`block h-7 w-auto ${imageClassName ?? ""}`}
        priority
      />
    </Link>
  )
}
