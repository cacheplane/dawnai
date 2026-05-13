import type { Metadata } from "next"
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google"
import type { ReactNode } from "react"
import { CreamSurface } from "./components/CreamSurface"
import { Footer } from "./components/Footer"
import { Header } from "./components/Header"
import "./globals.css"

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
})

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  axes: ["opsz", "SOFT", "WONK"],
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
})

export const metadata: Metadata = {
  metadataBase: new URL("https://dawnai.org"),
  applicationName: "Dawn AI",
  title: {
    default: "Dawn — TypeScript meta-framework for LangGraph.js",
    template: "%s | Dawn",
  },
  description:
    "Dawn adds file-system routing, route-local tools, generated types, and HMR to your existing LangGraph.js stack. Keep the runtime. Drop the boilerplate.",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-48x48.png", sizes: "48x48", type: "image/png" },
      { url: "/favicon-64x64.png", sizes: "64x64", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    url: "https://dawnai.org",
    siteName: "Dawn AI",
    title: "Dawn — TypeScript meta-framework for LangGraph.js",
    description:
      "Dawn adds file-system routing, route-local tools, generated types, and HMR to your existing LangGraph.js stack. Keep the runtime. Drop the boilerplate.",
    images: [
      {
        url: "/social/dawn-og-white-on-black.png",
        width: 1024,
        height: 1024,
        alt: "Dawn AI",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "Dawn — TypeScript meta-framework for LangGraph.js",
    description:
      "Dawn adds file-system routing, route-local tools, generated types, and HMR to your existing LangGraph.js stack. Keep the runtime. Drop the boilerplate.",
    images: ["/social/dawn-og-white-on-black.png"],
  },
  appleWebApp: {
    title: "Dawn AI",
    capable: true,
    statusBarStyle: "black-translucent",
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${fraunces.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <div className="min-h-screen flex flex-col">
          <Header />
          <main className="flex-1">
            <CreamSurface>{children}</CreamSurface>
          </main>
          <Footer />
        </div>
      </body>
    </html>
  )
}
