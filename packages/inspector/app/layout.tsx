import "./globals.css"
import type { ReactNode } from "react"

export const metadata = { title: "Dawn Inspector" }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-zinc-800 antialiased">{children}</body>
    </html>
  )
}
