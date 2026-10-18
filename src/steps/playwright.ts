import type { NetworkEntry, Report, Step, Target } from "../types.ts";

export type TestSource = Pick<
  Report,
  "trigger" | "range" | "steps" | "network" | "console"
>;

const FOLLOW_MS = 1000;
const MAX_TITLE_LENGTH = 80;
// names are cut at this length when steps are recorded: a cut name is
// matched as a substring
const MAX_NAME_LENGTH = 40;
// roles Playwright's getByRole accepts that a recorded step can carry;
// any other explicit role falls back to css
const ROLES = new Set(
  (
    "button link checkbox radio switch tab menuitem menuitemcheckbox " +
    "menuitemradio option treeitem combobox textbox searchbox slider " +
    "spinbutton listbox row cell gridcell columnheader img heading dialog"
  ).split(" "),
);
const INDENT = "  ";
// a value each input type accepts, in place of a masked one
const SAMPLES: Record<string, string> = {
  email: "user@example.com",
  number: "1",
  tel: "+15550100",
  url: "https://example.com",
  date: "2025-01-15",
  time: "12:00",
  "datetime-local": "2025-01-15T12:00",
  month: "2025-01",
  week: "2025-W03",
  color: "#336699",
  range: "50",
};
const SAMPLE_TEXT = "test";
// an error later than this after the last step came from async work: the
// test waits as long, plus SETTLE_MS for a slower run, before it checks
const ASYNC_MS = 50;
const SETTLE_MS = 1000;
const MAX_WAIT_MS = 10_000;
const PASSWORD = 'process.env.TEST_PASSWORD ?? "password"';

// U+2028 and U+2029 stay raw in JSON and break the line in older tools
const str = (value: string): string =>
  JSON.stringify(value).replace(
    /[\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16)}`,
  );

// page text in a comment or a title stays on one line
const line = (text: string): string => text.replace(/\s+/g, " ").trim();

const path = (raw: string, search = false): string => {
  try {
    const url = new URL(raw);
    return url.pathname + (search ? url.search : "");
  } catch {
    return raw;
  }
};

// the default url filter masks secret params with "*": such a param is only
// required to be there
const MASKED_PARAM = "*";

// path and query: a screen may change by its query alone
const urlIs = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `url.pathname === ${str(raw)}`;
  }
  const checks = [`url.pathname === ${str(url.pathname)}`];
  for (const name of new Set(url.searchParams.keys())) {
    const value = url.searchParams.get(name) ?? "";
    checks.push(
      value === MASKED_PARAM
        ? `url.searchParams.has(${str(name)})`
        : `url.searchParams.get(${str(name)}) === ${str(value)}`,
    );
  }
  return checks.join(" && ");
};

// undefined: no target; null: a css path that matches several elements
// and no index among them
const locator = (target: Target | undefined): string | null | undefined => {
  if (!target) return undefined;
  let base = `page.locator(${str(target.css)})`;
  // nth counts the matches of what was recorded: test id, role and name,
  // or css when there is neither
  let nth = target.nth;
  if (target.testId !== undefined) {
    base = `page.getByTestId(${str(target.testId)})`;
  } else if (target.role && target.name && ROLES.has(target.role)) {
    const exact = target.name.length < MAX_NAME_LENGTH ? ", exact: true" : "";
    base = `page.getByRole(${str(target.role)}, { name: ${str(target.name)}${exact} })`;
  } else if (target.label && target.name) {
    const exact =
      target.name.length < MAX_NAME_LENGTH ? ", { exact: true }" : "";
    base = `page.getByLabel(${str(target.name)}${exact})`;
  } else if (target.unique) {
    nth = undefined;
  } else if (target.role && target.name) {
    return null;
  }
  return nth === undefined ? base : `${base}.nth(${nth})`;
};

const requestLine = (entry: NetworkEntry): string => {
  const outcome =
    entry.status ??
    (entry.state === "failed"
      ? `failed: ${entry.error ?? "network"}`
      : "pending");
  const duration =
    entry.durationMs === undefined
      ? ""
      : ` (${Math.round(entry.durationMs)} ms)`;
  return `// -> ${line(`${entry.method} ${path(entry.url, true)} ${outcome}`)}${duration}`;
};

