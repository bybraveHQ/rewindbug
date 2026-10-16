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
