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

describe("console format strings", () => {
  const keep = defaultUrlFilter;
  test("react's caught-error log reads like the browser shows it", () => {
    const message = serializeArgs(
      [
        "%o\n\n%s\n\n%s\n",
        new TypeError("x is undefined"),
        "    at Profile",
        "The above error occurred in the <Profile> component.",
      ],
      keep,
    );
    expect(message).not.toMatch(/%[os]/);
    expect(message).toBe(
      "TypeError: x is undefined\n\n    at Profile\n\nThe above error occurred in the <Profile> component.\n",
    );
  });

  test("%c drops its css, %d %i %f parse numbers, %% is one percent", () => {
    expect(serializeArgs(["%c styled", "color: red"], keep)).toBe(" styled");
    expect(serializeArgs(["%d%% done", "50.7"], keep)).toBe("50% done");
    expect(serializeArgs(["%i and %f", 3.9, "2.5"], keep)).toBe("3 and 2.5");
    expect(serializeArgs(["%s", { a: 1 }], keep)).toBe("{a: 1}");
  });

  test("extra arguments follow, a placeholder without one stays", () => {
    expect(serializeArgs(["%s:", "a", "b"], keep)).toBe("a: b");
    expect(serializeArgs(["%s and %s", "a"], keep)).toBe("a and %s");
  });

  test("a lone string is not a format string", () => {
    expect(serializeArgs(["100%% done"], keep)).toBe("100%% done");
    expect(serializeArgs([42, "%s"], keep)).toBe("42 %s");
  });
});
