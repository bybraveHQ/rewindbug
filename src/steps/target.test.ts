import { afterEach, describe, expect, test } from "vitest";
import { cssPath, nameOf, roleOf, targetOf } from "./target.ts";

const html = (markup: string) => {
  document.body.innerHTML = markup;
};
const $ = (selector: string) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`no ${selector}`);
  return element;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("roleOf", () => {
  test.each([
    ["<button>b</button>", "button", "button"],
    ['<input type="submit">', "input", "button"],
    ['<a href="/x">x</a>', "a", "link"],
    ["<a>x</a>", "a", undefined],
    ["<input>", "input", "textbox"],
    ['<input type="email">', "input", "textbox"],
    ['<input type="search">', "input", "searchbox"],
    ["<select multiple></select>", "select", "listbox"],
    ["<textarea></textarea>", "textarea", "textbox"],
    ['<input type="checkbox">', "input", "checkbox"],
    ['<input type="radio">', "input", "radio"],
    ["<select></select>", "select", "combobox"],
    ['<input type="number">', "input", "spinbutton"],
    ['<input type="range">', "input", "slider"],
    ['<input type="date">', "input", undefined],
    ['<div role="tab menuitem">t</div>', "div", "tab"],
  ])("%s → %s", (markup, selector, role) => {
    html(markup);
    expect(roleOf($(selector))).toBe(role);
  });
});

describe("nameOf", () => {
  test("follows the priority order", () => {
    html(`
      <span id="l1">Labelled</span>
      <button id="a" aria-label="Aria" aria-labelledby="l1" title="T">Text</button>
      <button id="b" aria-labelledby="l1" title="T">Text</button>
      <label for="c">From label</label><input id="c" placeholder="P">
      <input id="d" placeholder="Search" title="T">
      <input id="h" placeholder="Search">
      <button id="i" title="Close dialog">X</button>
      <img id="e" alt="Logo" title="T">
      <button id="f">  Save
        draft </button>
      <input id="g" type="submit" value="Send">
    `);
    // accessible-name order, as Playwright's getByRole computes it
    expect(nameOf($("#a"), "")).toBe("Labelled");
    expect(nameOf($("#b"), "")).toBe("Labelled");
    expect(nameOf($("#c"), "")).toBe("From label");
    expect(nameOf($("#d"), "")).toBe("T");
    expect(nameOf($("#h"), "")).toBe("Search");
    expect(nameOf($("#i"), "")).toBe("X");
    expect(nameOf($("#e"), "")).toBe("Logo");
    expect(nameOf($("#f"), "")).toBe("Save draft");
    expect(nameOf($("#g"), "")).toBe("Send");
  });

  test("never reads the content of fields", () => {
    html(`
      <textarea id="t">secret text</textarea>
      <select id="s"><option>Alpha</option><option>Beta</option></select>
      <div id="e" contenteditable="true" role="button">typed</div>
    `);
    expect(nameOf($("#t"), "")).toBeUndefined();
    expect(nameOf($("#s"), "")).toBeUndefined();
    expect(nameOf($("#e"), "")).toBeUndefined();
  });

  test("a wrapping label does not pull in the options of its select", () => {
    html(
      "<label>Country <select><option>Alpha</option><option>Beta</option></select></label>",
    );
    expect(nameOf($("select"), "")).toBe("Country");
  });

  test("cuts to 40 characters", () => {
    html(`<button>${"x".repeat(60)}</button>`);
    expect(nameOf($("button"), "")).toHaveLength(40);
  });

  test("no name inside maskSelector or .rb-block, an invalid selector masks", () => {
    html(`
      <div class="pii"><button id="a">Jane Roe</button></div>
      <div class="rb-block"><button id="b">Card</button></div>
      <button id="c">Plain</button>
    `);
    expect(nameOf($("#a"), ".pii")).toBeUndefined();
    expect(nameOf($("#b"), "")).toBeUndefined();
    expect(nameOf($("#c"), "")).toBe("Plain");
    expect(nameOf($("#c"), "div[")).toBeUndefined();
  });
});

describe("cssPath", () => {
  test("uses a stable unique id", () => {
    html('<div><button id="save">s</button></div>');
    expect(cssPath($("#save"))).toEqual({ css: "#save", unique: true });
  });

  test("skips generated ids and walks up until the path is unique", () => {
    html(`
      <main id="app">
        <ul><li><a id=":r1:">a</a></li><li><a id="item-1234">b</a></li></ul>
      </main>
      <section><ul><li><a>c</a></li><li><a>d</a></li></ul></section>
    `);
    expect(cssPath($('[id="item-1234"]'))).toEqual({
      css: "#app > ul:nth-of-type(1) > li:nth-of-type(2) > a:nth-of-type(1)",
      unique: true,
    });
    expect(cssPath($('[id=":r1:"]')).css).not.toContain(":r1:");
  });

  test("stops at five levels and says when it is not unique", () => {
    const depth = 7;
    const nest = (n: number): string =>
      n === 0 ? "<i></i>" : `<div>${nest(n - 1)}</div>`;
    html(nest(depth) + nest(depth));
    const result = cssPath(document.querySelectorAll("i")[0] as Element);
    expect(result.css.split(" > ")).toHaveLength(5);
    expect(result.unique).toBe(false);
  });
});

describe("targetOf", () => {
  test("adds testId and nth when the tier is not unique", () => {
    html(`
      <button data-testid="buy">Buy</button>
      <button data-testid="buy">Buy</button>
      <a href="/a">More</a><a href="/b">More</a>
    `);
    const second = document.querySelectorAll("button")[1] as Element;
    expect(targetOf(second, "")).toMatchObject({
      testId: "buy",
      role: "button",
      name: "Buy",
      nth: 1,
    });
    const link = document.querySelectorAll("a")[0] as Element;
    expect(targetOf(link, "")).toMatchObject({
      role: "link",
      name: "More",
      nth: 0,
    });
    html('<button data-testid="only">x</button>');
    expect(targetOf($("button"), "")).not.toHaveProperty("nth");
  });
});

describe("names and indexes for a click", () => {
  test.each(["tab", "option", "menuitem", "treeitem", "switch"])(
    "a %s is named by its text",
    (role) => {
      html(`<div role="${role}"><span>Delete</span></div>`);
      expect(nameOf($("div"), "")).toBe("Delete");
    },
  );

  test("a css path that matches several elements carries the index", () => {
    const card =
      "<div><div><div><div><div><span>Open</span></div></div></div></div></div>";
    html(`<section>${card}${card}${card}</section>`);
    const second = document.querySelectorAll("span")[1];
    if (!second) throw new Error("no span");
    const target = targetOf(second, "");
    expect(target).toMatchObject({ unique: false, nth: 1 });
    expect(document.querySelectorAll(target?.css ?? "")[1]).toBe(second);
  });

  test("a unique css path has no index", () => {
    html("<main><p>One</p></main>");
    expect(targetOf($("p"), "")).not.toHaveProperty("nth");
  });
});
