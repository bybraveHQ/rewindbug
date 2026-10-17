import { defineConfig, devices } from "@playwright/test";
import { DEMO_PORT as PORT } from "./demo/port.ts";
import { FIXTURES_PORT } from "./e2e/fixtures/port.ts";

// e2e on the demo page and on fixture pages; `pnpm test:e2e` builds both first
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
  webServer: [
    {
      command: "node demo/serve.ts",
      url: `http://127.0.0.1:${PORT}/`,
      env: { PORT: String(PORT) },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "node e2e/fixtures/serve.ts",
      url: `http://127.0.0.1:${FIXTURES_PORT}/enter.html`,
      env: { PORT: String(FIXTURES_PORT) },
      reuseExistingServer: !process.env.CI,
    },
  ],
});
