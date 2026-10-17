import { defineConfig } from "tsup";
import { sdkDefine } from "../define.config.ts";

// the bench page loads one file over plain HTTP, so rrweb is bundled in
export default defineConfig({
  entry: { index: "src/index.ts", "rrweb-floor": "bench/rrweb-floor.ts" },
  outDir: "bench/dist",
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  clean: true,
  minify: true,
  define: sdkDefine,
  noExternal: [/.*/],
});
