import { expect, test } from "vitest";
import { RingBuffer } from "./ring.ts";

test("keeps the newest items and remembers the last evicted one", () => {
  const ring = new RingBuffer<number>(3);
  for (const n of [1, 2, 3, 4, 5]) ring.push(n);
  expect(ring.toArray()).toEqual([3, 4, 5]);
  expect(ring.lastEvicted).toBe(2);
});
