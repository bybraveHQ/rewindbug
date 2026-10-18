import { readFileSync } from "node:fs";
import { defineConfig, type Options } from "tsup";
import { sdkDefine } from "./define.config.ts";

// the player of the recorder's own version goes into the package as one
// module, dist/player.js: a test attachment or a downloaded report plays
// offline, with nothing fetched at view time
const PLAYER = "node_modules/@rrweb/replay/dist/";
const playerDefine = {
  __RRWEB_PLAYER_SCRIPT__: JSON.stringify(
    readFileSync(`${PLAYER}replay.umd.min.cjs`, "utf8").replace(
      /^\/\/# sourceMappingURL=.*$/gm,
      "",
    ),
  ),
  __RRWEB_PLAYER_STYLE__: JSON.stringify(
    readFileSync(`${PLAYER}style.css`, "utf8"),
  ),
};
// the builds that use the player import that one module next to them
// instead of bundling a copy each
const externalPlayer: NonNullable<Options["esbuildPlugins"]>[number] = {
  name: "external-player",
  setup(build) {
    build.onResolve({ filter: /[\\/]player\.ts$/ }, () => ({
      path: "./player.js",
      external: true,
    }));
  },
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
    ...shared,
    entry: { player: "src/report/player.ts" },
    minify: true,
    sourcemap: false,
    define: playerDefine,
  },
  // reports as files, for a page with no server
  {
    ...shared,
    entry: { download: "src/download/index.ts" },
    dts: true,
    // its map would repeat the core's and double the package
    sourcemap: false,
    esbuildPlugins: [externalPlayer],
  },
  {
    ...shared,
    entry: { "download.browser": "src/download/index.ts" },
    minify: true,
    sourcemap: false,
    noExternal: [/.*/],
    esbuildPlugins: [externalPlayer],
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
    esbuildPlugins: [externalPlayer],
  },
]);
