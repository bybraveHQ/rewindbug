import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { sdkDefine } from "./define.config.ts";

export default defineConfig({
  define: sdkDefine,
  test: {
    passWithNoTests: true,
    projects: [
      "packages/mcp/vitest.config.ts",
      {
        test: {
          name: "unit",
          environment: "jsdom",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.browser.test.ts"],
        },
      },
      {
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
