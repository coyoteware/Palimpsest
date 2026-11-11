import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 2048,
  },
  worker: { format: "es" },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