// the key a masked field gets in the `input` object of the test
const inputKey = (step: Step, index: number): string =>
  line(step.target?.name ?? "") || `field ${index + 1}`;

const sample = (step: Step): string =>
  step.inputType === "password"
    ? PASSWORD
    : str(SAMPLES[step.inputType ?? ""] ?? SAMPLE_TEXT);

const action = (
  step: Step,
  previous: Step | undefined,
  key: string | undefined,
): string[] => {
  const where = locator(step.target);
  if (where === null)
    return [
      `// ${step.kind} on ${line(step.target?.css ?? "")}: several match, pick one`,
    ];
  const on = where ?? 'page.locator("body")';
  const at = (n: number | undefined) => (Number.isFinite(n) ? Number(n) : 0);
  switch (step.kind) {
    case "navigate": {
      const url = step.url ?? "";
      const acted =
        previous &&
        (previous.kind === "click" || previous.kind === "press") &&
        step.t - previous.t <= FOLLOW_MS;
      if (step.popstate && !acted)
        return step.popstate === "unknown"
          ? [`// back or forward to ${line(url)}: direction unknown`]
          : [
              `// ${step.popstate} to ${line(url)}`,
              `await page.${step.popstate === "back" ? "goBack" : "goForward"}();`,
            ];
      // a query written while typing holds what was typed then, which the
      // test does not type exactly
      const check =
        previous?.kind === "fill"
          ? `url.pathname === ${str(path(url))}`
          : urlIs(url);
      return [
        `// the page navigates to ${line(url)}`,
        `await page.waitForURL((url) => ${check});`,
      ];
    }
    case "click":
      return [`await ${on}.click();`];
    case "fill":
      return [
        `await ${on}.fill(${key === undefined ? str(step.value ?? "") : `input[${str(key)}]`});`,
      ];
    case "check":
      return [`await ${on}.${step.checked ? "check" : "uncheck"}();`];
    case "select":
      return step.masked || step.value === undefined
        ? [
            "// masked: the chosen option is unknown",
            `await ${on}.selectOption({ index: 1 });`,
          ]
        : [`await ${on}.selectOption(${str(step.value)});`];
    case "press":
      return [
        `await ${where ?? "page.keyboard"}.press(${str(step.key ?? "")});`,
      ];
    case "scroll": {
      const to = `scrollTo(${at(step.x)}, ${at(step.y)})`;
      return [
        where
          ? `await ${where}.evaluate((el) => el.${to});`
          : `await page.evaluate(() => window.${to});`,
      ];
    }
  }
};

const waitFor = (entry: NetworkEntry): string =>
  `const failing = page.waitForResponse((r) => r.request().method() === ${str(entry.method)} && r.url().includes(${str(path(entry.url))}));`;

const ASSERT_RESPONSE = "expect((await failing).ok()).toBe(true);";

const startPath = (raw: string): string => {
  let start = raw;
  try {
    const url = new URL(raw);
    start = url.pathname + url.search + url.hash;
  } catch {
    // kept as recorded
  }
  // a path starting with // names another host to at(); /. keeps it on the
  // base origin and the browser drops the dot
  return start.startsWith("//") ? `/.${start}` : start;
};

const origin = (raw: string): string => {
  try {
    return new URL(raw).origin;
  } catch {
    return "http://localhost";
  }
};

