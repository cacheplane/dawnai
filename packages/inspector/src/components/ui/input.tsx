import type { InputHTMLAttributes } from "react"
import { twMerge } from "tailwind-merge"

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={twMerge(
        "h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-300",
        className,
      )}
      {...props}
    />
  )
}
