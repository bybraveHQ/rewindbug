import { expect, test, vi } from "vitest";
import type { Report } from "../types.ts";
import { capture, initDownload } from "./index.ts";
import { MAX_DOWNLOADS, fileName } from "./save.ts";

vi.mock("../report/player.ts", () => ({
  player: { script: "window.rrwebReplay = {};", style: "" },
}));

const POLL_MS = 10;
const WAIT_MS = 3000;
// more than the cap of ten
const DIFFERENT_ERRORS = 15;
const LETTER_A = 97;

type Saved = { name: string; html: Promise<string> };
const saved: Saved[] = [];
const blobs = new Map<string, Blob>();
const realCreate = URL.createObjectURL.bind(URL);
vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
  const url = realCreate(blob);
  if (blob instanceof Blob) blobs.set(url, blob);
  return url;
});
vi.spyOn(HTMLAnchorElement.prototype, "dispatchEvent").mockImplementation(
  function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href);
    if (blob) saved.push({ name: this.download, html: blob.text() });
    return true;
  },
);
const fetches = vi.spyOn(window, "fetch");
const appClicks = vi.fn();
document.addEventListener("click", appClicks);

const until = async (check: () => boolean) => {
  const deadline = performance.now() + WAIT_MS;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
};

expect(
  initDownload({
    beforeSend: (report) =>
      report.trigger.message.includes("private") ? null : report,
  }),
).toBe(true);

test("a report downloads as a page, with nothing sent", async () => {
  capture(new Error("checkout broke"));
  await until(() => saved.length === 1);
  const [file] = saved;
  expect(file?.name).toMatch(
    /^rewindbug-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.html$/,
  );
  const html = await file?.html;
  expect(html).toContain("<title>checkout broke</title>");
  expect(html).toContain('<script id="report" type="application/json">');
  expect(fetches).not.toHaveBeenCalled();
  expect(appClicks).not.toHaveBeenCalled();
});

test("the app's beforeSend still drops a report", async () => {
  capture(new Error("private data"));
  capture(new Error("after the dropped one"));
  await until(() => saved.length === 2);
  expect(await saved[1]?.html).toContain("after the dropped one");
});

test("a page that keeps breaking stops downloading at the cap", async () => {
  for (let i = 0; i < DIFFERENT_ERRORS; i++)
    // letters, not digits: digits in a message do not change its fingerprint
    capture(new Error(`break ${String.fromCharCode(LETTER_A + i)}`));
  await until(() => saved.length === MAX_DOWNLOADS);
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 10));
  expect(saved).toHaveLength(MAX_DOWNLOADS);
});

test("the file name carries the report time", () => {
  expect(
    fileName({ createdAt: Date.UTC(2026, 9, 18, 9, 5, 7, 12) } as Report),
  ).toBe("rewindbug-2026-10-18T09-05-07-012Z.html");
});
