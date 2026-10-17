import type { Step } from "../types.ts";

type Phrases = {
  open: (url: string) => string;
  click: (label: string) => string;
  fill: (value: string | undefined, field: string) => string;
  check: (field: string) => string;
  uncheck: (field: string) => string;
  select: (value: string | undefined, field: string) => string;
  press: (key: string) => string;
  scroll: (y: number) => string;
  error: (message: string) => string;
  element: string;
};

const PHRASES: Phrases = {
  open: (url) => `Open ${url}`,
  click: (label) => `Click ${label}`,
  fill: (value, field) =>
    value === undefined
      ? `Type a value into “${field}”`
      : `Type “${value}” into “${field}”`,
  check: (field) => `Check “${field}”`,
  uncheck: (field) => `Uncheck “${field}”`,
  select: (value, field) =>
    value === undefined
      ? `Select a value in “${field}”`
      : `Select “${value}” in “${field}”`,
  press: (key) => `Press ${key}`,
  scroll: (y) => `Scroll to ${y}`,
  error: (message) => `Error: ${message}`,
  element: "element",
};

const QUOTES: [string, string] = ["“", "”"];

// page text must stay plain text in a tracker: one line, no markup, no
// @mentions
export const escapeMarkdown = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>#]/g, "\\$&")
    .replace(/(^|[^\w])@/g, "$1\\@");

const describe = (step: Step, words: Phrases, quotes: [string, string]) => {
  const target = step.target;
  const field = escapeMarkdown(target?.name ?? target?.css ?? words.element);
  const value =
    step.value === undefined ? undefined : escapeMarkdown(step.value);
  switch (step.kind) {
    case "navigate": {
      const url = escapeMarkdown(step.url ?? "");
      // a step with from is a navigation inside the page, not one the user typed
      return step.popstate
        ? `Go ${step.popstate === "unknown" ? "back or forward" : step.popstate} to ${url}`
        : step.from
          ? `The page goes to ${url}`
          : words.open(url);
    }
    case "click": {
      if (!target?.name)
        return words.click(escapeMarkdown(target?.css ?? words.element));
      const name = `${quotes[0]}${escapeMarkdown(target.name)}${quotes[1]}`;
      return words.click(
        target.role ? `${name} (${escapeMarkdown(target.role)})` : name,
      );
    }
    case "fill":
      return words.fill(value, field);
    case "check":
      return step.checked ? words.check(field) : words.uncheck(field);
    case "select":
      return words.select(value, field);
    case "press":
      return words.press(step.key ?? "");
    case "scroll":
      return words.scroll(step.y ?? 0);
  }
};

export const stepsMarkdown = (
  steps: readonly Step[],
  errorMessage: string,
): string => {
  const lines = steps.map(
    (step, index) => `${index + 1}. ${describe(step, PHRASES, QUOTES)}`,
  );
  if (lines.length > 0) lines.push("");
  lines.push(PHRASES.error(escapeMarkdown(errorMessage)));
  return lines.join("\n");
};
