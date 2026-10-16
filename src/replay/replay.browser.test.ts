import { record } from "@rrweb/record";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCapture, type Capture } from "../capture/index.ts";
import { defaultUrlFilter } from "../shared/url-filter.ts";
import { startReplay, type Replay } from "./index.ts";

type Event = { type: number; timestamp: number; data?: unknown };

const POLL_MS = 10;
const WAIT_MS = 3000;
const STORM_NODES = 10_001;
const LARGE_DOM = 25_001;
const CHUNK = 9000;
const WINDOW_WAIT_MS = 1100;
// each chunk stays under the storm limit, but rrweb stamps a mutation when
// it has serialized it: on a loaded CI runner two chunks 1.1 s apart landed
// in one storm window. The gap leaves a second for that jitter
const GROWTH_GAP_MS = 2000;
const SLOW_TEST_MS = 15_000;

let replay: Replay | undefined;
let capture: Capture | undefined;

const start = (
  overrides: { maskText?: string; bufferSeconds?: number } = {},
) => {
  replay = startReplay({
    bufferSeconds: overrides.bufferSeconds ?? 30,
    maskInputs: true,
    maskText: overrides.maskText ?? "",
    filter: defaultUrlFilter,
  });
  return replay;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (check: () => boolean) => {
  const deadline = performance.now() + WAIT_MS;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out");
    await sleep(POLL_MS);
  }
};

const recording = (r: Replay) =>
  until(() => r.snapshot(Infinity).state === "recording");

const events = (r: Replay): Event[] =>
  (r.snapshot(Infinity).events ?? []) as Event[];

const container = (children: number) => {
  const box = document.createElement("div");
  for (let i = 0; i < children; i++) box.append(document.createElement("b"));
  return box;
};

afterEach(() => {
  replay?.stop();
  capture?.stop();
  capture = undefined;
  replay = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("replay", () => {
  it("starts in idle time with Meta and FullSnapshot", async () => {
    const r = start();
    expect(r.snapshot(Infinity)).toMatchObject({
      state: "not-started",
      events: null,
    });
    await recording(r);
    expect(
      events(r)
        .slice(0, 2)
        .map((e) => e.type),
    ).toEqual([4, 2]);
  });

  it("records DOM mutations", async () => {
    const r = start();
    await recording(r);
    document.body.append(document.createElement("section"));
    await until(() => events(r).some((e) => e.type === 3));
  });

  it("masks input values by default", async () => {
    const input = document.createElement("input");
    input.value = "secret-value";
    document.body.append(input);
    const r = start();
    await recording(r);
    expect(JSON.stringify(events(r))).not.toContain("secret-value");
  });

  it("masks text under maskText", async () => {
    const p = document.createElement("p");
    p.className = "pii";
    p.textContent = "Jane Roe";
    document.body.append(p);
    const r = start({ maskText: ".pii" });
    await recording(r);
    expect(JSON.stringify(events(r))).not.toContain("Jane Roe");
  });

  it("does not record with an invalid maskText selector", async () => {
    const r = start({ maskText: "p[" });
    await until(() => r.snapshot(Infinity).state !== "not-started");
    expect(r.snapshot(Infinity)).toMatchObject({
      state: "stopped",
      events: null,
    });
  });

  it("cuts events after the trigger moment", async () => {
    const r = start();
    await recording(r);
    const [first] = events(r);
    expect(r.snapshot((first?.timestamp ?? 0) - 1).events).toEqual([]);
  });

  it("takes its own checkpoint after bufferSeconds", async () => {
    const r = start({ bufferSeconds: 1 });
    await recording(r);
    await sleep(WINDOW_WAIT_MS);
    document.body.append(document.createElement("section"));
    await until(() => events(r).filter((e) => e.type === 4).length === 2);
  });
});

describe("replay with capture", () => {
  it("writes finished requests as custom events", async () => {
    const r = start();
    capture = startCapture(
      { endpoint: "https://sink.test/r", onNetworkSettle: r.emitNet },
      () => undefined,
    );
    await recording(r);
    await fetch(location.href);
    const [net] = capture.snapshot().network;
    expect(net?.state).toBe("done");
    await until(() =>
      events(r).some(
        (e) =>
          e.type === 5 &&
          JSON.stringify(e.data) ===
            JSON.stringify({ tag: "rewindbug/net", payload: { id: net?.id } }),
      ),
    );
  });

  it("writes console entries through the capture serializer", async () => {
    const r = start({ maskText: ".pii" });
    capture = startCapture(
      { endpoint: "https://sink.test/r", onConsoleEntry: r.emitConsole },
      () => undefined,
    );
    await recording(r);
    const p = document.createElement("p");
    p.className = "pii";
    p.textContent = "Jane Roe";
    console.info("open https://app.test/?token=abc", p);
    const plugin = events(r).find((e) => e.type === 6);
    expect(plugin?.data).toEqual({
      plugin: "rrweb/console@1",
      payload: {
        level: "info",
        trace: [],
        payload: [JSON.stringify("open https://app.test/?token=* <p>")],
      },
    });
  });
});

describe("replay limits", () => {
  it("stops a storm before rrweb serializes it", async () => {
    const r = start();
    await recording(r);
    const add = vi.spyOn(record.mirror, "add");
    document.body.append(container(STORM_NODES));
    await until(() => r.snapshot(Infinity).state === "stopped");
    expect(add).not.toHaveBeenCalled();
    expect(r.snapshot(Infinity)).toEqual({
      state: "stopped",
      mutationStorm: true,
      events: null,
    });
    expect(() => r.emitNet(1)).not.toThrow();
    expect(record.mirror.getIds()).toEqual([]);
  });

  it("leaves nothing behind when a storm hits an overdue checkpoint", async () => {
    const attachShadow = Element.prototype.attachShadow;
    const r = start({ bufferSeconds: 1 });
    await recording(r);
    await sleep(WINDOW_WAIT_MS);
    document.body.append(container(STORM_NODES));
    await until(() => r.snapshot(Infinity).state === "stopped");
    await sleep(POLL_MS);
    expect(record.mirror.getIds()).toEqual([]);
    expect(Element.prototype.attachShadow).toBe(attachShadow);
  });

  it("releases recorded nodes on stop", async () => {
    const r = start();
    await recording(r);
    expect(record.mirror.getIds().length).toBeGreaterThan(0);
    r.stop();
    expect(record.mirror.getIds()).toEqual([]);
  });

  it("does not start on a too large DOM", async () => {
    document.body.append(container(LARGE_DOM));
    const r = start();
    await until(() => r.snapshot(Infinity).state !== "not-started");
    expect(r.snapshot(Infinity)).toEqual({
      state: "dom-too-large",
      mutationStorm: false,
      events: null,
    });
    expect(record.mirror.getIds()).toEqual([]);
  });

  it(
    "stops when the DOM grows too large",
    async () => {
      const r = start();
      await recording(r);
      for (let i = 0; i < 3; i++) {
        await sleep(GROWTH_GAP_MS);
        document.body.append(container(CHUNK));
      }
      await until(() => r.snapshot(Infinity).state !== "recording");
      expect(r.snapshot(Infinity)).toMatchObject({
        state: "dom-too-large",
        mutationStorm: false,
      });
      expect(record.mirror.getIds()).toEqual([]);
    },
    SLOW_TEST_MS,
  );

  it("cancels a pending start on stop", async () => {
    const r = start();
    r.stop();
    await sleep(POLL_MS * 5);
    expect(r.snapshot(Infinity)).toMatchObject({
      state: "stopped",
      mutationStorm: false,
    });
  });
});
