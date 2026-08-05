import { cva, type VariantProps } from "class-variance-authority"
import type { HTMLAttributes } from "react"
import { twMerge } from "tailwind-merge"

const badge = cva("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      active: "bg-green-100 text-green-800",
      candidate: "bg-amber-100 text-amber-800",
      superseded: "bg-zinc-100 text-zinc-500 line-through",
      danger: "bg-red-100 text-red-800",
      neutral: "border border-zinc-200 bg-white text-zinc-600",
    },
  },
  defaultVariants: { variant: "neutral" },
})

export function Badge({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={twMerge(badge({ variant }), className)} {...props} />
}
