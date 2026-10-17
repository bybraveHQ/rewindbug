import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { Report } from "../src/types.ts";
import { FIXTURES_PORT } from "./fixtures/port.ts";
import {
  RUN_TIMEOUT_MS,
  removeGeneratedRoot,
  runGenerated,
} from "./generated.ts";

// pages shaped like real apps: each one breaks after a few user steps, and
// the test rewindbug writes from the report must reach the same error
const ORIGIN = `http://127.0.0.1:${FIXTURES_PORT}`;

test.setTimeout(RUN_TIMEOUT_MS + 15_000);
test.afterAll(removeGeneratedRoot);

const open = async (page: Page, name: string) => {
  const run = randomUUID();
  await page.goto(`${ORIGIN}/${name}.html?run=${run}`);
  await expect
    .poll(() => page.evaluate(() => (window as { started?: boolean }).started))
    .toBe(true);
  return async () => {
    const reports = async () =>
      (await (
        await page.request.get(`${ORIGIN}/reports?run=${run}`)
      ).json()) as Report[];
    await expect.poll(async () => (await reports()).length).toBeGreaterThan(0);
    const [report] = await reports();
    if (!report) throw new Error("no report");
    return report;
  };
};

const reproduces = async (report: Report, error: string) => {
  const run = await runGenerated(report.test, ORIGIN);
  expect(run.status, `${report.test}\n${run.output}`).toBe(1);
  // the page error itself, not the test title that repeats its message
  expect(run.output).toContain(`[Error: ${error}]`);
  return run.output;
};

test("Enter in a form submits once in the test too", async ({ page }) => {
  const report = await open(page, "enter");
  await page.getByLabel("Search").fill("shoes");
  await page.getByLabel("Search").press("Enter");
  const { test: source } = await report();
  expect(source).not.toContain(".click()");
  const output = await reproduces(await report(), "search broke on submit 1");
  expect(output).not.toContain("submit 2");
});

test("a card with no name is found by its index", async ({ page }) => {
  const report = await open(page, "cards");
  await page.locator("span").nth(1).click();
  const { test: source } = await report();
  expect(source).toContain(".nth(1).click();");
  await reproduces(await report(), "card 2 broke");
});

test("masked typed fields get values they accept", async ({ page }) => {
  const report = await open(page, "form");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Quantity").fill("3");
  // selectOption sets the value from script: a person uses the keyboard
  await page.getByLabel("Size").focus();
  await page.keyboard.press("m");
  await page.getByRole("button", { name: "Order" }).click();
  const { test: source } = await report();
  expect(source).not.toMatch(/ada@example|"3"/);
  await reproduces(await report(), "order broke");
});

test("router navigations are waited for, not reloaded", async ({ page }) => {
  const report = await open(page, "spa");
  await page.getByLabel("Search").pressSequentially("abc");
  await page.getByRole("button", { name: "Open order" }).click();
  await page.getByRole("button", { name: "Pay" }).click();
  const { test: source } = await report();
  expect(source.match(/page\.goto\(/g)).toHaveLength(1);
  expect(source.match(/\.fill\(/g)).toHaveLength(1);
  await reproduces(await report(), "pay broke");
});

test("a menu item is found by its name", async ({ page }) => {
  const report = await open(page, "menu");
  await page.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const { test: source } = await report();
  expect(source).toContain('getByRole("menuitem", { name: "Delete"');
  await reproduces(await report(), "delete broke");
});
