import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Trigger } from "../types.ts";
import { startCapture, type Capture } from "./index.ts";

const ENDPOINT = "https://collect.example/report";
const NOW = 1_700_000_000_000;

let capture: Capture;
let triggers: Trigger[];
let fetchMock: ReturnType<typeof vi.fn>;

class FakeXhr extends EventTarget {
  static failSync = false;
  readyState = 0;
  status = 0;
  responseType = "";
  responseText = "";
  headers: Record<string, string> = {};
  #sent = false;
  #async = true;
  open(...args: [string, string, boolean?]) {
    const async = args[2] ?? true;
    this.readyState = 1;
    this.#sent = false;
    this.#async = async;
  }
  send() {
    if (this.readyState !== 1 || this.#sent)
      throw new DOMException("bad state", "InvalidStateError");
    this.#sent = true;
    if (!this.#async && FakeXhr.failSync)
      throw new DOMException("offline", "NetworkError");
  }
  getResponseHeader(name: string) {
    return this.headers[name] ?? null;
  }
  respond(status: number, text = "", type = "application/json") {
    this.readyState = 4;
    this.status = status;
    this.responseText = text;
    this.headers["content-type"] = type;
    this.dispatchEvent(new Event("loadend"));
  }
}

const start = (options: Partial<Parameters<typeof startCapture>[0]> = {}) => {
  capture = startCapture(
    { endpoint: ENDPOINT, now: () => NOW, ...options },
    (t) => triggers.push(t),
  );
};

beforeEach(() => {
  triggers = [];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  FakeXhr.failSync = false;
});

afterEach(() => {
  capture.stop();
  vi.unstubAllGlobals();
});

describe("errors", () => {
  test("uncaught error with an Error object", () => {
    start();
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new TypeError("x is undefined"),
        message: "x",
      }),
    );
    expect(triggers).toEqual([
      expect.objectContaining({
        kind: "error",
        at: NOW,
        message: "x is undefined",
        error: expect.objectContaining({ name: "TypeError" }),
      }),
    ]);
  });

  test("browser noise without an Error object is not a trigger", () => {
    start();
    for (const message of [
      "",
      "Script error.",
      "Script error",
      "ResizeObserver loop completed with undelivered notifications.",
      "ResizeObserver loop limit exceeded",
    ]) {
      window.dispatchEvent(new ErrorEvent("error", { message }));
    }
    expect(triggers).toEqual([]);
  });

  test("Next.js redirect and not-found signals are not triggers", () => {
    start();
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/done;307;",
    });
    const notFound = Object.assign(new Error("not found"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    window.dispatchEvent(new ErrorEvent("error", { error: notFound }));
    for (const reason of [redirect, new Error("NEXT_NOT_FOUND")]) {
      const event = Object.assign(new Event("unhandledrejection"), { reason });
      window.dispatchEvent(event);
    }
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("NEXT_PUBLIC_KEY missing") }),
    );
    expect(triggers).toEqual([
      expect.objectContaining({ message: "NEXT_PUBLIC_KEY missing" }),
    ]);
  });

  test("an error event with a message but no object is a trigger", () => {
    start();
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));
    expect(triggers[0]).toEqual({ kind: "error", at: NOW, message: "boom" });
  });

  test("a throwing urlFilter does not escape the error handlers", () => {
    start({
      urlFilter: () => {
        throw new Error("bad filter");
      },
    });
    const errors: unknown[] = [];
    const onError = (event: Event) => errors.push(event);
    window.addEventListener("error", onError);
    try {
      window.dispatchEvent(
        new ErrorEvent("error", {
          error: new Error("see https://a.example/x"),
        }),
      );
      const event = Object.assign(new Event("unhandledrejection"), {
        reason: new Error("see https://a.example/y"),
      });
      window.dispatchEvent(event);
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(errors).toHaveLength(1);
    expect(triggers).toEqual([]);
  });

  test("unhandled rejection with a non-error value", () => {
    start();
    const event = Object.assign(new Event("unhandledrejection"), {
      reason: { code: 42 },
    });
    window.dispatchEvent(event);
    expect(triggers[0]).toMatchObject({
      kind: "unhandledrejection",
      error: { name: "NonError", message: "{code: 42}" },
    });
  });

  test("resource load errors are ignored", () => {
    start();
    window.dispatchEvent(new Event("error"));
    expect(triggers).toEqual([]);
  });
});

