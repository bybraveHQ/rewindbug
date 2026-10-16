import type { ConsoleEntry, ConsoleLevel, Trigger } from "../types.ts";
import type { RingBuffer } from "../shared/ring.ts";
import { serializeArgs } from "../shared/serialize.ts";
import type { UrlFilter } from "../shared/url-filter.ts";
import { toTriggerError } from "./errors.ts";

const LEVELS: readonly ConsoleLevel[] = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
];

type ConsoleMethod = (...args: unknown[]) => void;

export const installConsole = (
  buffer: RingBuffer<ConsoleEntry>,
  options: {
    filter: UrlFilter;
    now: () => number;
    errorTrigger: boolean;
    onTrigger: (trigger: Trigger) => void;
    onEntry?: ((entry: ConsoleEntry) => void) | undefined;
  },
): (() => void) => {
  const installed = new Map<
    ConsoleLevel,
    { original: ConsoleMethod; wrapper: ConsoleMethod }
  >();
  let active = true;
  let inside = false;

  const record = (level: ConsoleLevel, args: unknown[]) => {
    if (!active || inside) return;
    inside = true;
    try {
      const message = serializeArgs(args, options.filter);
      const t = options.now();
      const entry = { t, level, message };
      buffer.push(entry);
      try {
        options.onEntry?.({ ...entry });
      } catch {
        // a failing entry hook must not drop the trigger below
      }
      if (level === "error" && options.errorTrigger) {
        const errorArg = args.find((arg) => arg instanceof Error);
        const error = toTriggerError(errorArg ?? message, options.filter);
        options.onTrigger({ kind: "console.error", at: t, message, error });
      }
    } catch {
      // recording must never break the host console call
    } finally {
      inside = false;
    }
  };

  for (const level of LEVELS) {
    const original = console[level] as ConsoleMethod;
    const wrapper = function (this: unknown, ...args: unknown[]) {
      record(level, args);
      return original.apply(this, args);
    };
    try {
      console[level] = wrapper;
      installed.set(level, { original, wrapper });
    } catch {
      // a frozen console method stays unwrapped
    }
  }

  return () => {
    active = false;
    for (const [level, { original, wrapper }] of installed) {
      if (console[level] === wrapper) console[level] = original;
    }
  };
};