export const playwrightTest = (source: TestSource): string => {
  const { trigger, range, network } = source;
  // an error handed to capture() that the page also logged, as error
  // boundaries do: the test fails while it is logged
  const logged =
    trigger.kind === "manual" &&
    trigger.error !== undefined &&
    trigger.message !== "" &&
    source.console.some(
      (entry) =>
        entry.level === "error" && entry.message.includes(trigger.message),
    );
  const requests = new Map(network.map((entry) => [entry.id, entry]));
  const failing =
    trigger.kind === "network" && trigger.requestId !== undefined
      ? requests.get(trigger.requestId)
      : undefined;
  const steps = [...source.steps];
  if (steps[0]?.kind === "navigate" && steps[0].url === range.startUrl)
    steps.shift();
  const linked = failing
    ? steps.find((step) => step.requestIds?.includes(failing.id))
    : undefined;

  const keys = new Map<Step, string>();
  const inputs = new Map<string, string>();
  steps.forEach((step, index) => {
    if (step.kind !== "fill" || !step.masked) return;
    const key = inputKey(step, index);
    keys.set(step, key);
    if (!inputs.has(key)) inputs.set(key, sample(step));
  });

  const body: string[] = [
    "// baseURL from the config, else the report's origin; log in via storageState",
    `const at = (path: string) => new URL(path, baseURL ?? ${str(origin(range.startUrl))}).href;`,
  ];
  if (inputs.size > 0)
    body.push(
      "// masked: put your test data here",
      "const input = {",
      ...[...inputs].map(([key, value]) => `${INDENT}${str(key)}: ${value},`),
      "};",
    );
  if (trigger.kind === "error" || trigger.kind === "unhandledrejection")
    body.push(
      "const errors: Error[] = [];",
      'page.on("pageerror", (e) => errors.push(e));',
    );
  if (trigger.kind === "console.error")
    body.push(
      "const errors: string[] = [];",
      'page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });',
    );
  // Firefox shows an Error argument as JSHandle@object in m.text(): the
  // arguments are read as they come, while their handles are alive
  if (logged)
    body.push(
      "const logged: Promise<string>[] = [];",
      'page.on("console", (m) => { if (m.type() === "error") logged.push(Promise.all(m.args().map((a) => a.evaluate((v) => String(v)).catch(() => ""))).then((args) => [m.text(), ...args].join(" "))); });',
    );
  // a request with no step behind it starts with the page itself
  if (failing && !linked) body.push(waitFor(failing));
  body.push(`await page.goto(at(${str(startPath(range.startUrl))}));`);

  let previous: Step | undefined;
  for (const step of steps) {
    if (failing && step === linked) body.push(waitFor(failing));
    body.push(...action(step, previous, keys.get(step)));
    for (const id of step.requestIds ?? []) {
      const entry = requests.get(id);
      if (entry) body.push(requestLine(entry));
    }
    if (failing && step === linked) body.push(ASSERT_RESPONSE);
    if (step.kind !== "scroll") previous = step;
  }

  if (failing && !linked) body.push(ASSERT_RESPONSE);
  // a render after a route change or a handler after a request fails later
  // than the step: the check waits for it, by the delay in the report
  const last = steps.at(-1);
  // steps end at the trigger, so the gap is never negative
  const gap = last ? trigger.at - last.t : 0;
  if (
    last &&
    trigger.kind !== "network" &&
    (logged || trigger.kind !== "manual") &&
    (last.kind === "navigate" || gap > ASYNC_MS)
  )
    body.push(
      `await page.waitForTimeout(${Math.min(MAX_WAIT_MS, gap + SETTLE_MS)});`,
    );
  if (logged)
    body.push(
      `expect((await Promise.all(logged)).filter((text) => text.includes(${str(trigger.message)}))).toEqual([]);`,
    );
  else if (trigger.kind === "manual")
    body.push("// add the assertion that failed");
  else if (trigger.kind !== "network") body.push("expect(errors).toEqual([]);");

  const title =
    line(trigger.message).slice(0, MAX_TITLE_LENGTH) || "rewindbug report";
  return [
    'import { test, expect } from "@playwright/test";',
    "",
    `test(${str(title)}, async ({ page, baseURL }) => {`,
    ...body.map((text) => INDENT + text),
    "});",
    "",
  ].join("\n");
};