describe("manual", () => {
  test("without an argument", () => {
    start();
    capture.manual();
    expect(triggers).toEqual([
      { kind: "manual", at: NOW, message: "manual capture" },
    ]);
  });

  test("with an Error and with a non-Error value", () => {
    start();
    capture.manual(new RangeError("too far"));
    capture.manual({ code: 7 });
    expect(triggers).toEqual([
      expect.objectContaining({
        kind: "manual",
        message: "too far",
        error: expect.objectContaining({ name: "RangeError" }),
      }),
      expect.objectContaining({
        kind: "manual",
        message: "{code: 7}",
        error: { name: "NonError", message: "{code: 7}" },
      }),
    ]);
  });

  test("never throws into the caller", () => {
    capture = startCapture({ endpoint: ENDPOINT }, () => {
      throw new Error("report down");
    });
    expect(() => capture.manual()).not.toThrow();
  });
});

describe("console", () => {
  test("records entries and still calls the original", () => {
    const original = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(original);
    start();
    console.warn("disk", { free: 1 });
    expect(original).toHaveBeenCalledWith("disk", { free: 1 });
    expect(capture.snapshot().console).toEqual([
      { t: NOW, level: "warn", message: "disk {free: 1}" },
    ]);
  });

  test("hands each entry to the entry hook, a failing hook keeps the trigger", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const entries: unknown[] = [];
    start({
      consoleErrorTrigger: true,
      onConsoleEntry: (entry) => {
        entries.push(entry);
        throw new Error("rrweb gone");
      },
    });
    console.error("boom");
    expect(entries).toEqual([{ t: NOW, level: "error", message: "boom" }]);
    expect(triggers).toHaveLength(1);
  });

  test("console.error is not a trigger by default", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    start();
    console.error("noise");
    expect(triggers).toEqual([]);
    expect(capture.snapshot().console).toHaveLength(1);
  });

  test("console.error triggers when enabled and uses the Error argument", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    start({ consoleErrorTrigger: true });
    console.error("failed:", new RangeError("bad"));
    expect(triggers[0]).toMatchObject({
      kind: "console.error",
      error: { name: "RangeError", message: "bad" },
    });
  });

  test("buffer keeps the last 200 entries and reports eviction", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    start();
    for (let i = 0; i < 205; i++) console.log(i);
    const snap = capture.snapshot();
    expect(snap.console).toHaveLength(200);
    expect(snap.console[0]?.message).toBe("5");
    expect(snap.lastEvicted.console).toBe(NOW);
  });

  test("stop restores the original console", () => {
    const before = console.info;
    start();
    capture.stop();
    expect(console.info).toBe(before);
  });
});

