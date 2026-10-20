import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Report } from "../src/types.ts";
import { FIXTURES_PORT } from "./fixtures/port.ts";
import {
  RUN_TIMEOUT_MS,
  removeGeneratedRoot,
  runGenerated,
} from "./generated.ts";

// a project's own suite on rewindbug/playwright: a failed test gets the
// report with the recording, a passing one gets nothing
const ORIGIN = `http://127.0.0.1:${FIXTURES_PORT}`;
const FIXTURE = fileURLToPath(
  new URL("../dist/playwright.js", import.meta.url),
);

test.setTimeout(RUN_TIMEOUT_MS + 15_000);
test.afterAll(removeGeneratedRoot);

type Attachment = { name: string; contentType: string; path?: string };
type JsonResult = { status: string; attachments: Attachment[] };
type JsonSpec = { title: string; tests: { results: JsonResult[] }[] };
type JsonSuite = { specs: JsonSpec[]; suites?: JsonSuite[] };
type Result = { status: string; files: Map<string, string> };

const specs = (suite: JsonSuite): JsonSpec[] => [
  ...suite.specs,
  ...(suite.suites ?? []).flatMap(specs),
];

// the last result of each test, with its rewindbug attachments read from disk
const results = async (stdout: string): Promise<Map<string, Result>> => {
  const { suites } = JSON.parse(stdout) as { suites: JsonSuite[] };
  const byTitle = new Map<string, Result>();
  for (const spec of suites.flatMap(specs)) {
    const last = spec.tests[0]?.results.at(-1);
    if (!last) continue;
    const files = new Map<string, string>();
    for (const attachment of last.attachments)
      if (attachment.name.startsWith("rewindbug") && attachment.path)
        files.set(attachment.name, await readFile(attachment.path, "utf8"));
    byTitle.set(spec.title, { status: last.status, files });
  }
  return byTitle;
};

const suiteSource = (browserName: string, options = "{}") => `
import { expect, test } from ${JSON.stringify(FIXTURE)};

test.use({ browserName: ${JSON.stringify(browserName)}, rewindbug: ${options} });

test("coupon is applied", async ({ page }) => {
  await page.goto("/plain-checkout.html");
  await page.getByLabel("Coupon").fill("SAVE10");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Coupon applied")).toBeVisible({ timeout: 1000 });
});

test("coupon field is there", async ({ page }) => {
  await page.goto("/plain-checkout.html");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByLabel("Coupon")).toBeVisible();
});
`;

const runSuite = async (browserName: string, options?: string) => {
  const run = await runGenerated(suiteSource(browserName, options), ORIGIN, {
    reporter: "json",
    read: results,
  });
  return { run, byTitle: run.read ?? new Map<string, Result>() };
};

test("a failed test gets the report with the recording", async ({
  browserName,
}) => {
  const { run, byTitle } = await runSuite(browserName);
  expect(run.status, run.output).toBe(1);

  const failed = byTitle.get("coupon is applied");
  expect(failed?.status).toBe("failed");
  expect([...(failed?.files.keys() ?? [])]).toEqual([
    "rewindbug-1.html",
    "rewindbug-1.json",
    "rewindbug-2.html",
    "rewindbug-2.json",
  ]);
  const json = (name: string) =>
    JSON.parse(failed?.files.get(name) ?? "null") as Report;

  // the failure comes first, with the steps that led to it
  const failure = json("rewindbug-1.json");
  expect(failure.trigger.message).toMatch(/^expect\(locator\)/);
  expect(failure.trigger.message).toContain("Coupon applied");
  expect(failure.stepsMarkdown).toMatch(/Apply/);
  expect(failure.replay?.events.length).toBeGreaterThan(0);
  // typed text stays masked
  expect(JSON.stringify(failure)).not.toContain("SAVE10");

  const pageError = json("rewindbug-2.json");
  expect(pageError.trigger.kind).toBe("error");
  expect(pageError.trigger.message).toMatch(/code|undefined/);

  // the recorded page cannot break out of the data script
  const page = failed?.files.get("rewindbug-1.html") ?? "";
  expect(page).toContain('<script id="reports" type="application/json">');
  expect(page.match(/<\/script>/g)).toHaveLength(3);
  // the player is on the page: no network at view time
  expect(page).toContain("rrwebReplay");
  expect(page).not.toContain("jsdelivr");

  // the page error alone does not fail a test or attach to a passing one
  const passed = byTitle.get("coupon field is there");
  expect(passed?.status).toBe("passed");
  expect(passed?.files.size).toBe(0);
});

test("a context from browser.newContext() reports through withRewindbug; maskParams masks URLs", async ({
  browserName,
}) => {
  const source = `
import { expect, test, withRewindbug } from ${JSON.stringify(FIXTURE)};

test.use({ browserName: ${JSON.stringify(browserName)}, rewindbug: { maskParams: ["x-vercel-protection-bypass"] } });

test("helper context", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  expect(await withRewindbug(context)).toBe(true);
  const page = await context.newPage();
  await page.goto("/plain-checkout.html?x-vercel-protection-bypass=tok-secret-1");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Coupon applied")).toBeVisible({ timeout: 1000 });
});
`;
  const run = await runGenerated(source, ORIGIN, {
    reporter: "json",
    read: results,
  });
  expect(run.status, run.output).toBe(1);
  const failed = run.read?.get("helper context");
  expect(failed?.status).toBe("failed");
  const names = [...(failed?.files.keys() ?? [])];
  expect(names).toContain("rewindbug-1.json");
  const reports = names
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(failed?.files.get(name) ?? "null") as Report);
  expect(reports[0]?.trigger.message).toMatch(/^expect\(locator\)/);
  expect(reports[0]?.context.url).toContain("x-vercel-protection-bypass=*");
  for (const file of failed?.files.values() ?? [])
    expect(file).not.toContain("tok-secret-1");
});

test("withRewindbug outside a test does nothing", async ({ browser }) => {
  const { withRewindbug } = (await import(FIXTURE)) as {
    withRewindbug: (context: unknown) => Promise<boolean>;
  };
  const context = await browser.newContext();
  expect(await withRewindbug(context)).toBe(false);
  await context.close();
});

test("attach: always puts page errors on passing tests", async ({
  browserName,
}) => {
  const { byTitle } = await runSuite(browserName, '{ attach: "always" }');
  const passed = byTitle.get("coupon field is there");
  expect(passed?.status).toBe("passed");
  expect([...(passed?.files.keys() ?? [])]).toEqual([
    "rewindbug-1.html",
    "rewindbug-1.json",
  ]);
});
