import type { ReactNode } from "react"
import "@copilotkit/react-core/v2/styles.css"

export const metadata = { title: "Dawn chat — CopilotKit + AG-UI" }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  )
}
