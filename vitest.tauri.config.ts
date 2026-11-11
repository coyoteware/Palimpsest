import { defineConfig } from "vitest/config";

// Drives the Tauri shell over WebDriver (tests/tauri). `npm run test:tauri`
// builds the app with its test hooks first. Linux needs a display and the
// WebKitGTK driver: `xvfb-run -a npm run test:tauri` with webkit2gtk-driver installed.
export default defineConfig({
  test: {
    include: ["tests/tauri/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/tauri/setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: process.env.CI ? 1 : 0,
  },
});