describe("fetch", () => {
  test("reports each settled request id to the settle hook", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const settled: number[] = [];
    start({ onNetworkSettle: (id) => settled.push(id) });
    await fetch("https://api.example/a");
    await expect(fetch("https://api.example/b")).rejects.toThrow();
    const xhr = new XMLHttpRequest() as unknown as FakeXhr;
    xhr.open("GET", "https://api.example/c");
    xhr.send();
    xhr.respond(200);
    expect(settled).toEqual([1, 2, 3]);
  });

  test("records a finished request", async () => {
    fetchMock.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    start();
    await fetch("https://api.example/items?token=s", { method: "post" });
    expect(capture.snapshot().network).toEqual([
      expect.objectContaining({
        id: 1,
        type: "fetch",
        method: "POST",
        url: "https://api.example/items?token=*",
        state: "done",
        status: 200,
        contentType: "application/json",
      }),
    ]);
    expect(triggers).toEqual([]);
  });

  test("5xx is a trigger with a readable message", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));
    start();
    await fetch("https://api.example/pay");
    expect(triggers[0]).toMatchObject({
      kind: "network",
      requestId: 1,
      message: "GET /pay → 503",
    });
  });

  test("network failure triggers, abort does not", async () => {
    start();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(fetch("/a")).rejects.toThrow("Failed to fetch");
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    await expect(fetch("/b")).rejects.toThrow("aborted");
    const network = capture.snapshot().network;
    expect(network.map((e) => e.error)).toEqual(["network", "abort"]);
    expect(triggers).toHaveLength(1);
  });

  test("a failure counts on the page's site only, a 5xx anywhere", async () => {
    vi.stubGlobal("location", new URL("https://app.shop.example/cart"));
    start();
    const fail = async (url: string) => {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await fetch(url).catch(() => undefined);
    };
    await fail("https://www.google-analytics.com/collect");
    await fail("https://api.shop.example/orders");
    await fail("https://shop.example/x");
    await fail("https://app.shop.example:8443/x");
    fetchMock.mockResolvedValueOnce(new Response("", { status: 502 }));
    await fetch("https://payments.other.example/charge");
    expect(triggers.map((t) => t.message)).toEqual([
      "GET /orders → network",
      "GET /x → network",
      "GET /x → network",
      "GET /charge → 502",
    ]);
  });

  test("on an IP host a failure counts on that host only", async () => {
    vi.stubGlobal("location", new URL("http://10.0.0.1:5500/"));
    start();
    for (const url of ["http://20.0.0.1/a", "http://10.0.0.1:7000/b"]) {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await fetch(url).catch(() => undefined);
    }
    expect(triggers.map((t) => t.message)).toEqual(["GET /b → network"]);
  });

  test("an uncaught failed fetch does not report twice", async () => {
    start();
    const failure = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValueOnce(failure);
    await expect(fetch("/a")).rejects.toBe(failure);
    const rejection = (reason: unknown) =>
      Object.assign(new Event("unhandledrejection"), {
        reason,
        promise: Promise.resolve(),
      });
    window.dispatchEvent(rejection(failure));
    expect(triggers.map((t) => t.kind)).toEqual(["network"]);
    window.dispatchEvent(rejection(new TypeError("Failed to fetch")));
    expect(triggers.map((t) => t.kind)).toEqual([
      "network",
      "unhandledrejection",
    ]);
  });

  test("a failed fetch that is not a trigger still reports its rejection", async () => {
    start({ networkTrigger: () => false });
    const failure = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValueOnce(failure);
    await expect(fetch("https://api.example/a")).rejects.toBe(failure);
    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), {
        reason: failure,
        promise: Promise.resolve(),
      }),
    );
    expect(triggers.map((t) => t.kind)).toEqual(["unhandledrejection"]);
  });

  test("own endpoint is not recorded", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    start();
    await fetch(ENDPOINT, { method: "POST", body: "x" });
    expect(capture.snapshot().network).toEqual([]);
    expect(triggers).toEqual([]);
  });

  test("bodies only for allowlisted urls", async () => {
    const json = () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "11" },
      });
    fetchMock.mockImplementation(async () => json());
    start({ bodyAllowlist: ["https://api.example/debug"] });
    await fetch("https://api.example/debug/x", {
      method: "POST",
      body: '{"q":1}',
    });
    await fetch("https://api.example/other", {
      method: "POST",
      body: '{"q":2}',
    });
    await vi.waitFor(() =>
      expect(capture.snapshot().network[0]?.responseBody).toBe('{"ok":true}'),
    );
    const [allowed, other] = capture.snapshot().network;
    expect(allowed?.requestBody).toBe('{"q":1}');
    expect(other?.requestBody).toBeUndefined();
    expect(other?.responseBody).toBeUndefined();
  });

  test("stop restores the original fetch", () => {
    start();
    capture.stop();
    expect(globalThis.fetch).toBe(fetchMock);
  });
});

