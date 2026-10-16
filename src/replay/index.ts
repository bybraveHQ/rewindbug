import { record } from "@rrweb/record";
import type { ConsoleEntry } from "../types.ts";
import type { UrlFilter } from "../shared/url-filter.ts";
import { SegmentBuffer, type RecordedEvent } from "./buffer.ts";
import { MutationRate, mutationCount, sanitizeEvent } from "./sanitize.ts";

const MAX_EVENTS = 20_000;
const MUTATION_LIMIT = 10_000;
const MUTATION_WINDOW_MS = 1000;
const MAX_DOM_ELEMENTS = 25_000;
const DOM_SIZE_CHECK_MS = 1000;
const IDLE_TIMEOUT_MS = 2000;
const INCREMENTAL = 3;
const META = 4;
const NET_EVENT = "rewindbug/net";
// the name rrweb's console replay plugin listens for
const CONSOLE_PLUGIN = "rrweb/console@1";

export type ReplayState =
  "not-started" | "recording" | "stopped" | "dom-too-large";

export type ReplayOptions = {
  bufferSeconds: number;
  maskInputs: boolean;
  maskText: string;
  filter: UrlFilter;
};

export type ReplaySnapshot = {
  state: ReplayState;
  mutationStorm: boolean;
  events: unknown[] | null;
};

export type Replay = {
  snapshot: (until: number) => ReplaySnapshot;
  emitNet: (id: number) => void;
  emitConsole: (entry: ConsoleEntry) => void;
  stop: () => void;
};

const onIdle = (callback: () => void): (() => void) => {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(callback, 0);
  return () => clearTimeout(handle);
};

// cheap proxy for snapshot cost: 25k elements is ~50k nodes with text
const domTooLarge = (): boolean =>
  document.getElementsByTagName("*").length > MAX_DOM_ELEMENTS;

const validSelector = (selector: string): boolean => {
  if (!selector) return true;
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
};

// a mounted subtree counts all its elements: rrweb serializes every one
const countRecords = (records: MutationRecord[]): number => {
  let count = 0;
  for (const item of records) {
    if (item.type !== "childList") {
      count += 1;
      continue;
    }
    count += item.removedNodes.length;
    for (const node of item.addedNodes) {
      count +=
        1 +
        (node instanceof Element ? node.getElementsByTagName("*").length : 0);
    }
  }
  return count;
};

