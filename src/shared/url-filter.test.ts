import { describe, expect, test } from "vitest";
import {
  defaultUrlFilter,
  filterCssUrls,
  filterUrlsInText,
} from "./url-filter.ts";

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

  test("masks secrets by pattern in a url the parser refuses", () => {
    expect(defaultUrlFilter("http://[bad")).toBe("http://[bad");
    expect(
      defaultUrlFilter(
        "wss://rt.example.com:undefined/socket?token=abc&room=1",
      ),
    ).toBe("wss://rt.example.com:undefined/socket?token=*&room=1");
    expect(
      defaultUrlFilter("https://bob:pw@[bad/x?page=2&api_key=k#auth=t"),
    ).toBe("https://[bad/x?page=2&api_key=*#auth=*");
  });

  test("masks a secret nested in another parameter's value", () => {
    expect(defaultUrlFilter("https://a.com/login?next=/x?token=S&p=1")).toBe(
      "https://a.com/login?next=%2Fx%3Ftoken%3D*&p=1",
    );
    expect(
      defaultUrlFilter(
        "https://a.com/?callbackUrl=https%3A%2F%2Fb%2F%3Ftoken%3DS%26q%3D1",
      ),
    ).not.toContain("S");
    expect(defaultUrlFilter("https://a.com/?a=1;token=S")).toBe(
      "https://a.com/?a=1%3Btoken%3D*",
    );
    expect(defaultUrlFilter("https://a.com/?cb=token%3DS")).toBe(
      "https://a.com/?cb=token%3D*",
    );
    // the refused-url path too
    expect(defaultUrlFilter("http://[bad/x?next=/y?token=S")).toBe(
      "http://[bad/x?next=/y?token=*",
    );
  });

  test("a secret name sent twice is masked once; a url without secrets stays as written", () => {
    expect(defaultUrlFilter("https://a.com/?token=a&p=1&token=b")).toBe(
      "https://a.com/?token=*&p=1",
    );
    expect(defaultUrlFilter("https://a.com/?q=a+b%20c&x=%2F")).toBe(
      "https://a.com/?q=a+b%20c&x=%2F",
    );
  });

  test("a long url is cut before it is parsed, and masked in one pass", () => {
    const names = Array.from({ length: 7000 }, (_, i) => `a${i}-key=v${i}`);
    const url = `https://x.example/?${names.join("&")}`;
    const started = performance.now();
    const out = defaultUrlFilter(url);
    expect(performance.now() - started).toBeLessThan(500);
    expect(out.length).toBeLessThanOrEqual(8192 + 1);
    expect(out).not.toMatch(/=v\d/);
    // a secret past the cut is gone with the cut, not scanned
    const tail = `https://x.example/?${"p=1&".repeat(3000)}token=S`;
    expect(defaultUrlFilter(tail)).not.toContain("S");
  });

  test("masks a refused url quoted in an error message", () => {
    const message =
      "Failed to construct 'WebSocket': The URL 'wss://rt.example.com:undefined/s?jwt=eyJ' is invalid.";
    expect(filterUrlsInText(message, defaultUrlFilter)).not.toContain("eyJ");
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

  test("parentheses inside a url do not hide its query", () => {
    expect(
      filterUrlsInText(
        "GET https://a.com/files/(1)/x?token=S failed",
        defaultUrlFilter,
      ),
    ).toBe("GET https://a.com/files/(1)/x?token=* failed");
    // a parenthesis the url did not open stays outside, as in a css url()
    expect(
      filterUrlsInText("url(https://a.com/i.png?sig=S)", defaultUrlFilter),
    ).toBe("url(https://a.com/i.png?sig=*)");
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

  test("an apostrophe in a path does not hide the query", () => {
    expect(
      filterUrlsInText(
        "bg https://cdn.example/u/Mary's.jpg?Signature=S&Key-Pair-Id=K",
        defaultUrlFilter,
      ),
    ).toBe("bg https://cdn.example/u/Mary's.jpg?Signature=*&Key-Pair-Id=K");
  });

  test("an apostrophe that closes a quote stays outside the url", () => {
    expect(
      filterUrlsInText(
        "fetch('https://a.com/?token=S', opts) and 'https://a.com/?jwt=S'.",
        defaultUrlFilter,
      ),
    ).toBe("fetch('https://a.com/?token=*', opts) and 'https://a.com/?jwt=*'.");
    expect(
      filterUrlsInText("url('https://a.com/i.png?sig=S')", defaultUrlFilter),
    ).toBe("url('https://a.com/i.png?sig=*')");
  });

  test("masks a secret param in html-escaped text", () => {
    expect(
      filterUrlsInText("https://a.com/?a=1&amp;token=S", defaultUrlFilter),
    ).not.toContain("=S");
  });
});

describe("filterCssUrls", () => {
  test("filters relative and protocol-relative urls", () => {
    const out = filterCssUrls(
      "url(/f?token=S) url('//cdn.example/x?sig=S') url(\"a.png\")",
      defaultUrlFilter,
    );
    expect(out).not.toContain("=S");
    expect(out).toContain("//cdn.example/x?sig=*')");
    expect(out).toContain('a.png")');
  });

  test("leaves a reference to an element of the page as it is", () => {
    const css = "fill: url(#grad); clip-path: url('#clip')";
    expect(filterCssUrls(css, defaultUrlFilter)).toBe(css);
  });

  test("leaves urls with a scheme to the text filter", () => {
    const css = "url(https://a.com/?token=S) url(data:image/png;base64,QQ)";
    expect(filterCssUrls(css, defaultUrlFilter)).toBe(css);
  });
});
