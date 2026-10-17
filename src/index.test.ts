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
  test("accepts an endpoint relative to the page", async () => {
    const init = await load();
    expect(init({ endpoint: "/collect", replay: false })).toBe(true);
  });

  test("sampleRate 0 starts nothing, 1 starts", async () => {
    const before = globalThis.fetch;
    expect((await load())({ ...OPTIONS, sampleRate: 0 })).toBe(false);
    expect(globalThis.fetch).toBe(before);
    vi.resetModules();
    expect((await load())({ ...OPTIONS, sampleRate: 1 })).toBe(true);
  });

  test("debug says why init did not start, silence without it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    (await load())({ endpoint: "ftp://x/", replay: false });
    expect(warn).not.toHaveBeenCalled();
    vi.resetModules();
    (await load())({ endpoint: "ftp://x/", replay: false, debug: true });
    expect(warn).toHaveBeenCalledWith(
      "rewindbug: not started, endpoint is not http(s)",
    );
    warn.mockRestore();
  });

  test("init without options returns false", async () => {
    const init = await load();
    expect(init(undefined as never)).toBe(false);
  });

  test("custom urlFilter and networkTrigger get the defaults", async () => {
    const api = await import("./index.ts");
    const urlFilter = vi.fn((url: string, base: (u: string) => string) =>
      base(url),
    );
    const networkTrigger = vi.fn(() => false);
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("", { status: 500 }),
    );
    api.init({ ...OPTIONS, urlFilter, networkTrigger });
    await fetch("https://api.example/x");
    expect(urlFilter).toHaveBeenCalledWith(
      "https://api.example/x",
      api.defaultUrlFilter,
    );
    expect(networkTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500 }),
      api.defaultNetworkTrigger,
    );
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
