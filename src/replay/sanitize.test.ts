import { describe, expect, it } from "vitest";
import { defaultUrlFilter } from "../shared/url-filter.ts";
import type { RecordedEvent } from "./buffer.ts";
import { MutationRate, mutationCount, sanitizeEvent } from "./sanitize.ts";

const mutation = (timestamp: number, adds: number): RecordedEvent => ({
  type: 3,
  timestamp,
  data: {
    source: 0,
    adds: new Array<unknown>(adds).fill({}),
    removes: [],
    attributes: [],
    texts: [],
  },
});

describe("sanitizeEvent", () => {
  it("filters href in Meta", () => {
    const event: RecordedEvent = {
      type: 4,
      timestamp: 1,
      data: {
        href: "https://u:p@app.test/a?token=abc&page=2",
        width: 1,
        height: 1,
      },
    };
    sanitizeEvent(event, defaultUrlFilter);
    expect(event.data).toMatchObject({
      href: "https://app.test/a?token=*&page=2",
    });
  });
});

describe("urls in the recorded DOM", () => {
  const page = "https://app.test/reset?token=S&tab=2#main";
  const masked = "https://app.test/reset?token=*&tab=2";

  it("filters url attributes anywhere in a full snapshot", () => {
    const event: RecordedEvent = {
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 0,
          childNodes: [
            {
              type: 2,
              tagName: "a",
              attributes: { href: page, class: "skip", title: page },
              childNodes: [
                {
                  type: 2,
                  tagName: "img",
                  attributes: { src: page, srcset: `${page} 1x, ${page} 2x` },
                  childNodes: [],
                },
              ],
            },
          ],
        },
      },
    };
    sanitizeEvent(event, defaultUrlFilter);
    const text = JSON.stringify(event);
    // only url attributes: a title keeps what the page showed
    expect(text.match(/token=S/g)).toHaveLength(1);
    expect(text).toContain(`"title":"${page}"`);
    expect(
      text.match(new RegExp(masked.replace(/[?*]/g, "\\$&"), "g")),
    ).toHaveLength(4);
  });

  it("filters relative urls, iframe sources and urls inside css", () => {
    const event: RecordedEvent = {
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 2,
          tagName: "div",
          attributes: { style: `background: url(${page})` },
          childNodes: [
            {
              type: 2,
              tagName: "form",
              attributes: { action: "/reset?token=S" },
            },
            {
              type: 2,
              tagName: "video",
              attributes: { poster: "/p.png?sig=S" },
            },
            { type: 2, tagName: "iframe", attributes: { rr_src: page } },
            {
              type: 2,
              tagName: "style",
              attributes: { _cssText: `.a { background: url(${page}); }` },
            },
          ],
        },
      },
    };
    sanitizeEvent(event, defaultUrlFilter);
    const text = JSON.stringify(event);
    expect(text).not.toMatch(/token=S|sig=S/);
    expect(text).toContain("/reset?token=*");
    expect(text).toContain("/p.png?sig=*");
  });

  it("filters style objects, css rules and text", () => {
    const styleChange: RecordedEvent = {
      type: 3,
      timestamp: 1,
      data: {
        source: 0,
        adds: [
          {
            parentId: 1,
            node: { type: 3, textContent: `.a { background: url(${page}) }` },
          },
        ],
        attributes: [
          { id: 2, attributes: { style: { background: `url(${page})` } } },
        ],
        texts: [{ id: 3, value: `see ${page}` }],
        removes: [],
      },
    };
    const rule: RecordedEvent = {
      type: 3,
      timestamp: 1,
      data: {
        source: 8,
        id: 4,
        adds: [{ rule: `.b { background: url(${page}) }`, index: 0 }],
      },
    };
    sanitizeEvent(styleChange, defaultUrlFilter);
    sanitizeEvent(rule, defaultUrlFilter);
    const text = JSON.stringify([styleChange, rule]);
    expect(text).not.toContain("token=S");
    expect(text.match(/token=\*/g)).toHaveLength(4);
  });

  it("filters url attributes in added nodes and attribute changes", () => {
    const event: RecordedEvent = {
      type: 3,
      timestamp: 1,
      data: {
        source: 0,
        adds: [
          {
            parentId: 1,
            node: { type: 2, tagName: "a", attributes: { href: page } },
          },
        ],
        attributes: [{ id: 2, attributes: { href: page, "data-x": page } }],
        removes: [],
        texts: [],
      },
    };
    sanitizeEvent(event, defaultUrlFilter);
    const text = JSON.stringify(event);
    expect(text.match(/token=S/g)).toHaveLength(1);
    expect(text).toContain(`"data-x":"${page}"`);
  });
});

describe("mutation storm", () => {
  it("counts only DOM mutation events", () => {
    expect(mutationCount(mutation(1, 3))).toBe(3);
    expect(mutationCount({ type: 3, timestamp: 1, data: { source: 2 } })).toBe(
      0,
    );
    expect(mutationCount({ type: 2, timestamp: 1 })).toBe(0);
  });

  it("trips above the limit inside one window", () => {
    const rate = new MutationRate(10, 1000);
    expect(rate.exceeded(6, 0)).toBe(false);
    expect(rate.exceeded(4, 500)).toBe(false);
    expect(rate.exceeded(1, 900)).toBe(true);
  });

  it("resets on a new window", () => {
    const rate = new MutationRate(10, 1000);
    expect(rate.exceeded(9, 0)).toBe(false);
    expect(rate.exceeded(9, 1000)).toBe(false);
  });
});
