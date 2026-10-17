import type { Step, StepKey } from "../types.ts";
import { RingBuffer } from "../shared/ring.ts";
import type { UrlFilter } from "../shared/url-filter.ts";
import { collapse, isEditable, isMasked, targetOf } from "./target.ts";

export { stepsMarkdown } from "./markdown.ts";
export { playwrightTest, type TestSource } from "./playwright.ts";

const CAPACITY = 100;
const MAX_VALUE_LENGTH = 200;
const MAX_URL_LENGTH = 2000;
const SCROLL_DEBOUNCE_MS = 300;
const LABEL_FORWARD_MS = 50;
// Enter on a button, a link or a form field clicks it right away
const ENTER_CLICK_MS = 50;
const UNMASK = "[data-rb-unmask]";
// interactive roles only: a click inside a dialog or main is not on them
const ROLES = [
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
  "combobox",
  "textbox",
  "searchbox",
  "slider",
  "spinbutton",
];
const CLICK_TARGET = [
  "a, button, input, select, textarea, label, summary, [data-testid]",
  ...ROLES.map((role) => `[role="${role}"]`),
].join(", ");
const KEYS = new Set<string>(["Enter", "Escape", "Tab"]);
const FILL_INPUTS = new Set([
  "text",
  "email",
  "tel",
  "url",
  "search",
  "password",
  "number",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "color",
  "range",
]);

export type StepsOptions = {
  maskInputs: boolean;
  maskSelector: string;
  filter: UrlFilter;
  now?: () => number;
};

export type StepsSnapshot = {
  steps: Step[];
  lastEvicted?: number;
};

export type Steps = {
  snapshot: () => StepsSnapshot;
  stop: () => void;
};

type PendingScroll = { timer: ReturnType<typeof setTimeout>; step: Step };
type HistoryMethod = History["pushState"];
type Navigation = { currentEntry?: { index: number } | null };

// the Navigation API knows the history index, so back from forward
const historyIndex = (): number | undefined =>
  (globalThis as { navigation?: Navigation }).navigation?.currentEntry?.index;

const withoutHash = (url: string) => url.split("#")[0];

const isCheckable = (element: Element): element is HTMLInputElement =>
  element instanceof HTMLInputElement &&
  (element.type === "checkbox" || element.type === "radio");

const fillField = (element: Element): HTMLElement | undefined => {
  if (element instanceof HTMLInputElement)
    return FILL_INPUTS.has(element.type) ? element : undefined;
  if (element instanceof HTMLTextAreaElement) return element;
  if (isEditable(element)) return element;
  return undefined;
};

const fieldValue = (field: HTMLElement): string =>
  field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
    ? field.value
    : (field.textContent ?? "");

// a field a "show password" button turned into text, or swapped for a new
// one: its type when it got focus, rrweb's mark, its autocomplete, name or
// id still say what it is
const isPassword = (field: Element): boolean =>
  (field as HTMLInputElement).type === "password" ||
  field.hasAttribute("data-rr-is-password") ||
  /pass|pwd/i.test(
    `${field.getAttribute("autocomplete")} ${field.getAttribute("name")} ${field.id}`,
  );

// the element itself inside an open shadow root, where event.target is the
// host; Playwright's locators reach into open shadow roots too
// composedPath is never empty while the event is dispatched
const asElement = (event: Event): Element | undefined => {
  const target = event.composedPath()[0];
  return target instanceof Element ? target : undefined;
};

