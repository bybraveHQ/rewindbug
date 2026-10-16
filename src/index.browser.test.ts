import { record } from "@rrweb/record";
import { expect, test, vi } from "vitest";
import { init } from "./index.ts";

const POLL_MS = 10;
const WAIT_MS = 3000;

test("init starts recording and ignores a non-positive bufferSeconds", async () => {
  expect(init({ endpoint: "https://sink.test/r", bufferSeconds: -1 })).toBe(
    true,
  );
  const deadline = performance.now() + WAIT_MS;
  while (record.mirror.getIds().length === 0) {
    if (performance.now() > deadline)
      throw new Error("recording did not start");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const snapshot = vi.spyOn(record, "takeFullSnapshot");
  document.body.append(document.createElement("i"));
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5));
  expect(snapshot).not.toHaveBeenCalled();
});
