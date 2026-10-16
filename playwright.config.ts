import { defineConfig, devices } from "@playwright/test";
import { DEMO_PORT as PORT } from "./demo/port.ts";

// e2e on the demo page; `pnpm test:e2e` builds it first
export default defineConfig({
  testDir: "e2e",
  testIgnore: "**/.generated/**",
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}/`, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "node demo/serve.ts",
    url: `http://127.0.0.1:${PORT}/`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
});
