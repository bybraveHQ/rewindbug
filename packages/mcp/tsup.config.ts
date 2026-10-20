import { defineConfig } from "tsup";
import { playerDefine } from "./player.config.ts";

export default defineConfig({
  // the CLI, and the renderer for examples/endpoint and other receivers
  entry: ["src/cli.ts", "src/screenshot.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  define: playerDefine,
});
