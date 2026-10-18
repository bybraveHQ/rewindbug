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
import { reportPage, type Player } from "./view.ts";

export { expect } from "@playwright/test";
export type { RewindbugOptions };

type Fixtures = { rewindbug: RewindbugOptions; rewindbugRecorder: undefined };

const PAGE_TIMEOUT_MS = 5000;
const MAX_TITLE_LENGTH = 200;
// a page in a loop of errors must not fill the disk with attachments
const MAX_REPORTS = 20;

// the browser build and the player ship next to this module in dist
const dist = new Map<string, string>();
const shipped = (name: string): string => {
  let text = dist.get(name);
  if (text === undefined) {
    text = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    dist.set(name, text);
  }
  return text;
};
const browserBuild = () => shipped("rewindbug.global.js");
const player = (): Player => ({
  script: shipped("rrweb-replay.js"),
  style: shipped("rrweb-replay.css"),
});

const withTimeout = <T>(work: Promise<T>): Promise<T | undefined> =>
  Promise.race([work, delay(PAGE_TIMEOUT_MS, undefined, { ref: false })]);

const captureFailure = async (
  context: BrowserContext,
  failure: ReturnType<typeof failureOf>,
) => {
  for (const page of context.pages()) {
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
  for (const [index, report] of reports.entries()) {
    const name = `rewindbug-${index + 1}`;
    const [headline = ""] = report.trigger.message.split("\n");
    const title = `${testInfo.title}: ${headline}`.slice(0, MAX_TITLE_LENGTH);
    const html = testInfo.outputPath(`${name}.html`);
    const json = testInfo.outputPath(`${name}.json`);
    await writeFile(html, reportPage(report, title, player()));
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
      const reports: Report[] = [];
      await context.exposeBinding(BINDING, (source, report: unknown) => {
        if (
          source.frame === source.page.mainFrame() &&
          looksLikeReport(report) &&
          reports.length < MAX_REPORTS
        )
          reports.push(report);
      });
      await context.addInitScript({
        content: initScript(browserBuild(), rewindbug),
      });
      await use(undefined);
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (failed) {
        const failure = failureOf(testInfo);
        await captureFailure(context, failure);
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
