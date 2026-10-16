import { record } from "@rrweb/record";
import { expect, test, vi } from "vitest";
import { capture, flush, init } from "../index.ts";
import type { Report } from "../types.ts";

const ENDPOINT = "https://collect.example/report";
const POLL_MS = 10;
const WAIT_MS = 3000;

test("a manual capture sends a full report with the replay", async () => {
  const realFetch = globalThis.fetch;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, options) =>
      String(input) === ENDPOINT
        ? Promise.resolve(new Response(null, { status: 204 }))
        : realFetch(input, options),
    );
  expect(init({ endpoint: ENDPOINT, app: { release: "e2e" } })).toBe(true);
  const deadline = performance.now() + WAIT_MS;
  while (record.mirror.getIds().length === 0) {
    if (performance.now() > deadline)
      throw new Error("recording did not start");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  console.info("see https://app.test/?token=abc");
  await fetch(location.href);
  capture(new Error("boom"));
  await flush();

  const call = fetchSpy.mock.calls.find(
    ([input]) => String(input) === ENDPOINT,
  );
  const body = (call?.[1] as RequestInit & { body: Blob }).body;
  const report = JSON.parse(
    await new Response(
      body.stream().pipeThrough(new DecompressionStream("gzip")),
    ).text(),
  ) as Report;

  expect(report).toMatchObject({
    schemaVersion: 0,
    trigger: { kind: "manual", message: "boom" },
    context: { app: { release: "e2e" } },
    limits: { truncated: [] },
  });
  expect(report.fingerprint).toBe(report.id);
  expect(report.test).toMatch(
    /^import \{ test, expect \} from "@playwright\/test";/,
  );
  expect(report.test).toContain(
    `await page.goto(${JSON.stringify(report.range.startUrl)});`,
  );
  const events = report.replay?.events as { type: number; timestamp: number }[];
  expect(events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
  expect(report.range.start).toBe(events[0]?.timestamp);
  expect(report.console.some((e) => e.message.includes("token=*"))).toBe(true);
  const [request] = report.network;
  expect(request?.state).toBe("done");
  expect(JSON.stringify(events)).toContain(
    JSON.stringify({ tag: "rewindbug/net", payload: { id: request?.id } }),
  );
});
