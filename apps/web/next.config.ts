import createMDX from "@next/mdx"
import type { NextConfig } from "next"
import { MDX_REHYPE_PLUGINS, MDX_REMARK_PLUGINS } from "./lib/mdx-plugins"

const nextConfig: NextConfig = {
  experimental: { useTypeScriptCli: true },
  reactStrictMode: true,
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  typescript: { tsconfigPath: "./tsconfig.build.json" },
  async redirects() {
    // Next removes trailing slashes. An explicit file URL keeps the portable
    // identity page's relative assets working on the site and in the ZIP.
    return [
      {
        source: "/brand/identity",
        destination: "/brand/identity/index.html",
        permanent: true,
      },
    ]
  },
}

const withMDX = createMDX({
  options: {
    // Turbopack requires serializable plugin references — see lib/mdx-plugins.ts
    remarkPlugins: MDX_REMARK_PLUGINS,
    rehypePlugins: MDX_REHYPE_PLUGINS,
  },
})

export default withMDX(nextConfig)
