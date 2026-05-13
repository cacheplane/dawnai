import Link from "next/link"
import type { ReactNode } from "react"

type ButtonVariant = "primary" | "secondary"

interface BaseProps {
  readonly variant?: ButtonVariant
  readonly children: ReactNode
  readonly className?: string
  readonly id?: string
  readonly "aria-label"?: string
}

interface LinkButtonProps extends BaseProps {
  readonly href: string
  readonly external?: boolean
}

interface NativeButtonProps extends BaseProps {
  readonly href?: undefined
  readonly onClick?: () => void
  readonly disabled?: boolean
  readonly type?: "button" | "submit" | "reset"
}

export type ButtonProps = LinkButtonProps | NativeButtonProps

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
  const className = `${baseClasses} ${variantClasses[variant]} ${props.className ?? ""}`.trim()

  if (props.href !== undefined) {
    if (props.external === true) {
      return (
        <a
          href={props.href}
          target="_blank"
          rel="noopener noreferrer"
          className={className}
          id={props.id}
          aria-label={props["aria-label"]}
        >
          {props.children}
        </a>
      )
    }
    return (
      <Link
        href={props.href}
        className={className}
        id={props.id}
        aria-label={props["aria-label"]}
      >
        {props.children}
      </Link>
    )
  }

  return (
    <button
      type={props.type ?? "button"}
      onClick={props.onClick}
      disabled={props.disabled}
      className={className}
      id={props.id}
      aria-label={props["aria-label"]}
    >
      {props.children}
    </button>
  )
}