export const startSteps = (options: StepsOptions): Steps => {
  const now = options.now ?? Date.now;
  const buffer = new RingBuffer<Step>(CAPACITY);
  const scrolls = new Map<EventTarget, PendingScroll>();
  let active = true;
  // last step other than scroll: scrolling a field must not split its fill
  let lastStep: Step | undefined;
  const passwords = new WeakSet<HTMLElement>();
  let lastFill: { field: HTMLElement; step: Step } | undefined;
  let labelForward: { control: Element; t: number } | undefined;
  let enter: { element: Element; t: number } | undefined;
  // a field that writes itself into the URL while typing: one fill, one
  // navigation, not a pair per key
  let typing: { fill: Step; navigate: Step } | undefined;
  let href = location.href;
  let index = historyIndex();

  const push = (step: Step) => {
    buffer.push(step);
    if (step.kind !== "scroll") lastStep = step;
  };

  const url = (raw: string) => options.filter(raw).slice(0, MAX_URL_LENGTH);

  // steps never break the host: every listener body is guarded
  const guard =
    <E extends Event>(handler: (event: E) => void) =>
    (event: E) => {
      if (!active || !event.isTrusted) return;
      try {
        handler(event);
      } catch {
        // a step that cannot be built is skipped
      }
    };

  const masked = (field: Element, password: boolean) =>
    password ||
    isMasked(field, options.maskSelector) ||
    (options.maskInputs && !field.closest(UNMASK));

  const valueFields = (field: Element, raw: string, password: boolean) =>
    masked(field, password)
      ? { masked: true as const }
      : { value: collapse(raw).slice(0, MAX_VALUE_LENGTH) };

  const target = (element: Element) => {
    const result = targetOf(element, options.maskSelector);
    return result ? { target: result } : {};
  };

  const onClick = guard((event: MouseEvent) => {
    const origin = asElement(event);
    if (!origin) return;
    const element = origin.closest(CLICK_TARGET) ?? origin;
    const t = now();
    if (
      labelForward &&
      labelForward.control === element &&
      t - labelForward.t < LABEL_FORWARD_MS
    ) {
      labelForward = undefined;
      return;
    }
    // the click Enter makes on the element or on its form's submit button is
    // the press step already
    if (
      event.detail === 0 &&
      enter &&
      t - enter.t < ENTER_CLICK_MS &&
      (enter.element === element ||
        (element.closest("form") ?? enter) === enter.element.closest("form"))
    ) {
      enter = undefined;
      return;
    }
    // a checkbox or radio, or a label for one, is recorded as check
    if (isCheckable(element)) return;
    let clicked = element;
    if (element instanceof HTMLLabelElement) {
      const control = element.control;
      if (control) labelForward = { control, t };
      if (control && isCheckable(control)) return;
      // the field has a name and a role, its label usually has neither
      if (control) clicked = control;
    }
    push({ t, kind: "click", ...target(clicked) });
  });

  const onInput = guard((event: Event) => {
    const origin = asElement(event);
    const field = origin && fillField(origin);
    if (!field) return;
    // a password stays masked after a "show password" toggle
    if (isPassword(field)) passwords.add(field);
    const t = now();
    const values = valueFields(field, fieldValue(field), passwords.has(field));
    if (
      lastFill?.field === field &&
      (lastStep === lastFill.step ||
        (typing?.fill === lastFill.step && lastStep === typing.navigate))
    ) {
      const step = lastFill.step;
      step.t = t;
      // the URL the field wrote stays after the fill in time order
      if (typing?.fill === step) typing.navigate.t = t;
      if (step.masked || values.masked) {
        delete step.value;
        step.masked = true;
      } else {
        step.value = values.value;
      }
      return;
    }
    const step: Step = {
      t,
      kind: "fill",
      ...target(field),
      ...values,
      ...(field instanceof HTMLInputElement && { inputType: field.type }),
    };
    push(step);
    lastFill = { field, step };
  });

  const onChange = guard((event: Event) => {
    const element = asElement(event);
    if (!element) return;
    if (isCheckable(element)) {
      push({
        t: now(),
        kind: "check",
        ...target(element),
        checked: element.checked,
      });
      return;
    }
    if (element instanceof HTMLSelectElement) {
      push({
        t: now(),
        kind: "select",
        ...target(element),
        ...valueFields(element, element.value, false),
      });
    }
  });

  const onFocus = guard((event: FocusEvent) => {
    const field = asElement(event);
    if (field && isPassword(field)) passwords.add(field as HTMLElement);
  });

  const onKeydown = guard((event: KeyboardEvent) => {
    if (!KEYS.has(event.key)) return;
    const element = asElement(event);
    if (event.key === "Enter" && element) enter = { element, t: now() };
    push({
      t: now(),
      kind: "press",
      ...(element && element !== document.body && target(element)),
      key: event.key as StepKey,
    });
  });

  const flushScroll = (key: EventTarget) => {
    const pending = scrolls.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    scrolls.delete(key);
    push(pending.step);
  };

  const onScroll = guard((event: Event) => {
    const element = asElement(event);
    // a text field scrolls its own content while typing
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    )
      return;
    const key: EventTarget = element ?? window;
    const position = element
      ? { x: element.scrollLeft, y: element.scrollTop }
      : { x: window.scrollX, y: window.scrollY };
    const previous = scrolls.get(key);
    if (previous) clearTimeout(previous.timer);
    // the target is taken once per series, not on every scroll event
    const where = previous
      ? previous.step.target && { target: previous.step.target }
      : element && target(element);
    const step: Step = {
      t: now(),
      kind: "scroll",
      ...where,
      x: Math.round(position.x),
      y: Math.round(position.y),
    };
    scrolls.set(key, {
      step,
      timer: setTimeout(() => flushScroll(key), SCROLL_DEBOUNCE_MS),
    });
  });

  // same address twice (popstate + hashchange, replaceState of state only)
  // is one step
  const onNavigate = (how?: "replace" | "popstate") => {
    if (!active) return;
    try {
      const next = location.href;
      if (next === href) return;
      const previous = href;
      const from = index;
      href = next;
      index = historyIndex();
      if (how === "replace" && typing && lastStep === typing.navigate) {
        typing.navigate.t = now();
        typing.navigate.url = url(next);
        return;
      }
      const typed = lastFill && lastStep === lastFill.step && lastFill.step;
      const step: Step = {
        t: now(),
        kind: "navigate",
        url: url(next),
        from: url(previous),
        // a hash change fires popstate too: only a new page is back or forward
        ...(how === "popstate" &&
          withoutHash(next) !== withoutHash(previous) && {
            popstate:
              from === undefined || index === undefined
                ? ("unknown" as const)
                : index < from
                  ? ("back" as const)
                  : ("forward" as const),
          }),
      };
      push(step);
      typing =
        how === "replace" && typed
          ? { fill: typed, navigate: step }
          : undefined;
    } catch {
      // navigation tracking must not break the host router
    }
  };

  const wrapHistory = (name: "pushState" | "replaceState") => {
    const original: HistoryMethod = history[name];
    const wrapper: HistoryMethod = function (this: History, ...args) {
      const result = original.apply(this, args);
      onNavigate(name === "replaceState" ? "replace" : undefined);
      return result;
    };
    try {
      history[name] = wrapper;
    } catch {
      return () => undefined;
    }
    // a router that wrapped us later keeps its wrapper; ours goes quiet
    return () => {
      if (history[name] === wrapper) history[name] = original;
    };
  };

  push({ t: now(), kind: "navigate", url: url(href) });

  const listeners: [EventTarget, string, EventListener][] = [
    [document, "click", onClick as EventListener],
    [document, "input", onInput],
    [document, "change", onChange],
    [document, "keydown", onKeydown as EventListener],
    [document, "focusin", onFocus as EventListener],
    [document, "scroll", onScroll],
    [window, "popstate", () => onNavigate("popstate")],
    [window, "hashchange", () => onNavigate()],
  ];
  for (const [target, type, listener] of listeners)
    target.addEventListener(type, listener, { capture: true, passive: true });
  const unwrap = [wrapHistory("pushState"), wrapHistory("replaceState")];

  return {
    // pending scrolls are written at the trigger, steps come out in time order
    snapshot: () => {
      for (const key of [...scrolls.keys()]) flushScroll(key);
      const steps = buffer
        .toArray()
        .map((step) => ({ ...step }))
        .sort((a, b) => a.t - b.t);
      const evicted = buffer.lastEvicted;
      return evicted ? { steps, lastEvicted: evicted.t } : { steps };
    },
    stop: () => {
      active = false;
      for (const pending of scrolls.values()) clearTimeout(pending.timer);
      scrolls.clear();
      for (const [target, type, listener] of listeners)
        target.removeEventListener(type, listener, { capture: true });
      for (const restore of unwrap) restore();
    },
  };
};
