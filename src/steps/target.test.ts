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

  test("skips React 19 useId and library-prefixed ids", () => {
    for (const id of [
      "_r_6_",
      "base-ui-_r_6_",
      "radix-«r2»",
      "headlessui-:r3:",
    ]) {
      html(`<main><span id="${id}">x</span></main>`);
      expect(cssPath($(`[id="${id}"]`)).css).not.toContain("#");
    }
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

describe("fields found by their label", () => {
  test("a password field is named and marked by its label", () => {
    html(`
      <label>Email <input type="email"></label>
      <label>Password <input type="password"></label>
    `);
    const target = targetOf($("input[type=password]"), "");
    expect(target).toMatchObject({ name: "Password", label: true });
    expect(target).not.toHaveProperty("role");
    expect(target).not.toHaveProperty("nth");
  });

  test("aria-label counts, a placeholder or title does not", () => {
    html(`
      <input type="password" aria-label="PIN">
      <input type="password" placeholder="Secret">
      <div title="Hint">x</div>
    `);
    expect(targetOf($("input[aria-label]"), "")).toMatchObject({
      name: "PIN",
      label: true,
    });
    expect(targetOf($("input[placeholder]"), "")).not.toHaveProperty("label");
    expect(targetOf($("div"), "")).not.toHaveProperty("label");
  });

  test("a field with a role keeps getByRole", () => {
    html("<label>Email <input type=email></label>");
    expect(targetOf($("input"), "")).toMatchObject({ role: "textbox" });
    expect(targetOf($("input"), "")).not.toHaveProperty("label");
  });

  test("nth counts the fields with the same label", () => {
    html(`
      <form><label>Password <input type="password"></label></form>
      <form><label>Password <input type="password"></label></form>
    `);
    const second = document.querySelectorAll("input")[1];
    if (!second) throw new Error("no input");
    expect(targetOf(second, "")).toMatchObject({ label: true, nth: 1 });
  });
});

describe("masked text never becomes a name", () => {
  test("a link or button holding masked text has no name, only css", () => {
    html(`
      <a href="/keys/1"><code class="secret">ghp_abc123</code> key</a>
      <button><span class="rb-block">sk_live_42</span> copy</button>
    `);
    const link = targetOf($("a"), ".secret");
    const button = targetOf($("button"), "");
    expect(link).not.toHaveProperty("name");
    expect(button).not.toHaveProperty("name");
    expect(JSON.stringify([link, button])).not.toMatch(/ghp_abc123|sk_live_42/);
    expect(link?.css).toBeTruthy();
  });

  test("a label or aria-labelledby holding masked text names nothing", () => {
    html(`
      <label>Token <b class="secret">tok_9</b> <input id="a"></label>
      <span id="l1">Key <i class="rb-block">key_7</i></span>
      <input id="b" aria-labelledby="l1" placeholder="Paste here">
    `);
    const byLabel = targetOf($("#a"), ".secret");
    const byIds = targetOf($("#b"), "");
    expect(JSON.stringify([byLabel, byIds])).not.toMatch(/tok_9|key_7/);
    expect(byLabel).not.toHaveProperty("label");
    // a later source without masked text still names the field
    expect(byIds).toMatchObject({ name: "Paste here" });
  });

  test("text without masked content still names the element", () => {
    html('<a href="/keys">Show <span class="other">keys</span></a>');
    expect(targetOf($("a"), ".secret")).toMatchObject({ name: "Show keys" });
  });
});
