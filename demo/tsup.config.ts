import { defineConfig } from "tsup";
import { sdkDefine } from "../define.config.ts";

// a static page: the package and rrweb are bundled in, public/ is copied.
// No shared chunks: a classic service worker cannot import one
export default defineConfig({
  entry: { main: "demo/main.ts", sw: "demo/sw.ts" },
  outDir: "demo/dist",
  publicDir: "demo/public",
  format: ["esm"],
  splitting: false,
  target: "es2022",
  platform: "browser",
  clean: true,
  minify: true,
  sourcemap: true,
  define: sdkDefine,
  noExternal: [/.*/],
});
