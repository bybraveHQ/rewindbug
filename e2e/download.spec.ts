import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { Report } from "../src/types.ts";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const ORIGIN = "http://no-server.test";
const TYPED = "4242 4242 4242 4242";
// long enough for a download that was going to start on its own
const QUIET_MS = 1000;

// a page with no endpoint: reports wait in the page for the tester
const PAGE = `<!doctype html>
<label>Card <input id="card" /></label>
<button id="coupon">Apply coupon</button>
<button id="pay">Pay</button>
<script type="module">
  import { initDownload } from "${ORIGIN}/download.browser.js";
  window.started = initDownload();
  document.getElementById("coupon").onclick = () => {
    throw new Error("coupon broke");
  };
  document.getElementById("pay").onclick = () => {
    throw new Error("payment broke");
  };
</script>`;

const open = async (page: Page) => {
  const files = new Set(
    (await readdir(DIST)).filter((name) => name.endsWith(".js")),
  );
  await page.route(`${ORIGIN}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (!name) return route.fulfill({ contentType: "text/html", body: PAGE });
    if (files.has(name))
      return route.fulfill({
        contentType: "text/javascript",
        body: await readFile(`${DIST}${name}`),
      });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/`);
  await expect
    .poll(() => page.evaluate(() => (window as { started?: boolean }).started))
    .toBe(true);
};

test("the tester downloads every report as a page that plays offline", async ({
  page,
  browser,
}, testInfo) => {
  await open(page);
  await page.getByLabel("Card").fill(TYPED);
  let downloads = 0;
  page.on("download", () => (downloads += 1));
  await page.getByRole("button", { name: "Apply coupon" }).click();
  await page.getByRole("button", { name: "Pay" }).click();
  // the errors alone download nothing: a user of the app never gets a file
  await page.waitForTimeout(QUIET_MS);
  expect(downloads).toBe(0);
  const download = page.waitForEvent("download");
  await page.keyboard.press("Alt+Shift+KeyR");
  const file = testInfo.outputPath("reports.html");
  await (await download).saveAs(file);
  expect((await download).suggestedFilename()).toMatch(/^rewindbug-.*Z\.html$/);
  expect(downloads).toBe(1);

  const html = await readFile(file, "utf8");
  expect(html).not.toContain(TYPED);
  const viewing = await browser.newContext();
  const viewer = await viewing.newPage();
  // every request the page makes is listed: offline means none leaves file:
  const requests: string[] = [];
  viewer.on("request", (request) => {
    if (!request.url().startsWith("file:")) requests.push(request.url());
  });
  // Firefox and WebKit never fire load: the player's iframe stays open
  await viewer.goto(pathToFileURL(file).href, {
    waitUntil: "domcontentloaded",
  });
  const reports = JSON.parse(
    (await viewer.locator("#reports").textContent()) ?? "",
  ) as Report[];
  expect(reports.map((report) => report.trigger.message)).toEqual([
    "coupon broke",
    "payment broke",
  ]);
  expect(reports[1]?.replay?.events.length).toBeGreaterThan(0);
  const list = viewer
    .getByRole("list", { name: "Reports" })
    .getByRole("button");
  await expect(list).toHaveCount(2);
  // the newest is on top and open
  await expect(list.first()).toContainText("payment broke");
  await expect(viewer.locator("#headline")).toContainText("payment broke");
  await expect(viewer.locator("#stage iframe")).toBeAttached();
  await list.last().click();
  await expect(viewer.locator("#headline")).toContainText("coupon broke");
  await expect(viewer.locator("#steps")).toContainText("Apply coupon");
  await expect(viewer.locator("#stage iframe")).toHaveCount(1);
  expect(requests).toEqual([]);
  await viewing.close();
});

test("rewindbug.download(n) in the console saves that report alone", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Apply coupon" }).click();
  await page.getByRole("button", { name: "Pay" }).click();
  const download = page.waitForEvent("download");
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          rewindbug: { download: (n: number) => Promise<boolean> };
        }
      ).rewindbug.download(1),
    ),
  ).toBe(true);
  const html = await readFile(await (await download).path(), "utf8");
  expect(html).toContain("<title>coupon broke</title>");
  expect(html).not.toContain("payment broke");
});
