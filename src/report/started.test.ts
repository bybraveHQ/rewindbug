import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defaultUrlFilter } from "../shared/url-filter.ts";
import { sendStarted } from "./started.ts";

const beacon = vi.fn<(url: string, body: Blob) => boolean>(() => true);

const sent = async (): Promise<{
  url: string;
  body: unknown;
  type: string;
}> => {
  const [url, blob] = beacon.mock.calls[0] ?? [];
  if (!url || !blob) throw new Error("no beacon");
  return { url, body: JSON.parse(await blob.text()), type: blob.type };
};

beforeEach(() => {
  beacon.mockClear();
  vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
  history.replaceState(null, "", "/orders/42?token=secret#tab");
});

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("sendStarted", () => {
  test("beacons host, path and sdk version to <endpoint>/started", async () => {
    sendStarted("http://127.0.0.1:7357/abc", defaultUrlFilter);
    const { url, body, type } = await sent();
    expect(url).toBe("http://127.0.0.1:7357/abc/started");
    expect(type).toBe("text/plain");
    expect(body).toEqual({
      host: location.hostname,
      path: "/orders/42",
      sdk: __REWINDBUG_VERSION__,
    });
  });

  test("keeps the query of the endpoint and drops a trailing slash", async () => {
    sendStarted("https://collect.example/report/?k=1", defaultUrlFilter);
    expect((await sent()).url).toBe(
      "https://collect.example/report/started?k=1",
    );
  });

  test("sends the path through the url filter, never the query", async () => {
    sendStarted("https://collect.example/report", (url) =>
      url.replace("/orders/42", "/orders/:id"),
    );
    const { body } = await sent();
    expect(body).toMatchObject({ path: "/orders/:id" });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  test("swallows a beacon that throws and a filter that breaks the url", () => {
    beacon.mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    expect(() =>
      sendStarted("https://collect.example/report", defaultUrlFilter),
    ).not.toThrow();
    expect(() =>
      sendStarted("https://collect.example/report", () => "not a url"),
    ).not.toThrow();
  });
});
