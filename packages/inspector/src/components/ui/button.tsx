import { cva, type VariantProps } from "class-variance-authority"
import type { ButtonHTMLAttributes } from "react"
import { twMerge } from "tailwind-merge"

const button = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none h-9 px-4",
  {
    variants: {
      variant: {
        default: "bg-zinc-900 text-white hover:bg-zinc-700",
        outline: "border border-zinc-200 bg-white hover:bg-zinc-50",
        destructive: "border border-red-200 bg-white text-red-700 hover:bg-red-50",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

export function Button({
  className,
  variant,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button className={twMerge(button({ variant }), className)} {...props} />
}
