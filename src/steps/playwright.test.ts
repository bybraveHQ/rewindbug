import ts from "typescript";
import { describe, expect, test } from "vitest";
import type { NetworkEntry, Step, Target, Trigger } from "../types.ts";
import { playwrightTest, type TestSource } from "./playwright.ts";

const START = "https://app.example/cart";

const target = (extra: Partial<Target> = {}): Target => ({
  css: "main > button:nth-of-type(2)",
  unique: true,
  ...extra,
});

const error: Trigger = { kind: "error", at: 100, message: "Oops" };

const source = (
  steps: Step[],
  extra: Partial<TestSource> = {},
): TestSource => ({
  trigger: error,
  range: { start: 0, end: 100, startUrl: START },
  steps,
  network: [],
  ...extra,
});

// the generated body without the import, title and assertion scaffolding
const body = (input: TestSource): string[] =>
  playwrightTest(input)
    .split("\n")
    .map((text) => text.trim())
    .filter(
      (text) =>
        text &&
        !text.startsWith("import ") &&
        !text.startsWith("test(") &&
        text !== "});" &&
        !text.includes("errors"),
    );

describe("playwrightTest", () => {
  test("starts at range.startUrl and drops the matching first navigate", () => {
    const lines = body(
      source([
        { t: 1, kind: "navigate", url: START },
        { t: 2, kind: "click", target: target({ testId: "pay" }) },
      ]),
    );
    expect(lines).toEqual([
      `await page.goto("${START}");`,
      'await page.getByTestId("pay").click();',
    ]);
  });

  test("picks the locator tier: test id, role and name, css", () => {
    const lines = body(
      source([
        {
          t: 1,
          kind: "click",
          target: target({ testId: "pay", role: "button", name: "Pay" }),
        },
        {
          t: 2,
          kind: "click",
          target: target({ role: "button", name: "Pay" }),
        },
        { t: 3, kind: "click", target: target({ role: "button" }) },
        {
          t: 4,
          kind: "click",
          target: target({ role: "presentation", name: "Pay" }),
        },
        { t: 5, kind: "click" },
      ]),
    );
    expect(lines.slice(1)).toEqual([
      'await page.getByTestId("pay").click();',
      'await page.getByRole("button", { name: "Pay", exact: true }).click();',
      'await page.locator("main > button:nth-of-type(2)").click();',
      'await page.locator("main > button:nth-of-type(2)").click();',
      'await page.locator("body").click();',
    ]);
  });

  test("adds nth to role and test id, not to css", () => {
    const lines = body(
      source([
        {
          t: 1,
          kind: "click",
          target: target({ role: "button", name: "Add", nth: 2 }),
        },
        { t: 2, kind: "click", target: target({ testId: "row", nth: 0 }) },
        { t: 3, kind: "click", target: target({ nth: 3 }) },
      ]),
    );
    expect(lines.slice(1)).toEqual([
      'await page.getByRole("button", { name: "Add", exact: true }).nth(2).click();',
      'await page.getByTestId("row").nth(0).click();',
      'await page.locator("main > button:nth-of-type(2)").click();',
    ]);
  });

  test("matches a name cut at 40 characters as a substring", () => {
    const name = "x".repeat(40);
    const lines = body(
      source([{ t: 1, kind: "click", target: target({ role: "link", name }) }]),
    );
    expect(lines[1]).toBe(
      `await page.getByRole("link", { name: "${name}" }).click();`,
    );
  });

  test("writes every step kind", () => {
    const field = target({ role: "textbox", name: "Email" });
    const lines = body(
      source([
        { t: 1, kind: "fill", target: field, value: "a@b.c" },
        { t: 2, kind: "fill", target: field, masked: true },
        {
          t: 3,
          kind: "check",
          target: target({ role: "checkbox", name: "Terms" }),
          checked: true,
        },
        {
          t: 4,
          kind: "check",
          target: target({ role: "checkbox", name: "News" }),
          checked: false,
        },
        {
          t: 5,
          kind: "select",
          target: target({ role: "combobox", name: "Country" }),
          value: "ua",
        },
        {
          t: 6,
          kind: "select",
          target: target({ role: "combobox", name: "Card" }),
          masked: true,
        },
        { t: 7, kind: "press", target: field, key: "Enter" },
        { t: 8, kind: "press", key: "Escape" },
        { t: 9, kind: "scroll", x: 0, y: 840 },
        {
          t: 10,
          kind: "scroll",
          target: target({ testId: "list" }),
          x: 5,
          y: 10,
        },
      ]),
    );
    expect(lines.slice(1)).toEqual([
      'await page.getByRole("textbox", { name: "Email", exact: true }).fill("a@b.c");',
      "// masked input: put test data here",
      'await page.getByRole("textbox", { name: "Email", exact: true }).fill("<masked>");',
      'await page.getByRole("checkbox", { name: "Terms", exact: true }).check();',
      'await page.getByRole("checkbox", { name: "News", exact: true }).uncheck();',
      'await page.getByRole("combobox", { name: "Country", exact: true }).selectOption("ua");',
      '// masked select: pick an option in page.getByRole("combobox", { name: "Card", exact: true })',
      'await page.getByRole("textbox", { name: "Email", exact: true }).press("Enter");',
      'await page.keyboard.press("Escape");',
      "await page.evaluate(() => window.scrollTo(0, 840));",
      'await page.getByTestId("list").evaluate((el) => el.scrollTo(5, 10));',
    ]);
  });

  test("waits for a navigation within a second of a click, goes to others", () => {
    const lines = body(
      source([
        { t: 1000, kind: "click", target: target({ testId: "next" }) },
        { t: 1400, kind: "scroll", x: 0, y: 10 },
        {
          t: 1900,
          kind: "navigate",
          url: "https://app.example/pay?token=*",
          from: START,
        },
        {
          t: 5000,
          kind: "navigate",
          url: "https://app.example/done",
          from: START,
        },
      ]),
    );
    expect(lines.slice(3)).toEqual([
      "// navigates to https://app.example/pay?token=*",
      'await page.waitForURL((url) => url.pathname === "/pay" && url.searchParams.has("token"));',
      'await page.goto("https://app.example/done");',
    ]);
  });

  test("waits for a change of the query alone", () => {
    const lines = body(
      source([
        { t: 1000, kind: "click", target: target({ testId: "next" }) },
        {
          t: 1100,
          kind: "navigate",
          url: `${START}?screen=checkout&step=2`,
          from: START,
        },
      ]),
    );
    expect(lines.at(-1)).toBe(
      'await page.waitForURL((url) => url.pathname === "/cart" && url.searchParams.get("screen") === "checkout" && url.searchParams.get("step") === "2");',
    );
  });

  test("comments the requests linked to a step", () => {
    const network: NetworkEntry[] = [
      {
        id: 1,
        t: 2,
        type: "fetch",
        method: "POST",
        url: "https://api.example/cart?id=7",
        state: "done",
        status: 500,
        durationMs: 311.6,
      },
      {
        id: 2,
        t: 3,
        type: "xhr",
        method: "GET",
        url: "https://api.example/ping",
        state: "failed",
        error: "timeout",
      },
    ];
    const lines = body(
      source(
        [
          {
            t: 1,
            kind: "click",
            target: target({ testId: "pay" }),
            requestIds: [1, 2, 9],
          },
        ],
        { network },
      ),
    );
    expect(lines.slice(2)).toEqual([
      "// -> POST /cart?id=7 500 (312 ms)",
      "// -> GET /ping failed: timeout",
    ]);
  });

  test("ends with the assertion that fits the trigger", () => {
    const steps: Step[] = [
      { t: 1, kind: "click", target: target({ testId: "pay" }) },
    ];
    const forKind = (kind: Trigger["kind"]) =>
      playwrightTest(
        source(steps, { trigger: { kind, at: 100, message: "Oops" } }),
      );

    for (const kind of ["error", "unhandledrejection"] as const) {
      const code = forKind(kind);
      expect(code).toContain('page.on("pageerror", (e) => errors.push(e));');
      expect(code).toContain("expect(errors).toEqual([]);");
    }
    const consoleCode = forKind("console.error");
    expect(consoleCode).toContain(
      'if (m.type() === "error") errors.push(m.text());',
    );
    expect(consoleCode).toContain("expect(errors).toEqual([]);");
    const manual = forKind("manual");
    expect(manual).toContain(
      "// manual capture: add the assertion that failed",
    );
    expect(manual).not.toContain("errors");
  });

  test("waits for the failing request around its step", () => {
    const network: NetworkEntry[] = [
      {
        id: 4,
        t: 2,
        type: "fetch",
        method: "POST",
        url: "https://api.example/cart",
        state: "done",
        status: 500,
      },
    ];
    const code = playwrightTest(
      source(
        [
          {
            t: 1,
            kind: "click",
            target: target({ testId: "pay" }),
            requestIds: [4],
          },
          { t: 50, kind: "click", target: target({ testId: "close" }) },
        ],
        {
          network,
          trigger: {
            kind: "network",
            at: 100,
            message: "POST 500",
            requestId: 4,
          },
        },
      ),
    );
    const lines = code.split("\n").map((text) => text.trim());
    const wait = lines.findIndex((text) =>
      text.startsWith("const failing = page.waitForResponse("),
    );
    expect(lines[wait]).toContain(
      'r.request().method() === "POST" && r.url().includes("/cart")',
    );
    expect(lines[wait + 1]).toBe('await page.getByTestId("pay").click();');
    expect(lines[wait + 3]).toBe("expect((await failing).ok()).toBe(true);");
    expect(lines[wait + 4]).toBe('await page.getByTestId("close").click();');
    expect(code).not.toContain("errors");
  });

  test("waits for a failing request without a step from the first goto", () => {
    const network: NetworkEntry[] = [
      {
        id: 4,
        t: 2,
        type: "fetch",
        method: "GET",
        url: "https://api.example/me",
        state: "done",
        status: 503,
      },
    ];
    const lines = playwrightTest(
      source([], {
        network,
        trigger: { kind: "network", at: 100, message: "GET 503", requestId: 4 },
      }),
    )
      .split("\n")
      .map((text) => text.trim());
    const wait = lines.findIndex((text) => text.startsWith("const failing"));
    expect(lines[wait + 1]).toBe(`await page.goto("${START}");`);
    expect(lines[wait + 2]).toBe("expect((await failing).ok()).toBe(true);");
  });

  test("keeps page text out of code and comments", () => {
    const evil = 'x"); process.exit(1); //\u2028await page.close(); */ ${1}`';
    const code = playwrightTest(
      source(
        [
          {
            t: 1,
            kind: "fill",
            target: target({ role: "textbox", name: evil }),
            value: evil,
          },
          {
            t: 2,
            kind: "select",
            target: target({ role: "combobox", name: evil }),
            masked: true,
          },
          { t: 3, kind: "navigate", url: `https://app.example/${evil}` },
        ],
        {
          trigger: {
            kind: "error",
            at: 100,
            message: `boom\n});\nawait page.close();${"y".repeat(100)}`,
          },
          network: [
            {
              id: 1,
              t: 2,
              type: "fetch",
              method: "GET",
              url: `x\n${evil}`,
              state: "pending",
            },
          ],
        },
      ),
    );
    const lines = code.split("\n");
    // a raw line terminator would end a // comment early
    expect(code).not.toMatch(/[\r\u2028\u2029]/);
    expect(lines[2]).toBe(
      `test(${JSON.stringify(`boom }); await page.close();${"y".repeat(52)}`)}, async ({ page }) => {`,
    );
    // the only page.close is inside a string literal or a comment
    for (const text of lines.filter((l) => l.includes("page.close()")))
      expect(text.trim()).toMatch(
        /^(\/\/|await page\.(getByRole|goto)\(|test\()/,
      );
    expect(code).toContain(
      `.fill(${JSON.stringify(evil).replace("\u2028", "\\u2028")});`,
    );
  });

  test("generates syntactically valid TypeScript for every trigger", () => {
    const evil = 'a"b\u2028c */ `${x}`\n});';
    const steps: Step[] = [
      {
        t: 1,
        kind: "click",
        target: target({ role: "button", name: evil }),
        requestIds: [1],
      },
      { t: 2, kind: "fill", target: target({ testId: evil }), value: evil },
      { t: 3, kind: "fill", target: target(), masked: true },
      {
        t: 4,
        kind: "select",
        target: target({ role: "combobox", name: evil }),
        masked: true,
      },
      { t: 5, kind: "press", key: "Enter" },
      { t: 6, kind: "navigate", url: `https://app.example/${evil}` },
      { t: 7, kind: "scroll", target: target({ css: evil }), x: 1, y: 2 },
    ];
    const network: NetworkEntry[] = [
      {
        id: 1,
        t: 1,
        type: "fetch",
        method: "POST",
        url: `https://api.example/${evil}`,
        state: "done",
        status: 500,
      },
    ];
    const kinds: Trigger["kind"][] = [
      "error",
      "unhandledrejection",
      "console.error",
      "network",
      "manual",
    ];
    for (const kind of kinds) {
      const code = playwrightTest(
        source(steps, {
          network,
          trigger: { kind, at: 100, message: evil, requestId: 1 },
        }),
      );
      const { diagnostics } = ts.transpileModule(code, {
        reportDiagnostics: true,
      });
      expect(diagnostics, kind).toEqual([]);
    }
  });

  test("names a test without a message", () => {
    const code = playwrightTest(
      source([], { trigger: { kind: "manual", at: 1, message: "  " } }),
    );
    expect(code).toContain('test("rewindbug report", async ({ page }) => {');
    expect(
      code.startsWith('import { test, expect } from "@playwright/test";\n'),
    ).toBe(true);
  });
});
