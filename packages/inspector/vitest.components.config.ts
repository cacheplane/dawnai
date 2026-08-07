import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react()],
  test: {
    name: "inspector-components",
    environment: "jsdom",
    include: ["test/components/**/*.test.tsx"],
  },
})
