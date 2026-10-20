import { describe, expect, test, vi } from "vitest";
import type { Report } from "../types.ts";
import { reportHtml } from "./index.ts";

// the real player is inlined at build time; the built page is checked in e2e
vi.mock("../report/player.ts", () => ({
  player: { script: "window.rrwebReplay = {};", style: ".x {}" },
}));

const report = (fingerprint: string, message: string) =>
  ({
    fingerprint,
    trigger: { kind: "error", at: 0, message },
  }) as Report;

describe("reportHtml", () => {
  test("a page of its own: fresh nonce, policy, escaped data", () => {
    const page = reportHtml([report("a", "boom </script><img src=x>\nat x")]);
    const nonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(page)?.[1];
    expect(nonce).toBeDefined();
    expect(page).toContain(`<script nonce="${nonce}">`);
    expect(page).toContain(
      "<title>boom &lt;/script&gt;&lt;img src=x&gt;</title>",
    );
    expect(page.match(/<\/script>/g)).toHaveLength(3);
    expect(reportHtml([report("a", "x")])).not.toContain(nonce);
  });

  test("a title of the caller; several reports share the page", () => {
    const page = reportHtml([report("a", "one"), report("b", "two")], "run 7");
    expect(page).toContain("<title>run 7</title>");
    expect(page).toContain('"fingerprint":"a"');
    expect(page).toContain('"fingerprint":"b"');
    expect(reportHtml([report("a", "one"), report("b", "two")])).toContain(
      "<title>rewindbug report</title>",
    );
  });
});
