import { copyFile, readFile, writeFile } from "node:fs/promises";
import { defineConfig, type Options } from "tsup";
import { sdkDefine } from "./define.config.ts";

// the player of the recorder's own version goes into the package: a test
// attachment plays offline, with nothing fetched at view time
const PLAYER = "node_modules/@rrweb/replay/dist/";
const bundlePlayer = async () => {
  const script = await readFile(`${PLAYER}replay.umd.min.cjs`, "utf8");
  await writeFile(
    "dist/rrweb-replay.js",
    script.replace(/^\/\/# sourceMappingURL=.*$/gm, ""),
  );
  await copyFile(`${PLAYER}style.css`, "dist/rrweb-replay.css");
};

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
  // the same build as a classic script: the Playwright fixture injects it
  // into every page before the page's own scripts
  {
    ...shared,
    entry: { rewindbug: "src/index.ts" },
    format: ["iife"],
    globalName: "rewindbug",
    minify: true,
    sourcemap: false,
    noExternal: [/.*/],
  },
  {
    entry: { playwright: "src/playwright/index.ts" },
    // Playwright compiles specs to CommonJS unless the project is a module
    format: ["esm", "cjs"],
    shims: true,
    target: "node18",
    platform: "node",
    dts: true,
    external: ["@playwright/test"],
    onSuccess: bundlePlayer,
  },
]);
