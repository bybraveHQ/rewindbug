import { describe, expect, it } from "vitest";
import { SegmentBuffer, type RecordedEvent } from "./buffer.ts";

const ev = (type: number, timestamp: number): RecordedEvent => ({
  type,
  timestamp,
});

describe("SegmentBuffer", () => {
  it("keeps two segments and drops the oldest on checkout", () => {
    const buffer = new SegmentBuffer(100);
    buffer.push(ev(4, 1), false);
    buffer.push(ev(2, 1), false);
    buffer.push(ev(3, 2), false);
    buffer.push(ev(4, 10), true);
    buffer.push(ev(2, 10), true);
    buffer.push(ev(3, 11), false);
    expect(buffer.slice(Infinity).map((e) => e.timestamp)).toEqual([
      1, 1, 2, 10, 10, 11,
    ]);
    buffer.push(ev(4, 20), true);
    buffer.push(ev(2, 20), true);
    expect(buffer.slice(Infinity).map((e) => e.timestamp)).toEqual([
      10, 10, 11, 20, 20,
    ]);
  });

  it("does not open a segment on a checkout FullSnapshot", () => {
    const buffer = new SegmentBuffer(100);
    buffer.push(ev(4, 1), true);
    buffer.push(ev(2, 1), true);
    buffer.push(ev(4, 5), true);
    buffer.push(ev(2, 5), true);
    buffer.push(ev(4, 9), true);
    expect(buffer.slice(Infinity).map((e) => e.timestamp)).toEqual([5, 5, 9]);
  });

  it("cuts events after the given moment", () => {
    const buffer = new SegmentBuffer(100);
    for (const t of [1, 2, 3, 4]) buffer.push(ev(3, t), false);
    expect(buffer.slice(2).map((e) => e.timestamp)).toEqual([1, 2]);
  });

  it("drops the older segment early when over the cap", () => {
    const buffer = new SegmentBuffer(4);
    buffer.push(ev(4, 1), false);
    buffer.push(ev(3, 2), false);
    buffer.push(ev(3, 3), false);
    buffer.push(ev(4, 4), true);
    expect(buffer.push(ev(3, 5), false)).toBe(true);
    expect(buffer.slice(Infinity).map((e) => e.timestamp)).toEqual([4, 5]);
  });

  it("reports overflow when the current segment alone is over the cap", () => {
    const buffer = new SegmentBuffer(2);
    expect(buffer.push(ev(4, 1), false)).toBe(true);
    expect(buffer.push(ev(3, 2), false)).toBe(true);
    expect(buffer.push(ev(3, 3), false)).toBe(false);
  });

  it("clears everything", () => {
    const buffer = new SegmentBuffer(10);
    buffer.push(ev(4, 1), false);
    buffer.clear();
    expect(buffer.size).toBe(0);
  });
});
