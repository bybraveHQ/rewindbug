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
  maskText: string;
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

const asElement = (target: EventTarget | null): Element | undefined =>
  target instanceof Element ? target : undefined;

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
  let href = location.href;

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
    password || options.maskInputs || isMasked(field, options.maskText);

  const valueFields = (field: Element, raw: string, password: boolean) =>
    masked(field, password)
      ? { masked: true as const }
      : { value: collapse(raw).slice(0, MAX_VALUE_LENGTH) };

  const target = (element: Element) => {
    const result = targetOf(element, options.maskText);
    return result ? { target: result } : {};
  };

  const onClick = guard((event: MouseEvent) => {
    const origin = asElement(event.target);
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
    const origin = asElement(event.target);
    const field = origin && fillField(origin);
    if (!field) return;
    // a password stays masked after a "show password" toggle
    if (field instanceof HTMLInputElement && field.type === "password")
      passwords.add(field);
    const t = now();
    const values = valueFields(field, fieldValue(field), passwords.has(field));
    if (lastFill?.field === field && lastStep === lastFill.step) {
      const step = lastFill.step;
      step.t = t;
      if (step.masked || values.masked) {
        delete step.value;
        step.masked = true;
      } else {
        step.value = values.value;
      }
      return;
    }
    const step: Step = { t, kind: "fill", ...target(field), ...values };
    push(step);
    lastFill = { field, step };
  });

  const onChange = guard((event: Event) => {
    const element = asElement(event.target);
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

  const onKeydown = guard((event: KeyboardEvent) => {
    if (!KEYS.has(event.key)) return;
    const element = asElement(event.target);
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
    const element = asElement(event.target);
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
  const onNavigate = () => {
    if (!active) return;
    try {
      const next = location.href;
      if (next === href) return;
      push({ t: now(), kind: "navigate", url: url(next), from: url(href) });
      href = next;
    } catch {
      // navigation tracking must not break the host router
    }
  };

  const wrapHistory = (name: "pushState" | "replaceState") => {
    const original: HistoryMethod = history[name];
    const wrapper: HistoryMethod = function (this: History, ...args) {
      const result = original.apply(this, args);
      onNavigate();
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
    [document, "scroll", onScroll],
    [window, "popstate", onNavigate],
    [window, "hashchange", onNavigate],
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
