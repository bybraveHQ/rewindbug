import ts from "typescript";
import { describe, expect, test } from "vitest";
import type { NetworkEntry, Step, Target, Trigger } from "../types.ts";
import { playwrightTest, type TestSource } from "./playwright.ts";

const START = "https://app.example/cart";
const LIST = "https://app.example/list";

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
  console: [],
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
        !text.includes("errors") &&
        !text.startsWith("// baseURL from") &&
        !text.startsWith("const at ="),
    );

const GOTO = 'await page.goto(at("/cart"));';

describe("playwrightTest", () => {
  test("starts at range.startUrl and drops the matching first navigate", () => {
    const lines = body(
      source([
        { t: 1, kind: "navigate", url: START },
        { t: 2, kind: "click", target: target({ testId: "pay" }) },
      ]),
    );
    expect(lines).toEqual([GOTO, 'await page.getByTestId("pay").click();']);
  });

  test("resolves the start against baseURL, else the report's origin", () => {
    const code = playwrightTest(source([]));
    expect(code).toContain("async ({ page, baseURL }) => {");
    expect(code).toContain(
      'const at = (path: string) => new URL(path, baseURL ?? "https://app.example").href;',
    );
    const query = playwrightTest(
      source([], {
        range: { start: 0, end: 1, startUrl: `${START}?step=2#pay` },
      }),
    );
    expect(query).toContain('await page.goto(at("/cart?step=2#pay"));');
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

  test("adds nth to role, test id and a css path that matches several", () => {
    const lines = body(
      source([
        {
          t: 1,
          kind: "click",
          target: target({ role: "button", name: "Add", nth: 2 }),
        },
        { t: 2, kind: "click", target: target({ testId: "row", nth: 0 }) },
        { t: 3, kind: "click", target: target({ nth: 3 }) },
        { t: 4, kind: "click", target: target({ unique: false, nth: 1 }) },
        {
          t: 5,
          kind: "click",
          target: target({ unique: false, role: "presentation", name: "Pay" }),
        },
      ]),
    );
    expect(lines.slice(1)).toEqual([
      'await page.getByRole("button", { name: "Add", exact: true }).nth(2).click();',
      'await page.getByTestId("row").nth(0).click();',
      'await page.locator("main > button:nth-of-type(2)").click();',
      'await page.locator("main > button:nth-of-type(2)").nth(1).click();',
      "// click on main > button:nth-of-type(2): several elements match, pick the right one",
    ]);
  });

  test("finds a field without a role by its label", () => {
    const password = target({
      css: "label:nth-of-type(2) > input:nth-of-type(1)",
      name: "Password",
      label: true,
    });
    const lines = body(
      source([
        {
          t: 1,
          kind: "fill",
          target: password,
          masked: true,
          inputType: "password",
        },
        { t: 2, kind: "click", target: { ...password, unique: false, nth: 1 } },
        // a name from a placeholder or title is not a label: css stays
        { t: 3, kind: "click", target: target({ name: "Hint" }) },
      ]),
    );
    expect(lines).toContain(
      'await page.getByLabel("Password", { exact: true }).fill(input["Password"]);',
    );
    expect(lines).toContain(
      'await page.getByLabel("Password", { exact: true }).nth(1).click();',
    );
    expect(lines).toContain(
      'await page.locator("main > button:nth-of-type(2)").click();',
    );
    expect(lines.join("\n")).not.toContain("label:nth-of-type");
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
    expect(lines.slice(lines.indexOf(GOTO) + 1)).toEqual([
      'await page.getByRole("textbox", { name: "Email", exact: true }).fill("a@b.c");',
      'await page.getByRole("textbox", { name: "Email", exact: true }).fill(input["Email"]);',
      'await page.getByRole("checkbox", { name: "Terms", exact: true }).check();',
      'await page.getByRole("checkbox", { name: "News", exact: true }).uncheck();',
      'await page.getByRole("combobox", { name: "Country", exact: true }).selectOption("ua");',
      "// masked: the report does not say which option was chosen",
      'await page.getByRole("combobox", { name: "Card", exact: true }).selectOption({ index: 1 });',
      'await page.getByRole("textbox", { name: "Email", exact: true }).press("Enter");',
      'await page.keyboard.press("Escape");',
      "await page.evaluate(() => window.scrollTo(0, 840));",
      'await page.getByTestId("list").evaluate((el) => el.scrollTo(5, 10));',
    ]);
  });

  test("puts masked values into one input object, by input type", () => {
    const field = (name: string, inputType?: string): Step => ({
      t: 1,
      kind: "fill",
      target: target({ role: "textbox", name }),
      masked: true,
      ...(inputType && { inputType }),
    });
    const lines = body(
      source([
        field("Email", "email"),
        field("Qty", "number"),
        field("When", "date"),
        field("Password", "password"),
        field("Note"),
        field("Email", "email"),
        { t: 2, kind: "fill", target: target(), masked: true },
      ]),
    );
    expect(lines.slice(0, lines.indexOf(GOTO))).toEqual([
      "// typed values are masked in the report: put your test data here",
      "const input = {",
      '"Email": "user@example.com",',
      '"Qty": "1",',
      '"When": "2025-01-15",',
      '"Password": process.env.TEST_PASSWORD ?? "password",',
      '"Note": "test",',
      '"field 7": "test",',
      "};",
    ]);
    expect(lines.at(-1)).toBe(
      'await page.locator("main > button:nth-of-type(2)").fill(input["field 7"]);',
    );
  });

  test("waits for every navigation the page makes", () => {
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
      "// the page navigates to https://app.example/pay?token=*",
      'await page.waitForURL((url) => url.pathname === "/pay" && url.searchParams.has("token"));',
      "// the page navigates to https://app.example/done",
      'await page.waitForURL((url) => url.pathname === "/done");',
    ]);
  });

  test("goes back on popstate without a click, waits after a masked fill by path", () => {
    const lines = body(
      source([
        { t: 1000, kind: "navigate", url: LIST, popstate: "back" },
        { t: 1500, kind: "navigate", url: START, popstate: "forward" },
        { t: 1700, kind: "navigate", url: LIST, popstate: "unknown" },
        { t: 2000, kind: "click", target: target({ testId: "back" }) },
        { t: 2100, kind: "navigate", url: START, popstate: "back" },
        {
          t: 3000,
          kind: "fill",
          target: target({ role: "searchbox", name: "Search" }),
          masked: true,
        },
        { t: 3100, kind: "navigate", url: `${START}?q=*` },
      ]),
    );
    expect(lines.slice(lines.indexOf(GOTO) + 1)).toEqual([
      `// back to ${LIST}`,
      "await page.goBack();",
      `// forward to ${START}`,
      "await page.goForward();",
      `// back or forward to ${LIST}: the browser did not say which`,
      'await page.getByTestId("back").click();',
      `// the page navigates to ${START}`,
      'await page.waitForURL((url) => url.pathname === "/cart");',
      'await page.getByRole("searchbox", { name: "Search", exact: true }).fill(input["Search"]);',
      `// the page navigates to ${START}?q=*`,
      'await page.waitForURL((url) => url.pathname === "/cart");',
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

  test("a captured error the page also logged fails the test while logged", () => {
    const manual: Trigger = {
      kind: "manual",
      at: 100,
      message: "Cannot read name",
      error: { name: "TypeError", message: "Cannot read name" },
    };
    const logged = playwrightTest(
      source([], {
        trigger: manual,
        console: [
          {
            t: 90,
            level: "error",
            message: "TypeError: Cannot read name\n\n    at Profile",
          },
        ],
      }),
    );
    expect(logged).toContain("const logged: Promise<string>[] = [];");
    expect(logged).toContain("a.evaluate((v) => String(v))");
    expect(logged).toContain(
      'expect((await Promise.all(logged)).filter((text) => text.includes("Cannot read name"))).toEqual([]);',
    );
    expect(logged).not.toContain("manual capture: add the assertion");

    // not logged, or logged at another level, or no error object: a comment
    for (const extra of [
      { trigger: manual },
      {
        trigger: manual,
        console: [
          { t: 90, level: "warn" as const, message: "Cannot read name" },
        ],
      },
      {
        trigger: {
          kind: "manual" as const,
          at: 100,
          message: "Cannot read name",
        },
        console: [
          { t: 90, level: "error" as const, message: "Cannot read name" },
        ],
      },
    ]) {
      const code = playwrightTest(source([], extra));
      expect(code).toContain(
        "// manual capture: add the assertion that failed",
      );
      expect(code).not.toContain("logged");
    }
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
    expect(lines[wait + 1]).toBe(GOTO);
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
      `test(${JSON.stringify(`boom }); await page.close();${"y".repeat(52)}`)}, async ({ page, baseURL }) => {`,
    );
    // the only page.close is inside a string literal or a comment
    for (const text of lines.filter((l) => l.includes("page.close()")))
      expect(text.trim()).toMatch(
        /^(\/\/|await page\.(getByRole|goto|waitForURL)\(|test\()/,
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
          trigger: {
            kind,
            at: 100,
            message: evil,
            requestId: 1,
            error: { name: "Error", message: evil },
          },
          // makes the manual test check the console
          console: [{ t: 90, level: "error", message: evil }],
        }),
      );
      if (kind === "manual") expect(code).toContain("const logged");
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
    expect(code).toContain(
      'test("rewindbug report", async ({ page, baseURL }) => {',
    );
    expect(
      code.startsWith('import { test, expect } from "@playwright/test";\n'),
    ).toBe(true);
  });
});
