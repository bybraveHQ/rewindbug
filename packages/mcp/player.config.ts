import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// the rrweb player goes into dist/cli.js as text: the screenshot page plays a
// report with no network and no second package. Shared by tsup and vitest
const PLAYER = fileURLToPath(
  new URL("../../node_modules/@rrweb/replay/dist/", import.meta.url),
);

export const playerDefine = {
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