describe("xhr", () => {
  test("records status, failure and keeps own endpoint out", () => {
    start();
    const fake = (xhr: XMLHttpRequest) => xhr as unknown as FakeXhr;
    const ok = new XMLHttpRequest();
    ok.open("get", "https://api.example/list");
    ok.send();
    fake(ok).respond(200);
    const broken = new XMLHttpRequest();
    broken.open("POST", "/save");
    broken.send("{}");
    broken.dispatchEvent(new Event("error"));
    broken.dispatchEvent(new Event("loadend"));
    const own = new XMLHttpRequest();
    own.open("POST", ENDPOINT);
    own.send("x");
    fake(own).respond(500);

    const network = capture.snapshot().network;
    expect(network).toHaveLength(2);
    expect(network[0]).toMatchObject({
      type: "xhr",
      method: "GET",
      state: "done",
      status: 200,
    });
    expect(network[1]).toMatchObject({
      method: "POST",
      state: "failed",
      error: "network",
    });
    expect(triggers).toEqual([
      expect.objectContaining({ kind: "network", requestId: 2 }),
    ]);
  });

  test("stop restores prototype methods", () => {
    const { open, send } = FakeXhr.prototype;
    start();
    capture.stop();
    expect(FakeXhr.prototype.open).toBe(open);
    expect(FakeXhr.prototype.send).toBe(send);
  });

  test("a reused xhr keeps each request separate", () => {
    start();
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example/a");
    xhr.send();
    (xhr as unknown as FakeXhr).respond(500);
    xhr.open("GET", "https://api.example/b");
    xhr.send();
    (xhr as unknown as FakeXhr).respond(200);
    const network = capture.snapshot().network;
    expect(network.map((e) => [e.url, e.status])).toEqual([
      ["https://api.example/a", 500],
      ["https://api.example/b", 200],
    ]);
    expect(triggers).toHaveLength(1);
  });

  test("open on an in-flight request closes the previous entry as abort", () => {
    start();
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example/a");
    xhr.send();
    xhr.open("GET", "https://api.example/b");
    expect(capture.snapshot().network[0]).toMatchObject({
      state: "failed",
      error: "abort",
    });
    expect(triggers).toEqual([]);
  });

  test("a second send throws without adding an entry", () => {
    start();
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example/a");
    xhr.send();
    expect(() => xhr.send()).toThrow("bad state");
    expect(capture.snapshot().network).toHaveLength(1);
  });

  test("a failing synchronous xhr is recorded and rethrown", () => {
    FakeXhr.failSync = true;
    start();
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/sync", false);
    expect(() => xhr.send()).toThrow("offline");
    expect(capture.snapshot().network[0]).toMatchObject({
      state: "failed",
      error: "network",
    });
    expect(triggers).toHaveLength(1);
  });
});

describe("host safety", () => {
  test("a throwing settle hook keeps the request and its trigger", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    start({
      onNetworkSettle: () => {
        throw new Error("rrweb gone");
      },
    });
    await expect(fetch("https://api.example/x")).resolves.toBeInstanceOf(
      Response,
    );
    expect(triggers).toHaveLength(1);
  });

  test("a throwing trigger callback does not break fetch", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    capture = startCapture(
      {
        endpoint: ENDPOINT,
        networkTrigger: () => {
          throw new Error("boom");
        },
      },
      () => undefined,
    );
    await expect(fetch("https://api.example/x")).resolves.toBeInstanceOf(
      Response,
    );
    capture.stop();
    capture = startCapture({ endpoint: ENDPOINT }, () => {
      throw new Error("report down");
    });
    await expect(fetch("https://api.example/x")).resolves.toBeInstanceOf(
      Response,
    );
  });

  test("stop keeps a wrapper installed on top of ours and goes quiet", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    start();
    const ours = globalThis.fetch;
    const foreign = ((...args: Parameters<typeof fetch>) =>
      ours(...args)) as typeof fetch;
    globalThis.fetch = foreign;
    capture.stop();
    expect(globalThis.fetch).toBe(foreign);
    await fetch("https://api.example/x");
    expect(triggers).toEqual([]);
  });

  test("two captures stop in any order without reviving each other", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const first = startCapture(
      { endpoint: ENDPOINT, consoleErrorTrigger: false },
      () => undefined,
    );
    capture = startCapture({ endpoint: ENDPOINT }, () => undefined);
    first.stop();
    console.log("after first stop");
    expect(first.snapshot().console).toEqual([]);
    expect(capture.snapshot().console.map((e) => e.message)).toEqual([
      "after first stop",
    ]);
    capture.stop();
    console.log("after both");
    expect(first.snapshot().console).toEqual([]);
  });

  test("a request settling after stop does not trigger", async () => {
    let resolve: (r: Response) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    start();
    const pending = fetch("https://api.example/slow");
    capture.stop();
    resolve(new Response("", { status: 500 }));
    await pending;
    expect(triggers).toEqual([]);
  });
});

