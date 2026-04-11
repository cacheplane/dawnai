import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Dawn",
    template: "%s | Dawn",
  },
  description:
    "Dawn is a TypeScript-first application framework for graph-shaped agent systems.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="site-shell">
          <header className="site-header">
            <Link className="brand" href="/">
              <span className="brand-mark" aria-hidden="true">
                D
              </span>
              <span className="brand-copy">
                <strong>Dawn</strong>
                <span>Graph-shaped agent systems, with less ceremony.</span>
              </span>
            </Link>

            <nav className="site-nav" aria-label="Primary">
              <Link href="/">Home</Link>
              <Link href="/docs">Docs</Link>
              <Link href="/docs/getting-started">Getting Started</Link>
              <Link href="/docs/cli">CLI</Link>
            </nav>
          </header>

          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
