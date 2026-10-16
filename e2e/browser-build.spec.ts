import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const BUNDLE = fileURLToPath(
  new URL("../dist/rewindbug.browser.js", import.meta.url),
);
const ORIGIN = "http://plain-page.test";

// a page with no bundler: one module script imports the browser build by URL
const PAGE = `<!doctype html>
<button id="boom">Boom</button>
<script type="module">
  import { init } from "${ORIGIN}/rewindbug.browser.js";
  window.started = init({ endpoint: "${ORIGIN}/report" });
  document.getElementById("boom").onclick = () => {
    throw new Error("plain page broke");
  };
</script>`;

test("the browser build works from a plain module script", async ({ page }) => {
  const bundle = await readFile(BUNDLE);
  const reports: Buffer[] = [];
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/")
      return route.fulfill({ contentType: "text/html", body: PAGE });
    if (pathname === "/rewindbug.browser.js")
      return route.fulfill({ contentType: "text/javascript", body: bundle });
    if (pathname === "/report") {
      reports.push(route.request().postDataBuffer() ?? Buffer.alloc(0));
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/`);
  await expect
    .poll(() => page.evaluate(() => (window as { started?: boolean }).started))
    .toBe(true);
  await page.click("#boom");
  await expect.poll(() => reports.length).toBe(1);
});
