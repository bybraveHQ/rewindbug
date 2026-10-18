import type { Player } from "./page.ts";

// a module of its own, dist/player.js: it loads at the first report or
// attachment, not with the page or the test runner
export const player: Player = {
  script: __RRWEB_PLAYER_SCRIPT__,
  style: __RRWEB_PLAYER_STYLE__,
};
