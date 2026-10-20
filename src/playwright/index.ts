import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  test as base,
  type BrowserContext,
  type TestInfo,
} from "@playwright/test";
import type { Report } from "../types.ts";
import {
  BINDING,
  FAILURE_NAME,
  failureOf,
  initScript,
  looksLikeReport,
  uniqueReports,
  type RewindbugOptions,
} from "./parts.ts";
import { NONCE_BYTES, nonceOf, reportPage } from "../report/page.ts";

export { expect } from "@playwright/test";
export type { RewindbugOptions };

type Fixtures = { rewindbug: RewindbugOptions; rewindbugRecorder: undefined };

type Collector = {
  reports: Report[];
  contexts: Set<BrowserContext>;
  options: RewindbugOptions;
};

const PAGE_TIMEOUT_MS = 5000;
const MAX_TITLE_LENGTH = 200;
// a page in a loop of errors must not fill the disk with attachments
const MAX_REPORTS = 20;

// the browser build ships next to this module in dist
let browserBuild: string | undefined;
const shipped = (): string =>
  (browserBuild ??= readFileSync(
    new URL("./rewindbug.global.js", import.meta.url),
    "utf8",
  ));

// tests in a worker run one at a time: the running test owns the reports of
// every context it instrumented
let active: Collector | undefined;
// a context instrumented once keeps its binding; it reports to the test that
// claimed it last
const owners = new WeakMap<BrowserContext, Collector>();

const instrument = async (
  context: BrowserContext,
  options: RewindbugOptions,
  collector: Collector,
): Promise<void> => {
  collector.contexts.add(context);
  if (owners.has(context)) {
    owners.set(context, collector);
    return;
  }
  owners.set(context, collector);
  await context.exposeBinding(BINDING, (source, report: unknown) => {
    const owner = owners.get(context);
    if (
      owner &&
      source.frame === source.page.mainFrame() &&
      looksLikeReport(report) &&
      owner.reports.length < MAX_REPORTS
    )
      owner.reports.push(report);
  });
  await context.addInitScript({ content: initScript(shipped(), options) });
};

// a context the test makes itself, `browser.newContext()` in a helper: its
// page errors go to the same failed test as the built-in context. Outside a
// test (global setup) there is no test to attach to: nothing happens and it
// returns false
export const withRewindbug = async (
  context: BrowserContext,
  options?: RewindbugOptions,
): Promise<boolean> => {
  if (!active) return false;
  await instrument(context, options ?? active.options, active);
  return true;
};

const withTimeout = <T>(work: Promise<T>): Promise<T | undefined> =>
  Promise.race([work, delay(PAGE_TIMEOUT_MS, undefined, { ref: false })]);

const captureFailure = async (
  contexts: Iterable<BrowserContext>,
  failure: ReturnType<typeof failureOf>,
) => {
  for (const page of [...contexts].flatMap((context) => context.pages())) {
    if (page.isClosed()) continue;
    // a page stuck on a dialog or crashed must not hold the teardown
    await withTimeout(
      page
        .evaluate(async (error) => {
          const rb = (
            window as {
              __rewindbug?: {
                capture: (error: unknown) => void;
                settled: () => Promise<unknown>;
              };
            }
          ).__rewindbug;
          if (!rb) return;
          rb.capture(error);
          await rb.settled();
        }, failure)
        .catch(() => undefined),
    );
  }
};

// files, not bodies: terminal reporters print a body inline and a path as is
const attach = async (testInfo: TestInfo, reports: Report[]) => {
  const { player } = await import("../report/player.ts");
  for (const [index, report] of reports.entries()) {
    const name = `rewindbug-${index + 1}`;
    const [headline = ""] = report.trigger.message.split("\n");
    const title = `${testInfo.title}: ${headline}`.slice(0, MAX_TITLE_LENGTH);
    const html = testInfo.outputPath(`${name}.html`);
    const json = testInfo.outputPath(`${name}.json`);
    await writeFile(
      html,
      reportPage([report], title, player, nonceOf(randomBytes(NONCE_BYTES))),
    );
    await writeFile(json, JSON.stringify(report, null, 2));
    await testInfo.attach(`${name}.html`, {
      path: html,
      contentType: "text/html",
    });
    await testInfo.attach(`${name}.json`, {
      path: json,
      contentType: "application/json",
    });
  }
};

export const test = base.extend<Fixtures>({
  rewindbug: [{}, { option: true }],
  rewindbugRecorder: [
    async ({ context, rewindbug }, use, testInfo) => {
      const collector: Collector = {
        reports: [],
        contexts: new Set(),
        options: rewindbug,
      };
      const { reports } = collector;
      active = collector;
      try {
        await instrument(context, rewindbug, collector);
        await use(undefined);
      } finally {
        active = undefined;
      }
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (failed) {
        const failure = failureOf(testInfo);
        await captureFailure(collector.contexts, failure);
        // the failure first: it is what the test reports
        reports.sort(
          (a, b) =>
            Number(b.trigger.error?.name === FAILURE_NAME) -
            Number(a.trigger.error?.name === FAILURE_NAME),
        );
      }
      if (failed || rewindbug.attach === "always")
        await attach(testInfo, uniqueReports(reports));
    },
    { auto: true },
  ],
});
