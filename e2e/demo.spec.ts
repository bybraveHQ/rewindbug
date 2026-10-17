import { expect, test, type Page } from "@playwright/test";
import {
  RUN_TIMEOUT_MS,
  removeGeneratedRoot,
  runGenerated,
} from "./generated.ts";

const TEST_TIMEOUT_MS = RUN_TIMEOUT_MS + 15_000;

test.setTimeout(TEST_TIMEOUT_MS);

const breakWith = async (page: Page, button: string) => {
  await page.goto("./");
  await expect(page.getByRole("status")).toHaveText(/Ready/);
  await page.getByRole("button", { name: "Checkout" }).click();
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByRole("button", { name: button }).click();
  await expect(page.getByTestId("report-steps")).toContainText("Checkout");
  return (await page.getByTestId("report-test").textContent()) ?? "";
};

test.afterAll(removeGeneratedRoot);

test("an exception gives a report whose test reproduces it", async ({
  page,
}) => {
  const source = await breakWith(page, "Apply coupon");
  await expect(page.locator("#headline")).toContainText("error: ");
  expect(source).toContain('page.on("pageerror"');
  const run = await runGenerated(source);
  expect(run.status, run.output).toBe(1);
  expect(run.output).toContain("reading 'percent'");
});

test("console.error gives a report whose test reproduces it", async ({
  page,
}) => {
  const source = await breakWith(page, "Save address");
  await expect(page.getByTestId("report-console")).toContainText(
    "Address service is unavailable",
  );
  const run = await runGenerated(source);
  expect(run.status, run.output).toBe(1);
  expect(run.output).toContain("Address service is unavailable");
});

test("a 500 gives a report whose test reproduces it", async ({ page }) => {
  const source = await breakWith(page, "Pay");
  const network = page.getByTestId("report-network");
  await expect(network).toContainText("POST /api/pay 500");
  await expect(network).toContainText('sent: {"total":144}');
  await expect(network).toContainText(
    'received: {"error":"payment provider timed out"}',
  );
  expect(source).toContain("waitForResponse");
  const run = await runGenerated(source);
  expect(run.status, run.output).toBe(1);
  expect(run.output).toContain("Received: false");
});

test("the report plays its recording", async ({ page }) => {
  await breakWith(page, "Pay");
  const frame = page.frameLocator('[data-testid="report-replay"] iframe');
  await expect(frame.getByRole("button", { name: "Pay" })).toBeAttached();
  await expect(frame.getByText("Mechanical keyboard, $129")).toBeAttached();
  await expect(page.getByRole("button", { name: "Play again" })).toBeVisible();
});

test("inputs are masked in the steps and in the test", async ({ page }) => {
  const source = await breakWith(page, "Apply coupon");
  await expect(page.getByTestId("report-steps")).not.toContainText("Ada");
  expect(source).not.toContain("Ada");
  expect(source).toContain('"Name": "test",');
  expect(source).toContain('.fill(input["Name"]);');
});

test("a hard reload still gets the page under the worker", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the bypass is set over CDP");
  await page.goto("./");
  await expect(page.getByRole("status")).toHaveText(/Ready/);
  // what Cmd+Shift+R does: only the document skips the active worker. The
  // script waits until the bypass is off, so the page starts uncontrolled
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route("**/main.js", async (route) => {
    await held;
    await route.continue();
  });
  await cdp.send("Network.setBypassServiceWorker", { bypass: true });
  const reload = page.reload();
  await page.waitForRequest("**/main.js");
  await cdp.send("Network.setBypassServiceWorker", { bypass: false });
  release();
  await reload;
  await expect(page.getByRole("status")).toHaveText(/Ready/);
  await page.getByRole("button", { name: "Checkout" }).click();
  await page.getByRole("button", { name: "Pay" }).click();
  await expect(page.getByTestId("report-network")).toContainText(
    "POST /api/pay 500",
  );
});

test("a report goes only to the tab that sent it", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  await other.goto("./");
  await expect(other.getByRole("status")).toHaveText(/Ready/);
  await breakWith(page, "Save address");
  await expect(other.locator("#empty")).toBeVisible();
  await expect(other.getByRole("status")).toHaveText(/Ready/);
});
