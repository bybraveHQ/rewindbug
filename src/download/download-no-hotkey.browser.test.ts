import { expect, test, vi } from "vitest";
import { download, initDownload } from "./index.ts";
import { catchDownloads, hotkey, sleep } from "./saved.test-helper.ts";

vi.mock("../report/player.ts", () => ({
  player: { script: "window.rrwebReplay = {};", style: "" },
}));

const QUIET_MS = 300;

const saved = catchDownloads();

test("download() before init saves nothing", async () => {
  expect(await download()).toBe(false);
  expect(saved).toHaveLength(0);
});

test("with hotkey: false the keys do nothing", async () => {
  expect(initDownload({ hotkey: false })).toBe(true);
  hotkey();
  await sleep(QUIET_MS);
  expect(saved).toHaveLength(0);
});

test("with no report yet, download() captures the moment", async () => {
  expect(await download()).toBe(true);
  expect(saved).toHaveLength(1);
  expect(await saved[0]?.html).toContain("<title>manual capture</title>");
});
