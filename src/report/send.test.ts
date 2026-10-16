import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Report } from "../types.ts";
import { compress, fitReport, Sender } from "./send.ts";

const ENDPOINT = "https://collect.example/r";

const report = (overrides: Partial<Report> = {}): Report => ({
  schemaVersion: 0,
  id: "id",
  fingerprint: "fp",
  createdAt: 1,
  sdk: { name: "rewindbug", version: "0", rrwebVersion: "0" },
  trigger: { kind: "manual", at: 1, message: "manual capture" },
  context: {
    url: "https://app.example/",
    title: "",
    userAgent: "",
    language: "en",
    timezone: "UTC",
    viewport: { width: 1, height: 1, dpr: 1 },
  },
  range: { start: 0, end: 1, startUrl: "https://app.example/" },
  steps: [],
  stepsMarkdown: "",
  test: "",
  console: [],
  network: [],
  replay: null,
  limits: { truncated: [] },
  ...overrides,
});

const unzip = async (blob: Blob): Promise<Report> =>
  JSON.parse(
    await new Response(
      blob.stream().pipeThrough(new DecompressionStream("gzip")),
    ).text(),
  ) as Report;

// incompressible text, so sizes are predictable
const noise = (length: number) =>
  Array.from({ length }, () =>
    String.fromCharCode(33 + Math.floor(Math.random() * 90)),
  ).join("");

describe("compress", () => {
  test("round-trips a report without replay", async () => {
    const source = report();
    const blob = await compress(source);
    expect(blob.type).toBe("text/plain");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    expect(await unzip(blob)).toEqual(source);
  });

  test("round-trips replay events across several chunks", async () => {
    const events = Array.from({ length: 300 }, (_, i) => ({
      type: 3,
      timestamp: i,
      data: { text: "x".repeat(500) },
    }));
    const source = report({ replay: { format: "rrweb", events } });
    expect(await unzip(await compress(source))).toEqual(source);
  });
});

describe("fitReport", () => {
  const network = [
    {
      id: 1,
      t: 0,
      type: "fetch" as const,
      method: "POST",
      url: "https://api.example/x",
      state: "done" as const,
      requestBody: noise(6000),
      responseBody: noise(6000),
    },
  ];

  test("keeps everything under the cap", async () => {
    const source = report({ network });
    expect(await unzip(await fitReport(source, 1_000_000))).toEqual(source);
  });

  test("drops bodies first", async () => {
    const result = await unzip(await fitReport(report({ network }), 8000));
    expect(result.network[0]).not.toHaveProperty("requestBody");
    expect(result.network[0]).not.toHaveProperty("responseBody");
    expect(result.limits.truncated).toEqual(["body"]);
  });

  test("without bodies goes straight to dropping the replay", async () => {
    const events = [{ type: 2, timestamp: 0, data: noise(20_000) }];
    const result = await unzip(
      await fitReport(report({ replay: { format: "rrweb", events } }), 8000),
    );
    expect(result.replay).toBeNull();
    expect(result.limits.truncated).toEqual(["replay"]);
  });

  test("then drops the replay", async () => {
    const events = [{ type: 2, timestamp: 0, data: noise(20_000) }];
    const result = await unzip(
      await fitReport(
        report({ network, replay: { format: "rrweb", events } }),
        8000,
      ),
    );
    expect(result.replay).toBeNull();
    expect(result.limits).toMatchObject({
      truncated: ["body", "replay"],
      replayState: "too-large",
    });
  });
});

describe("Sender", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let beacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    beacon = vi.fn(() => true);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "sendBeacon", {
      value: beacon,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("posts the blob without credentials and forgets it on success", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const sender = new Sender(ENDPOINT);
    const blob = new Blob(["x"]);
    sender.push(blob);
    await sender.flush();
    expect(fetchMock).toHaveBeenCalledWith(ENDPOINT, {
      method: "POST",
      body: blob,
      credentials: "omit",
    });
    expect(sender.size).toBe(0);
  });

  test("keeps a failed report and resends it on flush", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sender = new Sender(ENDPOINT);
    sender.push(new Blob(["x"]));
    await sender.flush();
    expect(sender.size).toBe(1);
    await sender.flush();
    expect(sender.size).toBe(1);
    await sender.flush();
    expect(sender.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("flush waits for reports that are still compressing", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const sender = new Sender(ENDPOINT);
    sender.track(compress(report()));
    await sender.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("beacons small idle reports on unload, skips big and in-flight ones", async () => {
    let release: (value: Response) => void = () => undefined;
    fetchMock
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
    const sender = new Sender(ENDPOINT);
    const small = new Blob(["x"]);
    sender.push(small);
    sender.push(new Blob([new Uint8Array(61 * 1024)]));
    await sender.flush();
    sender.push(new Blob(["in flight"]));
    sender.unload();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon).toHaveBeenCalledWith(ENDPOINT, small);
    expect(sender.size).toBe(2);
    release(new Response(null, { status: 200 }));
  });

  test("keeps a report the beacon refused", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    beacon.mockReturnValue(false);
    const sender = new Sender(ENDPOINT);
    sender.push(new Blob(["x"]));
    await sender.flush();
    sender.unload();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(sender.size).toBe(1);
  });

  test("ignores fetch wrappers added after it started", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const sender = new Sender(ENDPOINT);
    const later = vi.fn();
    vi.stubGlobal("fetch", later);
    sender.push(new Blob(["x"]));
    await sender.flush();
    expect(later).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a fetch that throws synchronously keeps the report and rejects nothing", async () => {
    fetchMock.mockImplementation(() => {
      throw new TypeError("patched fetch broke");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const sender = new Sender(ENDPOINT);
      sender.track(Promise.resolve(new Blob(["x"])));
      await sender.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sender.size).toBe(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
