import { readFileSync } from "node:fs";

// next to src/ in the repo and to dist/ in the published package
export const VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
