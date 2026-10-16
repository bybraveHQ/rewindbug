import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const load = async () => (await import("./index.ts")).init;
const OPTIONS = { endpoint: "https://collect.example/report", replay: false };

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("init", () => {
  test("starts once and returns the first result", async () => {
    const init = await load();
    expect(init(OPTIONS)).toBe(true);
    vi.stubGlobal("CompressionStream", undefined);
    expect(init(OPTIONS)).toBe(true);
  });

  test.each(["CompressionStream", "MutationObserver", "fetch"])(
    "returns false without %s",
    async (api) => {
      vi.stubGlobal(api, undefined);
      const init = await load();
      expect(init(OPTIONS)).toBe(false);
    },
  );

  test("returns false without crypto.getRandomValues", async () => {
    vi.stubGlobal("crypto", {});
    const init = await load();
    expect(init(OPTIONS)).toBe(false);
  });

  test("does not wrap anything when unsupported", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const before = globalThis.fetch;
    const init = await load();
    init(OPTIONS);
    expect(globalThis.fetch).toBe(before);
  });
});

describe("init options", () => {
  test("returns false for a relative endpoint", async () => {
    const init = await load();
    expect(init({ endpoint: "/collect", replay: false })).toBe(false);
  });
});

describe("init failures", () => {
  test("returns false for a non-http endpoint", async () => {
    const init = await load();
    expect(init({ endpoint: "javascript:alert(1)", replay: false })).toBe(
      false,
    );
  });

  test("a throw while starting uninstalls what already started", async () => {
    const before = globalThis.fetch;
    const init = await load();
    const options = { endpoint: "https://collect.example/r", replay: false };
    Object.defineProperty(options, "tags", {
      get: () => {
        throw new Error("hostile options");
      },
    });
    expect(init(options)).toBe(false);
    expect(globalThis.fetch).toBe(before);
    expect(init({ endpoint: "https://collect.example/r" })).toBe(false);
  });
});
