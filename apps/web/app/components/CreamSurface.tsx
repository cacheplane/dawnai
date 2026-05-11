"use client"

import { usePathname } from "next/navigation"
import type { ReactNode } from "react"

export function CreamSurface({ children }: { readonly children: ReactNode }) {
  const isLanding = usePathname() === "/"
  return (
    <div className={isLanding ? "h-full" : "bg-bg-primary text-text-primary h-full"}>
      {children}
    </div>
  )
}
