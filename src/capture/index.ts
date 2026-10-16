import type { ConsoleEntry, NetworkEntry, Trigger } from "../types.ts";
import { RingBuffer } from "../shared/ring.ts";
import { defaultUrlFilter, type UrlFilter } from "../shared/url-filter.ts";
import { installConsole } from "./console.ts";
import { installErrorHandlers, manualTrigger } from "./errors.ts";
import {
  defaultNetworkTrigger,
  installNetwork,
  type BodyRule,
} from "./network.ts";

const CONSOLE_CAPACITY = 200;
const NETWORK_CAPACITY = 200;

export type CaptureOptions = {
  endpoint: string;
  bodyAllowlist?: readonly BodyRule[];
  urlFilter?: UrlFilter;
  networkTrigger?: (entry: NetworkEntry) => boolean;
  consoleErrorTrigger?: boolean;
  onNetworkSettle?: (id: number) => void;
  onConsoleEntry?: (entry: ConsoleEntry) => void;
  now?: () => number;
};

export type CaptureSnapshot = {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  lastEvicted: { console?: number; network?: number };
};

export type Capture = {
  snapshot: () => CaptureSnapshot;
  manual: (error?: unknown) => void;
  stop: () => void;
};

export const startCapture = (
  options: CaptureOptions,
  onTrigger: (trigger: Trigger) => void,
): Capture => {
  const filter = options.urlFilter ?? defaultUrlFilter;
  const now = options.now ?? Date.now;
  const consoleBuffer = new RingBuffer<ConsoleEntry>(CONSOLE_CAPACITY);
  const networkBuffer = new RingBuffer<NetworkEntry>(NETWORK_CAPACITY);

  const reported = new WeakSet<object>();
  const stops = [
    installErrorHandlers(onTrigger, filter, now, reported),
    installConsole(consoleBuffer, {
      filter,
      now,
      errorTrigger: options.consoleErrorTrigger ?? false,
      onTrigger,
      onEntry: options.onConsoleEntry,
    }),
    installNetwork(networkBuffer, {
      endpoint: options.endpoint,
      bodyAllowlist: options.bodyAllowlist ?? [],
      filter,
      trigger: options.networkTrigger ?? defaultNetworkTrigger,
      now,
      onTrigger,
      onSettle: options.onNetworkSettle,
      reported,
    }),
  ];

  return {
    snapshot: () => {
      const lastEvicted: CaptureSnapshot["lastEvicted"] = {};
      const consoleEvicted = consoleBuffer.lastEvicted;
      const networkEvicted = networkBuffer.lastEvicted;
      if (consoleEvicted) lastEvicted.console = consoleEvicted.t;
      if (networkEvicted) lastEvicted.network = networkEvicted.t;
      return {
        console: consoleBuffer.toArray().map((entry) => ({ ...entry })),
        network: networkBuffer.toArray().map((entry) => ({ ...entry })),
        lastEvicted,
      };
    },
    manual: (error) => {
      try {
        onTrigger(manualTrigger(error, filter, now()));
      } catch {
        // capture() must never throw into the caller
      }
    },
    stop: () => {
      for (const stop of stops.reverse()) stop();
    },
  };
};
