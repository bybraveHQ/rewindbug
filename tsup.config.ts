import { defineConfig, type Options } from "tsup";
import { sdkDefine } from "./define.config.ts";

const shared: Options = {
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  sourcemap: true,
  treeshake: true,
  define: sdkDefine,
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    dts: true,
    clean: true,
  },
  // for a page without a bundler: rrweb inside, one file to import from a CDN
  {
    ...shared,
    entry: { "rewindbug.browser": "src/index.ts" },
    minify: true,
    noExternal: [/.*/],
  },
]);
