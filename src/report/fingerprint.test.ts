import { describe, expect, test } from "vitest";
import type { NetworkEntry, Trigger } from "../types.ts";
import {
  firstFrame,
  fingerprintOf,
  fnv1a,
  normalizePath,
  normalizeText,
  ReportGate,
} from "./fingerprint.ts";

const PAGE = "https://app.example/orders/42";

const error = (message: string, stack?: string): Trigger => ({
  kind: "error",
  at: 0,
  message,
  error: { name: "TypeError", message, ...(stack && { stack }) },
});

const request = (overrides: Partial<NetworkEntry> = {}): NetworkEntry => ({
  id: 1,
  t: 0,
  type: "fetch",
  method: "GET",
  url: "https://api.example/users/7/cart",
  state: "done",
  status: 503,
  ...overrides,
});

describe("fnv1a", () => {
  test("matches the reference 32-bit vectors", () => {
    expect(fnv1a("")).toBe("811c9dc5");
    expect(fnv1a("a")).toBe("e40c292c");
    expect(fnv1a("foobar")).toBe("bf9cf968");
  });
});

describe("normalization", () => {
  test("text: uuid, long hex, then numbers", () => {
    expect(
      normalizeText(
        "order 123e4567-e89b-12d3-a456-426614174000 hash deadbeef01 at 17",
      ),
    ).toBe("order x hash x at 0");
  });

  test("path: numeric and uuid segments become :id", () => {
    expect(
      normalizePath("/u/42/items/123e4567-e89b-12d3-a456-426614174000/v2"),
    ).toBe("/u/:id/items/:id/v2");
  });

  test("first frame skips the message line and strips position, query and hashes", () => {
    const chrome =
      "TypeError: x is undefined\n    at load (https://a.example/app.3f2a1b9c.js?v=2:10:5)";
    expect(firstFrame(chrome)).toBe("at load (https://a.example/app.x.js");
    const firefox = "load@https://a.example/chunk-ABCDEF12.js:3:7\n@debugger";
    expect(firstFrame(firefox)).toBe("load@https://a.example/chunk.x.js");
    const webkit = "global code@https://a.example/app.js:1:2";
    expect(firstFrame(webkit)).toBe("global code@https://a.example/app.js");
    expect(firstFrame(undefined)).toBe("");
    expect(firstFrame("no frames here")).toBe("");
  });
});

describe("fingerprintOf", () => {
  test("same bug with different ids and positions matches", () => {
    const a = error(
      "item 17 missing",
      "Error\n at f (https://a.example/app.js:1:2)",
    );
    const b = error(
      "item 99 missing",
      "Error\n at f (https://a.example/app.js:8:9)",
    );
    expect(fingerprintOf(a, PAGE, undefined)).toBe(
      fingerprintOf(b, "https://app.example/orders/7", undefined),
    );
  });

  test("a URL or an @ in a V8 message line is not taken for a frame", () => {
    const stack = (message: string) =>
      `Error: ${message}\n    at load (https://a.example/app.js:1:2)`;
    const a = error("GET https://api.example/items/1 failed");
    const b = error("GET https://api.example/items/2 failed");
    a.error = {
      name: "TypeError",
      message: a.message,
      stack: stack(a.message),
    };
    b.error = {
      name: "TypeError",
      message: b.message,
      stack: stack(b.message),
    };
    expect(fingerprintOf(a, PAGE, undefined)).toBe(
      fingerprintOf(b, PAGE, undefined),
    );
    expect(firstFrame(stack("bad bob@x.io"))).toBe(
      "at load (https://a.example/app.js",
    );
  });

  test("different messages differ", () => {
    expect(fingerprintOf(error("a"), PAGE, undefined)).not.toBe(
      fingerprintOf(error("b"), PAGE, undefined),
    );
  });

  test("network uses method, normalized path and status class", () => {
    const trigger: Trigger = {
      kind: "network",
      at: 0,
      message: "",
      requestId: 1,
    };
    const base = fingerprintOf(trigger, PAGE, request());
    expect(
      fingerprintOf(
        trigger,
        PAGE,
        request({ url: "https://api.example/users/8/cart", status: 500 }),
      ),
    ).toBe(base);
    expect(fingerprintOf(trigger, PAGE, request({ status: 404 }))).not.toBe(
      base,
    );
    const failed = request({ state: "failed", error: "network" });
    delete failed.status;
    expect(fingerprintOf(trigger, PAGE, failed)).not.toBe(base);
  });

  test("an evicted request falls back to the trigger message", () => {
    const trigger = (message: string): Trigger => ({
      kind: "network",
      at: 0,
      message,
      requestId: 1,
    });
    expect(fingerprintOf(trigger("GET /a/1 → 503"), PAGE, undefined)).toBe(
      fingerprintOf(trigger("GET /a/2 → 503"), PAGE, undefined),
    );
    expect(fingerprintOf(trigger("GET /a → 503"), PAGE, undefined)).not.toBe(
      fingerprintOf(trigger("POST /b → 500"), PAGE, undefined),
    );
  });
});

describe("ReportGate", () => {
  test("drops a repeat inside a minute, admits it after", () => {
    const gate = new ReportGate();
    expect(gate.admit("f", 0, true)).toBe(true);
    expect(gate.admit("f", 59_999, true)).toBe(false);
    expect(gate.admit("f", 60_000, true)).toBe(true);
  });

  test("caps at ten reports, deduped ones do not count", () => {
    const gate = new ReportGate();
    gate.admit("same", 0, true);
    for (let i = 0; i < 5; i++) gate.admit("same", 1, true);
    for (let i = 0; i < 9; i++) expect(gate.admit(`f${i}`, 2, true)).toBe(true);
    expect(gate.admit("manual", 3, false)).toBe(false);
  });

  test("a refund frees the slot and the dedup window", () => {
    const gate = new ReportGate();
    for (let i = 0; i < 10; i++) gate.admit(`f${i}`, 0, true);
    gate.refund("f9");
    expect(gate.admit("f9", 1, true)).toBe(true);
  });

  test("manual reports skip dedup but count", () => {
    const gate = new ReportGate();
    expect(gate.admit("id1", 0, false)).toBe(true);
    expect(gate.admit("id1", 0, false)).toBe(true);
  });
});
