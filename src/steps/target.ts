import type { Target } from "../types.ts";

const MAX_NAME_LENGTH = 40;
const MAX_CSS_DEPTH = 5;
const BLOCK_CLASS = ".rb-block";
// ids with three digits in a row or a colon look generated (React useId, ...)
const GENERATED_ID = /\d{3}|:/;
const BUTTON_INPUTS = new Set(["button", "submit", "reset"]);
const TEXTBOX_INPUTS = new Set(["text", "email", "tel", "url"]);
// roles whose accessible name comes from their text
const NAMED_BY_TEXT = [
  "button, a, summary",
  ..."button link tab option menuitem menuitemcheckbox menuitemradio treeitem checkbox radio switch"
    .split(" ")
    .map((role) => `[role=${role}]`),
].join(", ");
const ROLE_CANDIDATES: Record<string, string> = {
  button: "button, input",
  link: "a[href]",
  textbox: "input, textarea",
  searchbox: "input",
  listbox: "select",
  checkbox: "input",
  radio: "input",
  combobox: "select",
  spinbutton: "input",
  slider: "input",
};

// the attribute check covers environments without isContentEditable
export const isEditable = (element: Element): element is HTMLElement =>
  element instanceof HTMLElement &&
  (element.isContentEditable ||
    ["", "true", "plaintext-only"].includes(
      element.getAttribute("contenteditable") ?? "false",
    ));

export const collapse = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

export const isMasked = (element: Element, maskSelector: string): boolean => {
  if (element.closest(BLOCK_CLASS)) return true;
  if (!maskSelector) return false;
  try {
    return element.closest(maskSelector) !== null;
  } catch {
    // an invalid selector must not unmask anything
    return true;
  }
};

const isTextField = (element: Element): boolean =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  element instanceof HTMLSelectElement ||
  isEditable(element);

export const roleOf = (element: Element): string | undefined => {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "textarea") return "textbox";
  if (element instanceof HTMLSelectElement)
    return element.multiple || element.size > 1 ? "listbox" : "combobox";
  if (!(element instanceof HTMLInputElement)) return undefined;
  const type = element.type;
  if (BUTTON_INPUTS.has(type)) return "button";
  if (TEXTBOX_INPUTS.has(type)) return "textbox";
  if (type === "search") return "searchbox";
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (type === "number") return "spinbutton";
  if (type === "range") return "slider";
  return undefined;
};

// label text without the control it wraps: a <select> inside a label would
// otherwise add all its options
const textWithout = (node: Node, skip: Element): string => {
  let text = "";
  for (const child of node.childNodes) {
    if (child === skip) continue;
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
    else if (child.nodeType === Node.ELEMENT_NODE)
      text += ` ${textWithout(child, skip)} `;
  }
  return text;
};

// text that holds masked content gives no name at all: a name without the
// masked part would not match the element's accessible name, and with it
// the secret would reach the steps, the test and the tracker
const hidesMasked = (node: Element, maskSelector: string): boolean => {
  try {
    return (
      isMasked(node, maskSelector) ||
      node.querySelector(
        maskSelector ? `${BLOCK_CLASS}, ${maskSelector}` : BLOCK_CLASS,
      ) !== null
    );
  } catch {
    return true;
  }
};

const labelText = (
  element: Element,
  maskSelector: string,
): string | undefined => {
  const labels = (element as HTMLInputElement).labels;
  const label = labels?.[0];
  return label && !hidesMasked(label, maskSelector)
    ? textWithout(label, element)
    : undefined;
};

const labelledBy = (
  element: Element,
  maskSelector: string,
): string | undefined => {
  const ids = element.getAttribute("aria-labelledby")?.trim();
  if (!ids) return undefined;
  const targets = ids
    .split(/\s+/)
    .map((id) => element.ownerDocument.getElementById(id));
  return targets.some((target) => target && hidesMasked(target, maskSelector))
    ? undefined
    : targets.map((target) => target?.textContent ?? "").join(" ");
};

// the part of the accessible name Playwright's getByLabel matches
const labelName = (
  element: Element,
  maskSelector: string,
): string | undefined => {
  for (const value of [
    labelledBy(element, maskSelector),
    element.getAttribute("aria-label"),
    labelText(element, maskSelector),
  ]) {
    const name = value ? collapse(value).slice(0, MAX_NAME_LENGTH) : "";
    if (name) return name;
  }
  return undefined;
};

const LABELLED = "input, select, textarea, [aria-label], [aria-labelledby]";

