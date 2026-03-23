import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@project-veritas/contracts": resolve(__dirname, "packages/contracts/src/index.ts"),
      "@project-veritas/config": resolve(__dirname, "packages/config/src/index.ts"),
      "@project-veritas/observability": resolve(__dirname, "packages/observability/src/index.ts")
    }
  },
  test: {
    environment: "node"
  }
});
