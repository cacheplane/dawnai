import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: resolve(rootDir, "../.."),
	test: {
		environment: "node",
		env: {
			GH_TOKEN: "",
			GITHUB_TOKEN: "",
			NODE_AUTH_TOKEN: "",
			NPM_TOKEN: "",
		},
		fileParallelism: false,
		hookTimeout: 30_000,
		include: [
			"test/security-dependencies/**/*.test.ts",
			"test/security-dependencies/**/*.test.tsx",
		],
		testTimeout: 30_000,
	},
});
