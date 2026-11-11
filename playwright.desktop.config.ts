import { defineConfig } from "@playwright/test";

// Drives the Electron shell. Needs a display: on Linux CI run under `xvfb-run -a`.
// Set PALIMPSEST_EXE to test a packaged build instead of `electron .`.
export default defineConfig({
  testDir: "tests/desktop",
  timeout: 45_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
});
