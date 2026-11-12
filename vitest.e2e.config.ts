import { defineConfig } from "vitest/config";

// End-to-end tests (tests/e2e): the app driven over WebDriver. `npm run test:e2e`
// builds it with its test hooks first. Linux needs a display and the WebKitGTK
// driver: `xvfb-run -a npm run test:e2e` with webkit2gtk-driver installed.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/e2e/setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: process.env.CI ? 1 : 0,
    // In CI, report each test as it finishes; the default waits for a whole file.
    reporters: process.env.CI ? ["verbose"] : ["default"],
  },
});
