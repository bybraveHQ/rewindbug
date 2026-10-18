import { expect, test, vi } from "vitest";
import type { Report } from "../types.ts";
import { MAX_KEPT, capture, download, initDownload, list } from "./index.ts";
import { fileName } from "./save.ts";
import { catchDownloads, hotkey, sleep, until } from "./saved.test-helper.ts";

vi.mock("../report/player.ts", () => ({
  player: { script: "window.rrwebReplay = {};", style: "" },
}));

// long enough for a download that was going to start on its own
const QUIET_MS = 300;
// more than the ten kept
const DIFFERENT_ERRORS = 15;
const LETTER_A = 97;

const saved = catchDownloads();
const fetches = vi.spyOn(window, "fetch");
const appClicks = vi.fn();
document.addEventListener("click", appClicks);

const reportsIn = async (index: number): Promise<Report[]> => {
  const html = (await saved[index]?.html) ?? "";
  const json =
    /<script id="reports" type="application\/json">(.*?)<\/script>/s.exec(
      html,
    )?.[1];
  return JSON.parse(json ?? "[]") as Report[];
};
const messages = async (index: number) =>
  (await reportsIn(index)).map((report) => report.trigger.message);

expect(
  initDownload({
    beforeSend: (report) =>
      report.trigger.message.includes("private") ? null : report,
  }),
).toBe(true);

test("an error downloads nothing on its own", async () => {
  capture(new Error("checkout broke"));
  await sleep(QUIET_MS);
  expect(saved).toHaveLength(0);
});

test("download() saves the reports as a page, sending nothing", async () => {
  expect(await download()).toBe(true);
  expect(saved).toHaveLength(1);
  expect(saved[0]?.name).toMatch(
    /^rewindbug-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.html$/,
  );
  expect(await saved[0]?.html).toContain("<title>checkout broke</title>");
  expect(await messages(0)).toEqual(["checkout broke"]);
  expect(fetches).not.toHaveBeenCalled();
  expect(appClicks).not.toHaveBeenCalled();
});

test("one file holds every report, the app's beforeSend still applies", async () => {
  capture(new Error("after the dropped one"));
  capture(new Error("private data"));
  await download();
  expect(await messages(1)).toEqual([
    "checkout broke",
    "after the dropped one",
  ]);
  expect(await saved[1]?.html).toContain(
    "<title>2 reports, newest: after the dropped one</title>",
  );
});

test("download(n) saves report n of list() alone", async () => {
  expect(await download(1)).toBe(true);
  expect(await messages(2)).toEqual(["checkout broke"]);
  for (const n of [0, -1, 1.5, 3])
    expect(await download(n), String(n)).toBe(false);
  expect(saved).toHaveLength(3);
});

test("list() prints the reports with their numbers", () => {
  const table = vi.spyOn(console, "table").mockImplementation(() => undefined);
  list();
  expect(table).toHaveBeenCalledWith([
    expect.objectContaining({
      n: 1,
      kind: "manual",
      message: "checkout broke",
    }),
    expect.objectContaining({ n: 2, message: "after the dropped one" }),
  ]);
});

test("the console gets rewindbug.list() and rewindbug.download()", () => {
  expect((window as { rewindbug?: unknown }).rewindbug).toEqual({
    list,
    download,
  });
});

test("Alt+Shift+R downloads every report", async () => {
  const before = saved.length;
  hotkey();
  await until(() => saved.length === before + 1);
  expect(await reportsIn(before)).toHaveLength(2);
});

test("the page keeps the newest ten", async () => {
  for (let i = 0; i < DIFFERENT_ERRORS; i++)
    // letters, not digits: digits in a message do not change its fingerprint
    capture(new Error(`break ${String.fromCharCode(LETTER_A + i)}`));
  await download();
  const kept = await messages(saved.length - 1);
  expect(kept).toHaveLength(MAX_KEPT);
  expect(kept.at(-1)).toBe(
    `break ${String.fromCharCode(LETTER_A + DIFFERENT_ERRORS - 1)}`,
  );
});

test("the file name carries the report time", () => {
  expect(
    fileName({ createdAt: Date.UTC(2026, 9, 18, 9, 5, 7, 12) } as Report),
  ).toBe("rewindbug-2026-10-18T09-05-07-012Z.html");
});
