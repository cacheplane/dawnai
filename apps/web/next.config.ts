import createMDX from "@next/mdx"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactStrictMode: true,
  pageExtensions: ["ts", "tsx", "md", "mdx"],
}

const withMDX = createMDX({
  options: {
    // Turbopack requires serializable plugin references — pass as module-path strings
    remarkPlugins: [["remark-gfm", {}]],
  },
})

export default withMDX(nextConfig)
