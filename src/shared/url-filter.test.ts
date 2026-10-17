import { describe, expect, test } from "vitest";
import { defaultUrlFilter, filterUrlsInText } from "./url-filter.ts";

describe("defaultUrlFilter", () => {
  test("masks secret query params and keeps the rest", () => {
    const out = defaultUrlFilter("https://a.com/p?token=abc&api_key=k&page=2");
    expect(out).toBe("https://a.com/p?token=*&api_key=*&page=2");
  });

  test("does not mask params that only contain a secret word", () => {
    const out = defaultUrlFilter(
      "https://a.com/?postcode=123&keyword=x&code=9",
    );
    expect(out).toBe("https://a.com/?postcode=123&keyword=x&code=*");
  });

  test("drops a fragment with key=value pairs", () => {
    expect(defaultUrlFilter("https://a.com/cb#access_token=x&state=y")).toBe(
      "https://a.com/cb",
    );
    expect(defaultUrlFilter("https://a.com/doc#section")).toBe(
      "https://a.com/doc#section",
    );
  });

  test("resolves relative urls against the page", () => {
    expect(defaultUrlFilter("/api?session=1")).toBe(
      `${location.origin}/api?session=*`,
    );
  });

  test("strips credentials from the url", () => {
    expect(defaultUrlFilter("https://bob:hunter2@api.example/x")).toBe(
      "https://api.example/x",
    );
  });

  test("returns unparsable input unchanged", () => {
    expect(defaultUrlFilter("http://[bad")).toBe("http://[bad");
  });
});

describe("filterUrlsInText", () => {
  test("filters urls inside text and keeps stack line:col outside", () => {
    const text = "at f (https://a.com/app.js?token=t:10:5)";
    expect(filterUrlsInText(text, defaultUrlFilter)).toBe(
      "at f (https://a.com/app.js?token=*:10:5)",
    );
  });

  test("finds urls regardless of scheme case", () => {
    expect(filterUrlsInText("HTTPS://a.com/?token=S", defaultUrlFilter)).toBe(
      "https://a.com/?token=*",
    );
  });

  test("masks socket urls too", () => {
    expect(
      filterUrlsInText(
        "WebSocket failed: wss://rt.example/ws?token=S and ws://localhost:4000/socket?auth=S",
        defaultUrlFilter,
      ),
    ).toBe(
      "WebSocket failed: wss://rt.example/ws?token=* and ws://localhost:4000/socket?auth=*",
    );
  });

  test("stops a url at quotes", () => {
    const text = '{"url":"https://a.com/?jwt=x"}';
    expect(filterUrlsInText(text, defaultUrlFilter)).toBe(
      '{"url":"https://a.com/?jwt=*"}',
    );
  });

  test("stops a url at a backslash so escaped text stays intact", () => {
    const text = '{"m":"see \\"https://a.com/?token=abc\\""}';
    expect(filterUrlsInText(text, defaultUrlFilter)).toBe(
      '{"m":"see \\"https://a.com/?token=*\\""}',
    );
  });
});
