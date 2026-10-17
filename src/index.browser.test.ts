import { record } from "@rrweb/record";
import { expect, test, vi } from "vitest";
import { init } from "./index.ts";

const POLL_MS = 10;
const WAIT_MS = 3000;
// past the asked 0.5 s window, well inside the 5 s floor
const PAST_SHORT_WINDOW_MS = 700;

test("init starts recording and raises a short bufferSeconds to 5 s", async () => {
  expect(init({ endpoint: "https://sink.test/r", bufferSeconds: 0.5 })).toBe(
    true,
  );
  const deadline = performance.now() + WAIT_MS;
  while (record.mirror.getIds().length === 0) {
    if (performance.now() > deadline)
      throw new Error("recording did not start");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const snapshot = vi.spyOn(record, "takeFullSnapshot");
  await new Promise((resolve) => setTimeout(resolve, PAST_SHORT_WINDOW_MS));
  document.body.append(document.createElement("i"));
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5));
  expect(snapshot).not.toHaveBeenCalled();
});
