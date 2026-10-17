import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { NetworkEntry, Report, Trigger } from "../types.ts";
import { defaultUrlFilter } from "../shared/url-filter.ts";
import type { CaptureSource } from "./build.ts";
import { startReport, type Reporter } from "./index.ts";

const ENDPOINT = "https://collect.example/r";
const NOW = 1_700_000_000_000;

let reporter: Reporter;
let fetchMock: ReturnType<typeof vi.fn>;
let source: CaptureSource;

const sent = async (): Promise<Report[]> =>
  Promise.all(
    fetchMock.mock.calls.map(
      async ([, init]) =>
        JSON.parse(
          await new Response(
            (init as RequestInit & { body: Blob }).body
              .stream()
              .pipeThrough(new DecompressionStream("gzip")),
          ).text(),
        ) as Report,
    ),
  );

const error = (message: string): Trigger => ({
  kind: "error",
  at: NOW,
  message,
  error: { name: "Error", message },
});

const start = (extra: Partial<Parameters<typeof startReport>[0]> = {}) =>
  startReport({
    endpoint: ENDPOINT,
    maxReportBytes: 512 * 1024,
    bufferSeconds: 30,
    filter: defaultUrlFilter,
    app: { release: "1.0.0" },
    capture: () => source,
    replay: () => ({ state: "off" }),
    steps: () => ({ steps: [] }),
    describeSteps: () => "",
    describeTest: () => "",
    now: () => NOW,
    ...extra,
  });

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  source = { console: [], network: [], lastEvicted: {} };
  reporter = start();
});

afterEach(() => {
  reporter.stop();
  vi.unstubAllGlobals();
});

describe("startReport", () => {
  test("builds, compresses and sends one report per trigger", async () => {
    source.console.push({ t: NOW - 1000, level: "warn", message: "low disk" });
    reporter.onTrigger(error("boom"));
    await reporter.flush();
    const [report] = await sent();
    expect(report).toMatchObject({
      schemaVersion: 0,
      createdAt: NOW,
      trigger: { kind: "error", message: "boom" },
      context: { app: { release: "1.0.0" } },
      console: [{ message: "low disk" }],
      replay: null,
      limits: { truncated: [], replayState: "off" },
    });
    expect(report?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  test("copies buffers at the trigger, not at send time", async () => {
    reporter.onTrigger(error("boom"));
    source.console.push({ t: NOW, level: "log", message: "later" });
    await reporter.flush();
    expect((await sent())[0]?.console).toEqual([]);
  });

  test("dedups the same error and keeps a different one", async () => {
    reporter.onTrigger(error("item 1 missing"));
    reporter.onTrigger(error("item 2 missing"));
    reporter.onTrigger(error("other"));
    await reporter.flush();
    // reports compress in parallel, so they may leave in any order
    expect((await sent()).map((r) => r.trigger.message).sort()).toEqual([
      "item 1 missing",
      "other",
    ]);
  });

  test("manual reports use the id as fingerprint and are never deduped", async () => {
    const manual: Trigger = {
      kind: "manual",
      at: NOW,
      message: "manual capture",
    };
    reporter.onTrigger(manual);
    reporter.onTrigger(manual);
    await reporter.flush();
    const reports = await sent();
    expect(reports).toHaveLength(2);
    for (const report of reports) expect(report.fingerprint).toBe(report.id);
  });

  test("network triggers fingerprint the request they point to", async () => {
    const entry: NetworkEntry = {
      id: 5,
      t: NOW - 10,
      type: "fetch",
      method: "GET",
      url: "https://api.example/users/1",
      state: "done",
      status: 503,
    };
    source.network.push(entry);
    const network = (id: number): Trigger => ({
      kind: "network",
      at: NOW,
      message: "GET /users/1 → 503",
      requestId: id,
    });
    reporter.onTrigger(network(5));
    source.network.push({
      ...entry,
      id: 6,
      url: "https://api.example/users/2",
    });
    reporter.onTrigger(network(6));
    source.network.push({ ...entry, id: 7, status: 404 });
    reporter.onTrigger(network(7));
    await reporter.flush();
    expect((await sent()).map((r) => r.trigger.requestId).sort()).toEqual([
      5, 7,
    ]);
  });

  test("a failing source never throws into the trigger", () => {
    const broken = startReport({
      endpoint: ENDPOINT,
      maxReportBytes: 1,
      bufferSeconds: 30,
      filter: defaultUrlFilter,
      capture: () => {
        throw new Error("broken");
      },
      replay: () => ({ state: "off" }),
      steps: () => ({ steps: [] }),
      describeSteps: () => "",
      describeTest: () => "",
    });
    expect(() => broken.onTrigger(error("x"))).not.toThrow();
    broken.stop();
  });

  test("beacons queued reports when the page hides", async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", {
      value: beacon,
      configurable: true,
    });
    fetchMock.mockRejectedValue(new TypeError("offline"));
    reporter.onTrigger(error("boom"));
    await reporter.flush();
    window.dispatchEvent(new Event("pagehide"));
    expect(beacon).toHaveBeenCalledTimes(1);
  });
});

describe("beforeSend and tags", () => {
  test("beforeSend changes a report or drops it", async () => {
    reporter.stop();
    reporter = start({
      beforeSend: (report) =>
        report.trigger.message === "noise"
          ? null
          : { ...report, stepsMarkdown: "redacted" },
    });
    reporter.onTrigger(error("noise"));
    reporter.onTrigger(error("boom"));
    await reporter.flush();
    const reports = await sent();
    expect(reports.map((r) => [r.trigger.message, r.stepsMarkdown])).toEqual([
      ["boom", "redacted"],
    ]);
  });

  test("a throwing beforeSend sends nothing", async () => {
    reporter.stop();
    reporter = start({
      beforeSend: () => {
        throw new Error("redaction failed");
      },
    });
    reporter.onTrigger(error("boom"));
    await reporter.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a dropped report gives back its slot, not its dedup window", async () => {
    const beforeSend = vi.fn((report: Report) =>
      report.trigger.message === "noise" ? null : report,
    );
    reporter.stop();
    reporter = start({ beforeSend });
    for (let i = 0; i < 12; i++) reporter.onTrigger(error("noise"));
    for (let i = 0; i < 10; i++)
      reporter.onTrigger(error(`real ${"abcdefghij"[i]}`));
    await reporter.flush();
    expect(beforeSend).toHaveBeenCalledTimes(11);
    expect(await sent()).toHaveLength(10);
  });

  test("an async beforeSend drops the report", async () => {
    reporter.stop();
    reporter = start({
      beforeSend: (async (report: Report) => report) as never,
    });
    reporter.onTrigger(error("boom"));
    await reporter.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("tags of one capture go on top of the init tags", async () => {
    reporter.stop();
    reporter = start({ tags: { user: "u-1", plan: "free" } });
    reporter.onTrigger(
      { kind: "manual", at: NOW, message: "manual capture" },
      { plan: "pro", sentry: "abc123" },
    );
    reporter.onTrigger({ kind: "manual", at: NOW, message: "manual capture" });
    await reporter.flush();
    // reports leave in the order their compression ends
    const tags = (await sent()).map((r) => r.context.tags);
    expect(tags).toHaveLength(2);
    expect(tags).toEqual(
      expect.arrayContaining([
        { user: "u-1", plan: "pro", sentry: "abc123" },
        { user: "u-1", plan: "free" },
      ]),
    );
  });
});
