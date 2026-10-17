import { record } from "@rrweb/record";

// bare rrweb with the options the replay module uses: the floor we cannot
// lower, so the budgets apply to what the package adds on top of it
const IDLE_TIMEOUT_MS = 2000;
const events: unknown[] = [];

const start = () =>
  record({
    emit: (event) => {
      events.push(event);
    },
    maskAllInputs: true,
    blockClass: "rb-block",
    slimDOMOptions: "all",
    sampling: { mousemove: 50, scroll: 150, input: "last" },
    inlineStylesheet: false,
    recordCanvas: false,
  });

if (document.readyState === "complete") {
  requestIdleCallback(start, { timeout: IDLE_TIMEOUT_MS });
} else {
  window.addEventListener(
    "load",
    () => requestIdleCallback(start, { timeout: IDLE_TIMEOUT_MS }),
    { once: true },
  );
}
