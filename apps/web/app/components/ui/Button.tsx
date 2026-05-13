import Link from "next/link"
import type { ComponentPropsWithoutRef, ReactNode } from "react"

type ButtonVariant = "primary" | "secondary"

interface BaseProps {
  readonly variant?: ButtonVariant
  readonly children: ReactNode
}

type ButtonAsLink = BaseProps & {
  readonly href: string
  readonly external?: boolean
} & Omit<ComponentPropsWithoutRef<"a">, "href" | "children">

type ButtonAsButton = BaseProps & {
  readonly href?: undefined
} & Omit<ComponentPropsWithoutRef<"button">, "children">

export type ButtonProps = ButtonAsLink | ButtonAsButton

const baseClasses =
  "inline-flex items-center gap-1.5 font-medium text-sm rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-page focus-visible:ring-divider-strong"

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "px-4 py-2 bg-accent-saas text-accent-saas-ink hover:opacity-90 active:opacity-80",
  secondary:
    "px-4 py-2 text-ink hover:text-accent-saas border border-divider hover:border-divider-strong bg-page",
}

export function Button(props: ButtonProps) {
  const variant = props.variant ?? "primary"
  const className = `${baseClasses} ${variantClasses[variant]}`

  if (props.href !== undefined) {
    const { href, external, children, variant: _v, ...rest } = props as ButtonAsLink & Record<string, unknown>
    if (external) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={className}
          {...(rest as Record<string, unknown>)}
        >
          {children}
        </a>
      )
    }
    return (
      <Link href={href} className={className} {...(rest as Record<string, unknown>)}>
        {children}
      </Link>
    )
  }

  const { children, variant: _v, ...rest } = props as ButtonAsButton & Record<string, unknown>
  return (
    <button type="button" className={className} {...(rest as Record<string, unknown>)}>
      {children}
    </button>
  )
}
