import createMDX from "@next/mdx"
import type { NextConfig } from "next"
import { MDX_REHYPE_PLUGINS, MDX_REMARK_PLUGINS } from "./lib/mdx-plugins"

const nextConfig: NextConfig = {
  experimental: { useTypeScriptCli: true },
  reactStrictMode: true,
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  typescript: { tsconfigPath: "./tsconfig.build.json" },
}

const withMDX = createMDX({
  options: {
    // Turbopack requires serializable plugin references — see lib/mdx-plugins.ts
    remarkPlugins: MDX_REMARK_PLUGINS,
    rehypePlugins: MDX_REHYPE_PLUGINS,
  },
})

export default withMDX(nextConfig)
