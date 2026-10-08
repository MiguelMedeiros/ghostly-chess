/**
 * Real-browser checks of the built page (test/browser/*.spec.ts): drag and drop with a mouse and a finger, the layout
 * at phone, Desktop and wide sizes, and the page inside a sandboxed frame under the web runner's CSP. Run
 * `npm run build` first; `npm run test:browser` does both.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // Locally, at most JOBS workers (default 2), as for Vitest.
  workers: process.env.CI ? undefined : Math.max(1, Number(process.env.JOBS) || 2),
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
