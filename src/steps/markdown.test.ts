import { describe, expect, test } from "vitest";
import type { Step } from "../types.ts";
import { escapeMarkdown, stepsMarkdown } from "./markdown.ts";

const target = (name?: string, role?: string) => ({
  css: "#x",
  unique: true,
  ...(name && { name }),
  ...(role && { role }),
});

const steps: Step[] = [
  { t: 1, kind: "navigate", url: "https://app.example/cart" },
  { t: 2, kind: "click", target: target("Pay", "button") },
  { t: 3, kind: "click", target: target() },
  { t: 4, kind: "fill", target: target("Email"), value: "a@b.c" },
  { t: 5, kind: "fill", target: target("Card"), masked: true },
  { t: 6, kind: "check", target: target("Terms"), checked: true },
  { t: 7, kind: "check", target: target("News"), checked: false },
  { t: 8, kind: "select", target: target("Country"), value: "ua" },
  { t: 9, kind: "press", key: "Enter" },
  { t: 10, kind: "scroll", x: 0, y: 840 },
  { t: 11, kind: "navigate", url: "https://app.example/pay", from: "x" },
  {
    t: 12,
    kind: "navigate",
    url: "https://app.example/cart",
    popstate: "back",
  },
  {
    t: 13,
    kind: "navigate",
    url: "https://app.example/a",
    popstate: "unknown",
  },
];

describe("stepsMarkdown", () => {
  test("follows the templates", () => {
    expect(stepsMarkdown(steps, "Oops")).toBe(
      [
        "1. Open https://app.example/cart",
        "2. Click “Pay” (button)",
        "3. Click \\#x",
        "4. Type “a@b.c” into “Email”",
        "5. Type a value into “Card”",
        "6. Check “Terms”",
        "7. Uncheck “News”",
        "8. Select “ua” in “Country”",
        "9. Press Enter",
        "10. Scroll to 840",
        "11. The page goes to https://app.example/pay",
        "12. Go back to https://app.example/cart",
        "13. Go back or forward to https://app.example/a",
        "",
        "Error: Oops",
      ].join("\n"),
    );
  });

  test("no steps gives only the error line", () => {
    expect(stepsMarkdown([], "Oops")).toBe("Error: Oops");
  });
});

test("escapes the role, which comes from the page too", () => {
  const step: Step = {
    t: 1,
    kind: "click",
    target: {
      css: "#x",
      unique: true,
      name: "Pay",
      role: "[x](https://evil.example)",
    },
  };
  expect(stepsMarkdown([step], "e")).toContain(
    "(\\[x\\](https://evil.example))",
  );
});

describe("escapeMarkdown", () => {
  test("escapes a mention after punctuation, not inside an email", () => {
    expect(escapeMarkdown("(@team) «@ops» a@b.c")).toBe(
      "(\\@team) «\\@ops» a@b.c",
    );
  });

  test("keeps page text on one line and out of markup and mentions", () => {
    expect(
      escapeMarkdown("**bold** [x](y)\n# h <b> `c` _i_ \\ @team a@b"),
    ).toBe(
      "\\*\\*bold\\*\\* \\[x\\](y) \\# h \\<b\\> \\`c\\` \\_i\\_ \\\\ \\@team a@b",
    );
  });
});

describe("several elements with one name", () => {
  test.each([
    [1, "2nd"],
    [2, "3rd"],
    [3, "4th"],
    [10, "11th"],
    [11, "12th"],
    [12, "13th"],
    [20, "21st"],
    [101, "102nd"],
  ])("nth %i reads as the %s", (nth, word) => {
    const click: Step = {
      t: 1,
      kind: "click",
      target: { ...target("Add", "button"), nth },
    };
    expect(stepsMarkdown([click], "Oops")).toContain(
      `1. Click the ${word} “Add” (button)`,
    );
  });

  test("a single element has no number", () => {
    const click: Step = {
      t: 1,
      kind: "click",
      target: target("Add", "button"),
    };
    expect(stepsMarkdown([click], "Oops")).toContain("1. Click “Add” (button)");
  });
});