describe("fetch details", () => {
  test("abort with a custom reason is an abort, not a network error", async () => {
    const controller = new AbortController();
    controller.abort("user left");
    fetchMock.mockRejectedValue("user left");
    start();
    await expect(
      fetch("https://api.example/x", { signal: controller.signal }),
    ).rejects.toBe("user left");
    expect(capture.snapshot().network[0]?.error).toBe("abort");
    expect(triggers).toEqual([]);
  });

  test("the response body is in the entry when the trigger fires", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":"db"}', {
        status: 500,
        headers: { "content-type": "application/json", "content-length": "14" },
      }),
    );
    let bodyAtTrigger: string | undefined;
    capture = startCapture(
      { endpoint: ENDPOINT, bodyAllowlist: ["https://api.example"] },
      () => {
        bodyAtTrigger = capture.snapshot().network[0]?.responseBody;
      },
    );
    await fetch("https://api.example/pay");
    expect(bodyAtTrigger).toBe('{"error":"db"}');
  });

  test("response body is capped even when content-length is small", async () => {
    fetchMock.mockResolvedValue(
      new Response("x".repeat(20_000), {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "900" },
      }),
    );
    start({ bodyAllowlist: ["https://api.example"] });
    await fetch("https://api.example/big");
    expect(capture.snapshot().network[0]?.responseBody).toHaveLength(10_000);
  });

  test("string allowlist rules stop at a path boundary, regexps with g work every time", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 200 }));
    start({ bodyAllowlist: ["https://api.example", /\/rx\//g] });
    await fetch("https://api.example.evil.com/a", {
      method: "POST",
      body: "evil",
    });
    await fetch("https://api.example/a", { method: "POST", body: "ok" });
    for (let i = 0; i < 3; i++)
      await fetch("https://other.example/rx/", {
        method: "POST",
        body: `r${i}`,
      });
    expect(capture.snapshot().network.map((e) => e.requestBody)).toEqual([
      undefined,
      "ok",
      "r0",
      "r1",
      "r2",
    ]);
  });

  test("urls are cut to 2000 characters", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    start();
    await fetch(`https://api.example/?q=${"a".repeat(5000)}`);
    expect(capture.snapshot().network[0]?.url).toHaveLength(2000);
  });

  test("relative urls resolve against <base href>", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    const base = document.createElement("base");
    base.href = "https://cdn.example/api/";
    document.head.append(base);
    try {
      start();
      await fetch("items");
      expect(capture.snapshot().network[0]?.url).toBe(
        "https://cdn.example/api/items",
      );
    } finally {
      base.remove();
    }
  });

  test("network buffer reports eviction", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 200 }));
    start();
    for (let i = 0; i < 201; i++) await fetch(`https://api.example/${i}`);
    const snap = capture.snapshot();
    expect(snap.network).toHaveLength(200);
    expect(snap.lastEvicted.network).toBe(NOW);
  });
});
