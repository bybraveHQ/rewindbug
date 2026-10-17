import { readFileSync } from "node:fs";

const version = (path: string): string =>
  (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;

// build-time constants for report.sdk, shared by tsup, the bench and vitest
export const sdkDefine = {
  __REWINDBUG_VERSION__: JSON.stringify(version("package.json")),
  __RRWEB_VERSION__: JSON.stringify(
    version("node_modules/@rrweb/record/package.json"),
  ),
};
