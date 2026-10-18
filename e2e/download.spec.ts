import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import type { Report } from "../src/types.ts";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const ORIGIN = "http://no-server.test";
const TYPED = "4242 4242 4242 4242";

// a page with no endpoint: the report comes down as a file
const PAGE = `<!doctype html>
<label>Card <input id="card" /></label>
<button id="pay">Pay</button>
<script type="module">
  import { initDownload } from "${ORIGIN}/download.browser.js";
  window.started = initDownload();
  document.getElementById("pay").onclick = () => {
    throw new Error("payment broke");
  };
</script>`;

test("a report downloads as a page that plays offline", async ({
  page,
  browser,
}, testInfo) => {
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
  await page.getByLabel("Card").fill(TYPED);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Pay" }).click();
  const file = testInfo.outputPath("report.html");
  await (await download).saveAs(file);
  expect((await download).suggestedFilename()).toMatch(/^rewindbug-.*Z\.html$/);

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
  const report = JSON.parse(
    (await viewer.locator("#report").textContent()) ?? "",
  ) as Report;
  expect(report.trigger.message).toBe("payment broke");
  expect(report.replay?.events.length).toBeGreaterThan(0);
  await expect(viewer.locator("#steps")).toContainText("Pay");
  await expect(viewer.locator("#stage iframe")).toBeAttached();
  expect(requests).toEqual([]);
  await viewing.close();
});
