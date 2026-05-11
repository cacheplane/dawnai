"use client"

import { usePathname } from "next/navigation"
import type { ReactNode } from "react"

export function CreamSurface({ children }: { readonly children: ReactNode }) {
  const isLanding = usePathname() === "/"
  return (
    <div className={isLanding ? "" : "bg-bg-primary text-text-primary min-h-screen"}>
      {children}
    </div>
  )
}
