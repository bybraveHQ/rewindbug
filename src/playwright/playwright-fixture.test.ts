import { describe, expect, test } from "vitest";
import type { Report } from "../types.ts";
import {
  failureOf,
  initScript,
  looksLikeReport,
  maskPattern,
  uniqueReports,
} from "./parts.ts";
import { embedJson, nonceOf, reportPage } from "../report/page.ts";
import { defaultUrlFilter } from "../shared/url-filter.ts";

const report = (fingerprint: string, message = "boom") =>
  ({
    fingerprint,
    trigger: { kind: "error", at: 0, message },
  }) as Report;

const PLAYER = { script: "window.rrwebReplay = {};", style: ".x {}" };
const NONCE = "00ff";

describe("report page", () => {
  test("the page loads nothing: player and styles are inline", () => {
    const page = reportPage([report("a")], "t", PLAYER, NONCE);
    expect(page).toContain(
      `<script nonce="${NONCE}">window.rrwebReplay = {};</script>`,
    );
    expect(page).toContain("<style>.x {}</style>");
    expect(page).not.toMatch(/<(script|link|img)[^>]* (src|href)=/);
    expect(page).not.toMatch(/\bimport\(|jsdelivr/);
  });

  test("only the page's own scripts may run", () => {
    const page = reportPage([report("a")], "t", PLAYER, NONCE);
    expect(page).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${NONCE}';`,
    );
    const scripts = page.match(/<script[^>]*>/g) ?? [];
    expect(scripts).toEqual([
      '<script id="reports" type="application/json">',
      `<script nonce="${NONCE}">`,
      `<script nonce="${NONCE}">`,
    ]);
    expect(nonceOf(new Uint8Array([0, 255, 16]))).toBe("00ff10");
  });

  test("recorded markup cannot close the data script", () => {
    const value = { html: "</script><script>alert(1)</script>" };
    const json = embedJson(value);
    expect(json).not.toContain("</script");
    expect(JSON.parse(json)).toEqual(value);
  });

  test("the title is escaped", () => {
    const page = reportPage(
      [report("a")],
      `<img src=x onerror="1">`,
      PLAYER,
      NONCE,
    );
    expect(page).toContain(
      "<title>&lt;img src=x onerror=&quot;1&quot;&gt;</title>",
    );
    expect(page).not.toContain("<img");
  });
});

describe("fixture parts", () => {
  test("the failure drops terminal colors and keeps the stack", () => {
    const failure = failureOf({
      error: {
        message:
          "Error: \u001b[31mexpect(locator).toBeVisible()\u001b[39m failed",
        stack: "Error: x\n    at spec.ts:3:5",
      },
    });
    expect(failure).toEqual({
      name: "PlaywrightTestFailure",
      message: "expect(locator).toBeVisible() failed",
      stack: "Error: x\n    at spec.ts:3:5",
    });
    expect(failureOf({}).message).toBe("test failed");
  });

  test("the same error caught twice is attached once, first one kept", () => {
    const reports = [report("a", "first"), report("b"), report("a", "again")];
    expect(uniqueReports(reports).map((r) => r.trigger.message)).toEqual([
      "first",
      "boom",
    ]);
  });

  test("only what our build sends looks like a report", () => {
    const sent = {
      fingerprint: "a",
      trigger: { kind: "error", at: 0, message: "boom" },
      sdk: { name: "rewindbug", version: "0", rrwebVersion: "0" },
    };
    expect(looksLikeReport(sent)).toBe(true);
    for (const value of [
      null,
      "report",
      { ...sent, fingerprint: 1 },
      { ...sent, trigger: { message: ["x"] } },
      { ...sent, sdk: { name: "other" } },
    ])
      expect(looksLikeReport(value)).toBe(false);
  });

  test("only the options that are set reach init", () => {
    const script = initScript("var rewindbug = {};", {
      attach: "always",
      maskSelector: ".secret",
    });
    expect(script).toContain('"maskSelector":".secret"');
    expect(script).not.toMatch(/bufferSeconds|attach|urlFilter/);
    expect(script).toContain("beforeSend");
  });

  test("maskParams masks the named values only, names taken literally", () => {
    const pattern = maskPattern(["x-vercel-protection-bypass", "a.b", ""]);
    expect(pattern).toBeDefined();
    const mask = (url: string) =>
      url.replace(new RegExp(pattern ?? "", "gi"), "$1*");
    expect(
      mask("https://s.dev/p?x=1&X-Vercel-Protection-Bypass=tok&page=2"),
    ).toBe("https://s.dev/p?x=1&X-Vercel-Protection-Bypass=*&page=2");
    expect(mask("https://s.dev/p;a.b=1?aXb=2")).toBe(
      "https://s.dev/p;a.b=*?aXb=2",
    );
    expect(maskPattern([])).toBeUndefined();
    expect(maskPattern([""])).toBeUndefined();
  });

  test("a bracketed name is masked after the default filter re-encodes the query", () => {
    const pattern = maskPattern(["auth[token]"]);
    const mask = (url: string) =>
      defaultUrlFilter(url).replace(new RegExp(pattern ?? "", "gi"), "$1*");
    // `code` is a default secret: masking it re-serializes auth[token]
    expect(mask("https://s.dev/api?auth[token]=SECRET&code=xyz&p=1")).toBe(
      "https://s.dev/api?auth%5Btoken%5D=*&code=*&p=1",
    );
    expect(mask("https://s.dev/api?auth[token]=SECRET&p=1")).toBe(
      "https://s.dev/api?auth[token]=*&p=1",
    );
  });

  test("maskParams reaches init as a filter over the default one", () => {
    const script = initScript("var rewindbug = {};", {
      maskParams: ['a"); alert(1); ("'],
    });
    const line = script.split("\n").find((l) => l.includes("urlFilter")) ?? "";
    expect(line).toMatch(
      /^\s*urlFilter: \(url, filter\) => filter\(url\)\.replace\(new RegExp\("/,
    );
    // the name is data inside a JSON string, never code
    expect(line).not.toContain('a"); alert');
  });
});
