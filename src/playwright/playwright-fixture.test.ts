import { describe, expect, test } from "vitest";
import type { Report } from "../types.ts";
import {
  failureOf,
  initScript,
  looksLikeReport,
  uniqueReports,
} from "./parts.ts";
import { embedJson, reportPage } from "../report/page.ts";

const report = (fingerprint: string, message = "boom") =>
  ({
    fingerprint,
    trigger: { kind: "error", at: 0, message },
  }) as Report;

const PLAYER = { script: "window.rrwebReplay = {};", style: ".x {}" };

describe("report page", () => {
  test("the page loads nothing: player and styles are inline", () => {
    const page = reportPage([report("a")], "t", PLAYER);
    expect(page).toContain("<script>window.rrwebReplay = {};</script>");
    expect(page).toContain("<style>.x {}</style>");
    expect(page).not.toMatch(/<(script|link|img)[^>]* (src|href)=/);
    expect(page).not.toMatch(/\bimport\(|jsdelivr/);
  });

  test("recorded markup cannot close the data script", () => {
    const value = { html: "</script><script>alert(1)</script>" };
    const json = embedJson(value);
    expect(json).not.toContain("</script");
    expect(JSON.parse(json)).toEqual(value);
  });

  test("the title is escaped", () => {
    const page = reportPage([report("a")], `<img src=x onerror="1">`, PLAYER);
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
    expect(script).not.toMatch(/bufferSeconds|attach/);
    expect(script).toContain("beforeSend");
  });
});
