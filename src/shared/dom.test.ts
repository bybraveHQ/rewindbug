import { afterEach, describe, expect, it } from "vitest";
import { closestAcross } from "./dom.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("closestAcross", () => {
  it("goes from a shadow root to its host", () => {
    document.body.innerHTML = '<div class="private"><span></span></div>';
    const host = document.querySelector("span");
    const root = host?.attachShadow({ mode: "open" });
    if (!root) throw new Error("no shadow root");
    root.innerHTML = "<input>";
    const field = root.querySelector("input");
    if (!field) throw new Error("no field");
    expect(closestAcross(field, ".private")).toBe(
      document.querySelector(".private"),
    );
  });

  it("stops at the document even when the page names an element host", () => {
    // document.host is then that element: following it would never end
    document.body.innerHTML =
      '<img name="host"><form name="host"></form><input>';
    const field = document.querySelector("input");
    if (!field) throw new Error("no field");
    expect(closestAcross(field, ".private")).toBeNull();
  });
});