export const nameOf = (
  element: Element,
  maskSelector: string,
): string | undefined => {
  if (isMasked(element, maskSelector)) return undefined;
  // accessible-name order, so Playwright's getByRole finds the same element
  const sources = [
    () => labelledBy(element, maskSelector),
    () => element.getAttribute("aria-label"),
    () => labelText(element, maskSelector),
    () =>
      element instanceof HTMLInputElement && BUTTON_INPUTS.has(element.type)
        ? element.value
        : undefined,
    () =>
      !isTextField(element) &&
      element.matches(NAMED_BY_TEXT) &&
      !hidesMasked(element, maskSelector)
        ? element.textContent
        : undefined,
    () => element.getAttribute("alt"),
    () => element.getAttribute("title"),
    () => element.getAttribute("placeholder"),
  ];
  for (const source of sources) {
    const value = source();
    if (value) {
      const name = collapse(value).slice(0, MAX_NAME_LENGTH);
      if (name) return name;
    }
  }
  return undefined;
};

const count = (selector: string): number =>
  document.querySelectorAll(selector).length;

const idSelector = (element: Element): string | undefined => {
  const id = element.id;
  if (!id || GENERATED_ID.test(id)) return undefined;
  const selector = `#${CSS.escape(id)}`;
  return count(selector) === 1 ? selector : undefined;
};

const nthOfType = (element: Element): string => {
  const tag = element.tagName.toLowerCase();
  let index = 1;
  for (
    let sibling = element.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    if (sibling.tagName === element.tagName) index += 1;
  }
  return `${tag}:nth-of-type(${index})`;
};

export const cssPath = (element: Element): { css: string; unique: boolean } => {
  const parts: string[] = [];
  let node: Element | null = element;
  for (let depth = 0; node && depth < MAX_CSS_DEPTH; depth++) {
    const id = idSelector(node);
    if (id) {
      parts.unshift(id);
      const css = parts.join(" > ");
      return { css, unique: count(css) === 1 };
    }
    parts.unshift(nthOfType(node));
    const css = parts.join(" > ");
    if (count(css) === 1) return { css, unique: true };
    node = node.parentElement;
  }
  return { css: parts.join(" > "), unique: false };
};

// getByRole skips hidden elements, so nth must not count them; without
// checkVisibility (WebKit < 17.4, jsdom) everything counts as visible
const visible = (element: Element): boolean =>
  !element.closest('[aria-hidden="true"]') &&
  (typeof element.checkVisibility !== "function" || element.checkVisibility());

const nthAmong = (element: Element, matches: Element[]): number | undefined => {
  const shown = matches.filter(
    (candidate) => candidate === element || visible(candidate),
  );
  return shown.length > 1 ? Math.max(0, shown.indexOf(element)) : undefined;
};

const nthOf = (
  element: Element,
  target: Pick<Target, "testId" | "role" | "name">,
  maskSelector: string,
): number | undefined => {
  if (target.testId !== undefined) {
    const selector = `[data-testid="${CSS.escape(target.testId)}"]`;
    return nthAmong(element, [...document.querySelectorAll(selector)]);
  }
  if (!target.role || !target.name) return undefined;
  const tags = ROLE_CANDIDATES[target.role];
  const selector = `[role="${CSS.escape(target.role)}"]${tags ? `, ${tags}` : ""}`;
  const matches = [...document.querySelectorAll(selector)].filter(
    (candidate) =>
      roleOf(candidate) === target.role &&
      nameOf(candidate, maskSelector) === target.name,
  );
  return nthAmong(element, matches);
};

export const targetOf = (
  element: Element,
  maskSelector: string,
): Target | undefined => {
  try {
    const target: Target = cssPath(element);
    const testId = element.getAttribute("data-testid");
    if (testId) target.testId = testId;
    const role = roleOf(element);
    if (role) target.role = role;
    const name = nameOf(element, maskSelector);
    if (name) target.name = name;
    // a field with no role, a password among them, is found by its label;
    // nth then counts the fields with the same label
    if (!testId && !role && name && labelName(element, maskSelector) === name)
      target.label = true;
    // without a test id, a role with a name or a label the test falls back
    // to css: then nth counts the css matches
    const nth =
      testId || (role && name)
        ? nthOf(element, target, maskSelector)
        : target.label
          ? nthAmong(
              element,
              [...document.querySelectorAll(LABELLED)].filter(
                (candidate) =>
                  !isMasked(candidate, maskSelector) &&
                  labelName(candidate, maskSelector) === name,
              ),
            )
          : target.unique
            ? undefined
            : [...document.querySelectorAll(target.css)].indexOf(element);
    if (nth !== undefined && nth >= 0) target.nth = nth;
    return target;
  } catch {
    return undefined;
  }
};
