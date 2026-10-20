import { defineConfig } from "vitest/config";
import { playerDefine } from "./player.config.ts";

export default defineConfig({
  define: playerDefine,
  test: {
    name: "mcp",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
