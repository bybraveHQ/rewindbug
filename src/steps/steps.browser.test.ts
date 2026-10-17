import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import type { Step } from "../types.ts";
import { defaultUrlFilter } from "../shared/url-filter.ts";
import { startSteps, type Steps } from "./index.ts";

const SCROLL_SETTLE_MS = 350;

let steps: Steps | undefined;

const start = (
  overrides: { maskInputs?: boolean; maskSelector?: string } = {},
) => {
  steps = startSteps({
    maskInputs: overrides.maskInputs ?? true,
    maskSelector: overrides.maskSelector ?? "",
    filter: defaultUrlFilter,
  });
  return steps;
};

const recorded = (s: Steps): Partial<Step>[] =>
  s
    .snapshot()
    .steps.filter((step) => step.kind !== "navigate")
    .map((step) => {
      const copy: Partial<Step> = { ...step };
      delete copy.t;
      return copy;
    });

const $ = <T extends Element>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`no ${selector}`);
  return element;
};

afterEach(() => {
  steps?.stop();
  steps = undefined;
  document.body.innerHTML = "";
});

describe("steps", () => {
  it("starts with the page load as navigate", () => {
    const s = start();
    expect(s.snapshot().steps).toEqual([
      expect.objectContaining({ kind: "navigate", url: location.href }),
    ]);
  });

  it("records a click on the nearest interactive ancestor", async () => {
    document.body.innerHTML =
      '<button data-testid="pay"><span>Pay now</span></button>';
    const s = start();
    await userEvent.click($("span"));
    expect(recorded(s)).toEqual([
      {
        kind: "click",
        target: expect.objectContaining({
          testId: "pay",
          role: "button",
          name: "Pay now",
        }),
      },
    ]);
  });

  it("nth does not count hidden elements, like getByRole", async () => {
    document.body.innerHTML =
      '<a href="/a" style="display:none">Login</a><a href="/b">Login</a>';
    const s = start();
    // a real link click would navigate the test frame away
    document.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    await userEvent.click($('a[href="/b"]'));
    expect(recorded(s)[0]?.target).not.toHaveProperty("nth");
  });

  it("ignores events the page dispatches itself", () => {
    document.body.innerHTML = "<button>Go</button>";
    const s = start();
    $<HTMLButtonElement>("button").click();
    expect(recorded(s)).toEqual([]);
  });

  it("merges typing into one fill and masks it by default", async () => {
    document.body.innerHTML = '<input aria-label="Email">';
    const s = start();
    await userEvent.type($("input"), "jane@example.com");
    expect(recorded(s)).toEqual([
      {
        kind: "fill",
        target: expect.objectContaining({ name: "Email" }),
        masked: true,
        inputType: "text",
      },
    ]);
  });

  it("data-rb-unmask keeps a value, never a password or one under maskSelector", async () => {
    document.body.innerHTML = `
      <input aria-label="Coupon" data-rb-unmask>
      <div data-rb-unmask>
        <input type="password" aria-label="Password">
        <div class="pii"><input aria-label="Name"></div>
      </div>
    `;
    const s = start({ maskSelector: ".pii" });
    await userEvent.type($("input"), "WELCOME");
    await userEvent.type($('[type="password"]'), "hunter2");
    await userEvent.type($(".pii input"), "Jane");
    expect(recorded(s)).toEqual([
      expect.objectContaining({ kind: "fill", value: "WELCOME" }),
      expect.objectContaining({ kind: "fill", masked: true }),
      expect.objectContaining({ kind: "fill", masked: true }),
    ]);
  });

  it("data-rb-unmask keeps a password masked after show password", async () => {
    document.body.innerHTML = `
      <div data-rb-unmask>
        <input type="password" aria-label="Password">
        <input autocomplete="current-password" aria-label="PIN">
      </div>
    `;
    const s = start();
    const field = $<HTMLInputElement>('[type="password"]');
    field.focus();
    field.type = "text";
    await userEvent.type(field, "hunter2");
    await userEvent.type($("[autocomplete]"), "1234");
    expect(recorded(s)).toEqual([
      expect.objectContaining({ kind: "fill", masked: true }),
      expect.objectContaining({ kind: "fill", masked: true }),
    ]);
  });

  it("Enter is one press step, not a press and the click it makes", async () => {
    document.body.innerHTML = `
      <button>Toggle</button>
      <form><input aria-label="Q"><button>Go</button></form>
    `;
    document
      .querySelector("form")
      ?.addEventListener("submit", (event) => event.preventDefault());
    const s = start({ maskInputs: false });
    $<HTMLButtonElement>("button").focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.type($("input"), "a{Enter}");
    await userEvent.click($("form button"));
    expect(recorded(s).map((step) => step.kind)).toEqual([
      "press",
      "fill",
      "press",
      "click",
    ]);
  });

  it("a field written into the URL while typing is one fill and one navigation", async () => {
    document.body.innerHTML = '<input aria-label="Search">';
    const before = location.href;
    $("input").addEventListener("input", (event) => {
      const value = (event.target as HTMLInputElement).value;
      history.replaceState({}, "", `?q=${value}`);
    });
    const s = start({ maskInputs: false });
    await userEvent.type($("input"), "abc");
    // the first step is the page load
    const steps = s.snapshot().steps.slice(1);
    history.replaceState({}, "", before);
    expect(steps).toEqual([
      expect.objectContaining({ kind: "fill", value: "abc" }),
      expect.objectContaining({
        kind: "navigate",
        url: expect.stringContaining("?q=abc"),
      }),
    ]);
  });

  it("typing after the URL was written keeps the fill first", async () => {
    document.body.innerHTML = '<input aria-label="Search">';
    const before = location.href;
    const field = $<HTMLInputElement>("input");
    const s = start({ maskInputs: false });
    await userEvent.type(field, "ab");
    history.replaceState({}, "", "?q=ab");
    await userEvent.type(field, "c");
    const kinds = s
      .snapshot()
      .steps.slice(1)
      .map((step) => step.kind);
    history.replaceState({}, "", before);
    expect(kinds).toEqual(["fill", "navigate"]);
  });

  it("marks a navigation by back or forward", async () => {
    const before = location.href;
    const s = start();
    history.pushState({}, "", "?page=2");
    const popped = new Promise((resolve) =>
      window.addEventListener("popstate", resolve, { once: true }),
    );
    history.back();
    await popped;
    const last = s.snapshot().steps.at(-1);
    history.replaceState({}, "", before);
    // Chromium has the Navigation API and knows the direction
    expect(last).toMatchObject({ kind: "navigate", popstate: "back" });
  });

  it("a hash change by script is not back or forward", async () => {
    const before = location.href;
    const s = start();
    const popped = new Promise((resolve) =>
      window.addEventListener("popstate", resolve, { once: true }),
    );
    location.hash = "tab2";
    await popped;
    const last = s.snapshot().steps.at(-1);
    history.replaceState({}, "", before);
    expect(last).toMatchObject({ kind: "navigate" });
    expect(last).not.toHaveProperty("popstate");
  });

  it("keeps values with maskInputs off, except passwords and maskSelector", async () => {
    document.body.innerHTML = `
      <input aria-label="City">
      <input type="password" aria-label="Password">
      <div class="pii"><input aria-label="Name"></div>
      <select aria-label="Size"><option value="s">S</option><option value="m">M</option></select>
    `;
    const s = start({ maskInputs: false, maskSelector: ".pii" });
    await userEvent.type($("input"), "Kyiv");
    await userEvent.type($('[type="password"]'), "hunter2");
    await userEvent.type($(".pii input"), "Jane");
    // selectOptions changes the value from script, so its events are not
    // trusted; a real key press is
    $<HTMLSelectElement>("select").focus();
    await userEvent.keyboard("m");
    expect(recorded(s)).toEqual([
      expect.objectContaining({ kind: "fill", value: "Kyiv" }),
      expect.objectContaining({ kind: "fill", masked: true }),
      expect.objectContaining({ kind: "fill", masked: true }),
      expect.objectContaining({ kind: "select", value: "m" }),
    ]);
    expect(JSON.stringify(s.snapshot())).not.toMatch(/hunter2|Jane/);
  });

  it("keeps a revealed password masked, also inside a merged fill", async () => {
    document.body.innerHTML = '<input type="password" aria-label="Password">';
    const s = start({ maskInputs: false });
    const field = $<HTMLInputElement>("input");
    await userEvent.type(field, "hunter2");
    field.type = "text";
    await userEvent.type(field, "X");
    document.body.insertAdjacentHTML("beforeend", "<button>Next</button>");
    await userEvent.click($("button"));
    await userEvent.type(field, "Y");
    const fills = recorded(s).filter((step) => step.kind === "fill");
    expect(fills).toEqual([
      expect.objectContaining({ masked: true }),
      expect.objectContaining({ masked: true }),
    ]);
    expect(JSON.stringify(s.snapshot())).not.toMatch(/hunter2/);
    for (const fill of fills) expect(fill).not.toHaveProperty("value");
  });

  it("a field scrolling its own text keeps one fill", async () => {
    document.body.innerHTML = '<input aria-label="Note" style="width: 40px">';
    const s = start({ maskInputs: false });
    await userEvent.type($("input"), "a long line that overflows the field");
    await new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_MS));
    await userEvent.type($("input"), " more");
    expect(recorded(s).map((step) => step.kind)).toEqual(["fill"]);
  });

  it("a click inside a dialog is on the element, not on the dialog", async () => {
    document.body.innerHTML =
      '<div role="dialog" aria-label="Modal"><div class="row">Row</div></div>';
    const s = start();
    await userEvent.click($(".row"));
    expect(recorded(s)).toEqual([
      expect.objectContaining({
        target: expect.not.objectContaining({ role: "dialog" }),
      }),
    ]);
  });

  it("records a checkbox as check, also through its label", async () => {
    document.body.innerHTML =
      '<label><input type="checkbox"> Terms</label><label for="n">News</label><input id="n" type="checkbox">';
    const s = start();
    await userEvent.click($("input"));
    await userEvent.click($('label[for="n"]'));
    expect(recorded(s)).toEqual([
      expect.objectContaining({
        kind: "check",
        checked: true,
        target: expect.objectContaining({ name: "Terms" }),
      }),
      expect.objectContaining({
        kind: "check",
        checked: true,
        target: expect.objectContaining({ name: "News" }),
      }),
    ]);
  });

  it("records a label click on its field and skips the forwarded click", async () => {
    document.body.innerHTML = '<label for="q">Query</label><input id="q">';
    const s = start();
    await userEvent.click($("label"));
    expect(recorded(s)).toEqual([
      expect.objectContaining({
        kind: "click",
        target: expect.objectContaining({ role: "textbox", name: "Query" }),
      }),
    ]);
  });

  it("records Enter, Escape and Tab only", async () => {
    document.body.innerHTML = '<input aria-label="Q">';
    const s = start();
    $<HTMLInputElement>("input").focus();
    await userEvent.keyboard("a{Enter}{Escape}{Tab}{ArrowDown}");
    expect(
      recorded(s)
        .filter((step) => step.kind === "press")
        .map((step) => step.key),
    ).toEqual(["Enter", "Escape", "Tab"]);
  });

  it("debounces scroll and writes a pending one at snapshot", async () => {
    document.body.innerHTML = '<div style="height: 5000px"></div>';
    const s = start();
    window.scrollTo(0, 400);
    window.scrollTo(0, 800);
    await new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_MS));
    window.scrollTo(0, 100);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(recorded(s)).toEqual([
      { kind: "scroll", x: 0, y: 800 },
      { kind: "scroll", x: 0, y: 100 },
    ]);
    window.scrollTo(0, 0);
  });

  it("the history wrapper keeps this and the return value", () => {
    const s = start();
    const before = location.href;
    expect(history.pushState({ a: 1 }, "", "?w=1")).toBeUndefined();
    expect(history.state).toEqual({ a: 1 });
    const bound = history.pushState.bind(history);
    bound({}, "", "?w=2");
    expect(s.snapshot().steps.at(-1)).toMatchObject({
      kind: "navigate",
      url: expect.stringContaining("w=2"),
    });
    history.replaceState({}, "", before);
  });

  it("popstate and hashchange to the same address are one step", () => {
    const s = start();
    const before = location.href;
    history.replaceState({}, "", "#one");
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(
      s.snapshot().steps.filter((step) => step.kind === "navigate"),
    ).toHaveLength(2);
    history.replaceState({}, "", before);
  });

  it("stop keeps a router wrapper installed on top of ours and goes quiet", () => {
    const original = history.pushState;
    const s = start();
    const ours = history.pushState;
    const router: History["pushState"] = function (this: History, ...args) {
      ours.apply(this, args);
    };
    history.pushState = router;
    s.stop();
    expect(history.pushState).toBe(router);
    const count = s.snapshot().steps.length;
    const before = location.href;
    history.pushState({}, "", "?after-stop");
    expect(s.snapshot().steps).toHaveLength(count);
    history.pushState = original;
    history.replaceState({}, "", before);
  });

  it("records history navigation once per address and restores history on stop", () => {
    const original = history.pushState;
    const s = start();
    const before = location.href;
    history.pushState({}, "", "?step=2&token=abc");
    history.replaceState({ more: 1 }, "", location.href);
    const navigations = s
      .snapshot()
      .steps.filter((step) => step.kind === "navigate");
    expect(navigations).toHaveLength(2);
    expect(navigations[1]).toMatchObject({
      from: before,
      url: expect.stringContaining("token=*"),
    });
    s.stop();
    expect(history.pushState).toBe(original);
    history.replaceState({}, "", before);
  });
});