export const startReplay = (options: ReplayOptions): Replay => {
  const buffer = new SegmentBuffer(MAX_EVENTS);
  const checkoutMs = options.bufferSeconds * 1000;
  // our observer runs before rrweb's and stops it before rrweb walks a storm
  const domRate = new MutationRate(MUTATION_LIMIT, MUTATION_WINDOW_MS);
  // backstop for shadow roots, which our document observer does not see
  const eventRate = new MutationRate(MUTATION_LIMIT, MUTATION_WINDOW_MS);
  let state: ReplayState = "not-started";
  let mutationStorm = false;
  let lastSizeCheck = 0;
  let lastCheckout = 0;
  let checkoutPending = false;
  let stopRecording: (() => void) | undefined;
  let cancelPending: (() => void) | undefined;
  let guard: MutationObserver | undefined;
  let pluginEmit: ((data: unknown) => void) | undefined;

  const halt = (reason: "stopped" | "dom-too-large" = "stopped") => {
    const wasRecording = state === "recording";
    state = reason;
    buffer.clear();
    guard?.disconnect();
    guard = undefined;
    pluginEmit = undefined;
    const stopFn = stopRecording;
    stopRecording = undefined;
    try {
      stopFn?.();
      // rrweb keeps every recorded node in its module mirror after stop
      if (wasRecording) record.mirror.reset();
    } catch {
      // rrweb teardown errors must not reach the host page
    }
  };

  const storm = () => {
    mutationStorm = true;
    halt();
  };

  const onMutations = (records: MutationRecord[]) => {
    if (state !== "recording") return;
    const now = performance.now();
    if (domRate.exceeded(countRecords(records), now)) {
      storm();
      return;
    }
    if (now - lastSizeCheck < DOM_SIZE_CHECK_MS) return;
    lastSizeCheck = now;
    if (domTooLarge()) halt("dom-too-large");
  };

  // own checkpoints instead of checkoutEveryNms: rrweb would snapshot right
  // after emit even when emit has just stopped the recording
  const checkpoint = () => {
    checkoutPending = false;
    if (state !== "recording") return;
    if (domTooLarge()) {
      halt("dom-too-large");
      return;
    }
    try {
      record.takeFullSnapshot(true);
    } catch {
      halt();
    }
  };

  const emit = (raw: unknown, isCheckout?: boolean) => {
    if (state !== "recording") return;
    try {
      const event = raw as RecordedEvent;
      sanitizeEvent(event, options.filter);
      if (event.type === META) lastCheckout = event.timestamp;
      if (
        eventRate.exceeded(mutationCount(event), event.timestamp) ||
        !buffer.push(event, isCheckout === true)
      ) {
        storm();
        return;
      }
      if (
        event.type === INCREMENTAL &&
        !checkoutPending &&
        event.timestamp - lastCheckout > checkoutMs
      ) {
        checkoutPending = true;
        queueMicrotask(checkpoint);
      }
    } catch {
      halt();
    }
  };

  const consolePlugin = {
    name: CONSOLE_PLUGIN,
    observer: (callback: (data: unknown) => void) => {
      pluginEmit = callback;
      return () => {
        pluginEmit = undefined;
      };
    },
    options: {},
  };

  const begin = () => {
    cancelPending = undefined;
    if (state !== "not-started") return;
    if (!validSelector(options.maskText)) {
      // an invalid selector would silently disable text masking in rrweb
      state = "stopped";
      return;
    }
    if (domTooLarge()) {
      state = "dom-too-large";
      return;
    }
    state = "recording";
    lastSizeCheck = performance.now();
    guard = new MutationObserver(onMutations);
    guard.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    let stopFn: (() => void) | undefined;
    try {
      stopFn = record({
        emit,
        maskAllInputs: options.maskInputs,
        ...(options.maskText ? { maskTextSelector: options.maskText } : {}),
        blockClass: "rb-block",
        slimDOMOptions: "all",
        sampling: { mousemove: 50, scroll: 150, input: "last" },
        inlineStylesheet: false,
        recordCanvas: false,
        plugins: [consolePlugin],
        errorHandler: () => {
          queueMicrotask(() => {
            if (state === "recording") halt();
          });
          return true;
        },
      });
    } catch {
      stopFn = undefined;
    }
    if (state !== "recording") {
      try {
        stopFn?.();
        record.mirror.reset();
      } catch {
        // already halted, teardown is best effort
      }
      return;
    }
    stopRecording = stopFn;
    if (!stopFn) halt();
  };

  const onLoad = () => {
    cancelPending = onIdle(begin);
  };

  if (document.readyState === "complete") {
    onLoad();
  } else {
    window.addEventListener("load", onLoad, { once: true });
    cancelPending = () => window.removeEventListener("load", onLoad);
  }

  return {
    snapshot: (until) => ({
      state,
      mutationStorm,
      events: state === "recording" ? buffer.slice(until) : null,
    }),
    emitNet: (id) => {
      if (state !== "recording") return;
      try {
        record.addCustomEvent(NET_EVENT, { id });
      } catch {
        // rrweb throws when called outside an active recording
      }
    },
    emitConsole: (entry) => {
      if (state !== "recording" || !pluginEmit) return;
      try {
        pluginEmit({
          level: entry.level,
          trace: [],
          payload: [JSON.stringify(entry.message)],
        });
      } catch {
        // the host console call must not see recording errors
      }
    },
    stop: () => {
      cancelPending?.();
      cancelPending = undefined;
      if (state === "not-started" || state === "recording") halt();
    },
  };
};
