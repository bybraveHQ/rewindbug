import { describe, expect, test } from "vitest";
import type { Context, Trigger } from "../types.ts";
import { defaultUrlFilter } from "../shared/url-filter.ts";
import {
  buildReport,
  collectContext,
  reportId,
  type CaptureSource,
  type ReportInput,
} from "./build.ts";

const AT = 100_000;
const trigger: Trigger = { kind: "error", at: AT, message: "boom" };
const context: Context = {
  url: "https://app.example/a",
  title: "",
  userAgent: "",
  language: "en",
  timezone: "UTC",
  viewport: { width: 1, height: 1, dpr: 1 },
};
const capture = (overrides: Partial<CaptureSource> = {}): CaptureSource => ({
  console: [
    { t: 60_000, level: "log", message: "old" },
    { t: 95_000, level: "log", message: "new" },
  ],
  network: [],
  lastEvicted: {},
  ...overrides,
});
const input = (overrides: Partial<ReportInput> = {}): ReportInput => ({
  id: "id",
  fingerprint: "fp",
  createdAt: AT,
  trigger,
  context,
  bufferSeconds: 30,
  capture: capture(),
  replay: { state: "off" },
  steps: { steps: [] },
  describeSteps: () => "",
  describeTest: () => "",
  ...overrides,
});

describe("buildReport", () => {
  test("without replay the window is bufferSeconds before the trigger", () => {
    const report = buildReport(input());
    expect(report.range).toEqual({
      start: 70_000,
      end: AT,
      startUrl: context.url,
    });
    expect(report.console.map((e) => e.message)).toEqual(["new"]);
    expect(report.limits).toEqual({ truncated: [], replayState: "off" });
    expect(report.sdk).toMatchObject({ name: "rewindbug" });
    expect(report.sdk.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("with replay the window starts at the first Meta", () => {
    const events = [
      { type: 4, timestamp: 50_000, data: { href: "https://app.example/s" } },
      { type: 2, timestamp: 50_000 },
    ];
    const report = buildReport(
      input({
        replay: { state: "recording", mutationStorm: false, events },
      }),
    );
    expect(report.range).toEqual({
      start: 50_000,
      end: AT,
      startUrl: "https://app.example/s",
    });
    expect(report.replay).toEqual({ format: "rrweb", events });
    expect(report.console).toHaveLength(2);
    expect(report.limits).toEqual({ truncated: [] });
  });

  test("states why replay is missing and flags a storm", () => {
    expect(
      buildReport(
        input({
          replay: { state: "stopped", mutationStorm: true, events: null },
        }),
      ).limits,
    ).toEqual({ truncated: [], mutationStorm: true, replayState: "stopped" });
    expect(
      buildReport(
        input({
          replay: { state: "recording", mutationStorm: false, events: [] },
        }),
      ).limits.replayState,
    ).toBe("not-started");
  });

  test("marks buffers that evicted entries inside the window", () => {
    const report = buildReport(
      input({
        capture: capture({ lastEvicted: { console: 75_000, network: 1 } }),
      }),
    );
    expect(report.limits.truncated).toEqual(["console"]);
  });

  test("keeps the request behind a network trigger even if it began earlier", () => {
    const slow = {
      id: 9,
      t: 10_000,
      type: "fetch" as const,
      method: "GET",
      url: "https://api.example/slow",
      state: "done" as const,
      status: 504,
    };
    const report = buildReport(
      input({
        trigger: { kind: "network", at: AT, message: "", requestId: 9 },
        capture: capture({ network: [slow] }),
      }),
    );
    expect(report.network).toEqual([slow]);
  });

  test("links steps to the requests they started and keeps steps in the window", () => {
    const report = buildReport(
      input({
        capture: capture({
          network: [
            {
              id: 1,
              t: 80_000,
              type: "fetch",
              method: "GET",
              url: "https://a/1",
              state: "done",
            },
            {
              id: 2,
              t: 80_500,
              type: "fetch",
              method: "GET",
              url: "https://a/2",
              state: "done",
            },
            {
              id: 3,
              t: 81_500,
              type: "fetch",
              method: "GET",
              url: "https://a/3",
              state: "done",
            },
          ],
        }),
        steps: {
          steps: [
            { t: 60_000, kind: "click" },
            { t: 80_000, kind: "click" },
            { t: 80_400, kind: "click" },
          ],
          lastEvicted: 71_000,
        },
        describeSteps: (steps, message) => `${steps.length}:${message}`,
        describeTest: ({ trigger, range, steps, network }) =>
          `${trigger.message}:${range.startUrl}:${steps.length}:${network.length}`,
      }),
    );
    expect(report.steps).toEqual([
      { t: 80_000, kind: "click", requestIds: [1] },
      { t: 80_400, kind: "click", requestIds: [2] },
    ]);
    expect(report.stepsMarkdown).toBe("2:boom");
    expect(report.test).toBe(
      `boom:${report.range.startUrl}:2:${report.network.length}`,
    );
    expect(report.limits.truncated).toEqual(["steps"]);
  });

  test("without replay the test starts where the first navigation started", () => {
    const report = buildReport(
      input({
        steps: {
          steps: [
            {
              t: 90_000,
              kind: "navigate",
              url: "https://app.example/b",
              from: "https://app.example/a",
            },
          ],
        },
      }),
    );
    expect(report.range.startUrl).toBe("https://app.example/a");
  });

  test("drops entries after the trigger", () => {
    const report = buildReport(
      input({
        capture: capture({
          console: [{ t: AT + 1, level: "log", message: "late" }],
        }),
      }),
    );
    expect(report.console).toEqual([]);
  });
});

describe("context and id", () => {
  test("collects page context through the url filter", () => {
    history.replaceState(null, "", "/page?token=secret");
    document.title = "x".repeat(300);
    const result = collectContext(defaultUrlFilter, {
      app: { release: "1.2.3" },
      tags: { team: "pay" },
    });
    expect(result.url).toContain("token=*");
    expect(result.title).toHaveLength(200);
    expect(result).toMatchObject({
      app: { release: "1.2.3" },
      tags: { team: "pay" },
    });
  });

  test("builds a v4 uuid without randomUUID", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    try {
      expect(reportId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      Object.defineProperty(crypto, "randomUUID", {
        value: original,
        configurable: true,
      });
    }
  });
});
