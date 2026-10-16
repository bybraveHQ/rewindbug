import type { NetworkEntry, Report } from "rewindbug";
import { describe, expect, test } from "vitest";
import {
  Bug,
  BugOutput,
  MAX_BODY_CHARS,
  MAX_BUG_BYTES,
  MAX_ENTRIES,
  toBug,
} from "./bug.ts";
import { fixture } from "./fixture.ts";
import { ReadReport, toSummary, type Stored } from "./store.ts";

const PATH = "/tmp/reports/x.json";

const stored = (value: unknown): Stored => {
  const report = ReadReport.parse(value);
  return { summary: toSummary(report, PATH, 1), report };
};

const request = (id: number, extra: Partial<NetworkEntry> = {}) =>
  ({
    id,
    t: id,
    type: "fetch",
    method: "GET",
    url: `https://api.example/${id}`,
    state: "done",
    status: 200,
    ...extra,
  }) satisfies NetworkEntry;

describe("toBug", () => {
  test("drops rrweb events and keeps the rest of the report", () => {
    const report = {
      ...fixture,
      replay: { format: "rrweb", events: [{}, {}, {}] },
      console: [{ t: 1, level: "error", message: "boom" }],
      network: [request(1)],
      steps: [{ t: 1, kind: "click", target: { css: "#a", unique: true } }],
    } satisfies Report;
    const bug = toBug(stored(report));
    expect(bug).toMatchObject({ id: fixture.id, path: PATH, trimmed: [] });
    expect(bug.report.replay).toEqual({ events: 3 });
    expect(bug.report.range).toEqual(fixture.range);
    expect(bug.report.network).toEqual([request(1)]);
    expect(BugOutput.parse({ bug })).toEqual({ bug });
  });

  test("cuts bodies by code point and flags them", () => {
    const body = "😀".repeat(MAX_BODY_CHARS + 5);
    const bug = toBug(
      stored({
        ...fixture,
        network: [request(1, { requestBody: body, responseBody: "ok" })],
      }),
    );
    const [entry] = bug.report.network;
    expect([...(entry?.requestBody ?? "")]).toHaveLength(MAX_BODY_CHARS);
    expect(entry?.requestBodyTruncated).toBe(true);
    expect(entry?.responseBody).toBe("ok");
    expect(entry?.responseBodyTruncated).toBeUndefined();
  });

  test("keeps the last entries and the request behind the trigger", () => {
    const network = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) =>
      request(i + 1),
    );
    const bug = toBug(
      stored({
        ...fixture,
        trigger: { kind: "network", at: 1, message: "GET 500", requestId: 1 },
        network,
      }),
    );
    const ids = bug.report.network.map((entry) => entry.id);
    expect(ids).toHaveLength(MAX_ENTRIES);
    expect(ids[0]).toBe(1);
    expect(ids.at(-1)).toBe(MAX_ENTRIES + 10);
    expect(bug.trimmed).toEqual(["network"]);
  });

  test("fits the worst report under MAX_BUG_BYTES", () => {
    const long = "x".repeat(2000);
    const network = Array.from({ length: 200 }, (_, i) =>
      request(i + 1, {
        url: `https://api.example/${long}`,
        requestBody: long,
        responseBody: long,
      }),
    );
    const consoleEntries = Array.from({ length: 200 }, (_, i) => ({
      t: i,
      level: "log" as const,
      message: "y".repeat(1000),
    }));
    const steps = Array.from({ length: 100 }, (_, i) => ({
      t: i,
      kind: "fill" as const,
      value: "z".repeat(200),
      target: { css: long, unique: false, name: "n".repeat(40) },
    }));
    const bug = toBug(
      stored({
        ...fixture,
        trigger: {
          kind: "error",
          at: 1,
          message: "boom",
          error: { name: "E", message: "boom", stack: "s".repeat(8000) },
        },
        network,
        console: consoleEntries,
        steps,
        test: "t".repeat(60_000),
        stepsMarkdown: "m".repeat(60_000),
      }),
    );
    expect(Buffer.byteLength(JSON.stringify(bug))).toBeLessThanOrEqual(
      MAX_BUG_BYTES,
    );
    expect(bug.trimmed).toEqual(expect.arrayContaining(["network", "console"]));
    expect(() => Bug.parse(bug)).not.toThrow();
  });

  test("survives junk entries and a newer trigger kind", () => {
    const bug = toBug(
      stored({
        ...fixture,
        trigger: { kind: "future-kind", at: 1, message: "m" },
        network: [null, 7, { id: 1, status: "bad", extra: true }],
        console: ["text", { level: "warn", message: 3 }],
        steps: [[], { kind: "drag", t: 1 }],
      }),
    );
    expect(bug.report.network).toEqual([{ id: 1, extra: true }]);
    expect(bug.report.console).toEqual([{ level: "warn" }]);
    expect(bug.report.steps).toEqual([{ kind: "drag", t: 1 }]);
    expect(() => BugOutput.parse({ bug })).not.toThrow();
  });

  test("keys like __proto__ and constructor are plain data", () => {
    const junk = JSON.parse(
      '[{"__proto__": {"polluted": 1}, "constructor": 1, "toString": 2, "level": "log"}]',
    ) as unknown[];
    const bug = toBug(
      stored({ ...fixture, console: junk, network: junk, steps: junk }),
    );
    const [entry] = bug.report.console;
    expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
    expect(Object.keys(entry ?? {})).toEqual(
      expect.arrayContaining(["__proto__", "constructor", "toString"]),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => BugOutput.parse({ bug })).not.toThrow();
  });

  test("a huge message and unknown fields are cut to the ceiling", () => {
    const bug = toBug(
      stored({
        ...fixture,
        trigger: { kind: "error", at: 1, message: "m".repeat(1_000_000) },
        context: {
          ...fixture.context,
          url: `https://a.example/${"u".repeat(100_000)}`,
        },
        extra: "e".repeat(1_000_000),
      }),
    );
    expect(Buffer.byteLength(JSON.stringify(bug))).toBeLessThanOrEqual(
      MAX_BUG_BYTES,
    );
    expect(bug.trimmed).toEqual(expect.arrayContaining(["test", "fields"]));
    expect("extra" in bug.report).toBe(false);
  });
});
