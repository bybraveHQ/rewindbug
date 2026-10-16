import { describe, expect, test } from "vitest";
import { serializeArgs } from "./serialize.ts";
import { defaultUrlFilter } from "./url-filter.ts";

const s = (...args: unknown[]) => serializeArgs(args, defaultUrlFilter);

describe("serializeArgs", () => {
  test("joins top-level strings as is and quotes nested ones", () => {
    expect(s("user", { name: "a" }, 1, null, undefined)).toBe(
      'user {name: "a"} 1 null undefined',
    );
  });

  test("limits depth", () => {
    expect(s({ a: { b: { c: { d: 1 } } } })).toBe("{a: {b: {c: [Object]}}}");
  });

  test("limits keys and array items", () => {
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`k${i}`, i]),
    );
    expect(s(many)).toContain("k49: 49, …}");
    expect(s(many)).not.toContain("k50");
    expect(s(Array.from({ length: 60 }, (_, i) => i))).toMatch(/49, …\]$/);
  });

  test("handles circular refs, elements, errors and functions", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(s(loop)).toBe("{self: [Circular]}");
    expect(s(document.createElement("input"))).toBe("<input>");
    expect(s(new TypeError("boom"))).toBe("TypeError: boom");
    expect(s(function named() {})).toBe("[Function named]");
  });

  test("caps message length at 1000 including the ellipsis", () => {
    expect(s("x".repeat(5000))).toHaveLength(1000);
  });

  test("a shared reference is not reported as circular", () => {
    const x = { a: 1 };
    expect(s({ p: x, q: x })).toBe("{p: {a: 1}, q: {a: 1}}");
  });

  test("filters urls inside arguments", () => {
    expect(s("GET https://a.com/?token=1 failed")).toBe(
      "GET https://a.com/?token=* failed",
    );
  });
});
