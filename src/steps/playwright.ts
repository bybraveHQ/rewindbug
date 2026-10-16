import type { NetworkEntry, Report, Step, Target } from "../types.ts";

export type TestSource = Pick<
  Report,
  "trigger" | "range" | "steps" | "network"
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

const locator = (target: Target | undefined): string | undefined => {
  if (!target) return undefined;
  let base = `page.locator(${str(target.css)})`;
  // nth is counted among role or test id matches, not css ones
  let nth: number | undefined;
  if (target.testId !== undefined) {
    base = `page.getByTestId(${str(target.testId)})`;
    nth = target.nth;
  } else if (target.role && target.name && ROLES.has(target.role)) {
    const exact = target.name.length < MAX_NAME_LENGTH ? ", exact: true" : "";
    base = `page.getByRole(${str(target.role)}, { name: ${str(target.name)}${exact} })`;
    nth = target.nth;
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

const action = (step: Step, previous: Step | undefined): string[] => {
  const where = locator(step.target);
  const on = where ?? 'page.locator("body")';
  const at = (n: number | undefined) => (Number.isFinite(n) ? Number(n) : 0);
  switch (step.kind) {
    case "navigate": {
      const url = step.url ?? "";
      const follows =
        previous &&
        (previous.kind === "click" || previous.kind === "press") &&
        step.t - previous.t <= FOLLOW_MS;
      return follows
        ? [
            `// navigates to ${line(url)}`,
            `await page.waitForURL((url) => ${urlIs(url)});`,
          ]
        : [`await page.goto(${str(url)});`];
    }
    case "click":
      return [`await ${on}.click();`];
    case "fill":
      return step.masked
        ? [
            "// masked input: put test data here",
            `await ${on}.fill("<masked>");`,
          ]
        : [`await ${on}.fill(${str(step.value ?? "")});`];
    case "check":
      return [`await ${on}.${step.checked ? "check" : "uncheck"}();`];
    case "select":
      return step.masked || step.value === undefined
        ? [`// masked select: pick an option in ${line(where ?? "the field")}`]
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

export const playwrightTest = (source: TestSource): string => {
  const { trigger, range, network } = source;
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

  const body: string[] = [];
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
  // a request with no step behind it starts with the page itself
  if (failing && !linked) body.push(waitFor(failing));
  body.push(`await page.goto(${str(range.startUrl)});`);

  let previous: Step | undefined;
  for (const step of steps) {
    if (failing && step === linked) body.push(waitFor(failing));
    body.push(...action(step, previous));
    for (const id of step.requestIds ?? []) {
      const entry = requests.get(id);
      if (entry) body.push(requestLine(entry));
    }
    if (failing && step === linked) body.push(ASSERT_RESPONSE);
    if (step.kind !== "scroll") previous = step;
  }

  if (failing && !linked) body.push(ASSERT_RESPONSE);
  if (trigger.kind === "manual")
    body.push("// manual capture: add the assertion that failed");
  else if (trigger.kind !== "network") body.push("expect(errors).toEqual([]);");

  const title =
    line(trigger.message).slice(0, MAX_TITLE_LENGTH) || "rewindbug report";
  return [
    'import { test, expect } from "@playwright/test";',
    "",
    `test(${str(title)}, async ({ page }) => {`,
    ...body.map((text) => INDENT + text),
    "});",
    "",
  ].join("\n");
};
