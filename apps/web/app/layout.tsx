import type { Metadata } from "next"
import type { ReactNode } from "react"
import { Header } from "./components/Header"
import { Footer } from "./components/Footer"
import "./globals.css"

export const metadata: Metadata = {
  title: {
    default: "Dawn — The App Router for AI Agents",
    template: "%s | Dawn",
  },
  description:
    "A TypeScript-first framework for building and deploying graph-based AI systems with the ergonomics of Next.js.",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <div className="min-h-screen flex flex-col">
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </div>
      </body>
    </html>
  )
}
