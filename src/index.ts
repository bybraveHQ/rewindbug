import type { BodyRule } from "./capture/network.ts";
import { startCapture, type Capture } from "./capture/index.ts";
import { startReplay } from "./replay/index.ts";
import { startReport, type Reporter } from "./report/index.ts";
import { sendStarted } from "./report/started.ts";
import { playwrightTest, startSteps, stepsMarkdown } from "./steps/index.ts";
import { defaultNetworkTrigger } from "./capture/network.ts";
import type { Context, NetworkEntry, Report, Trigger } from "./types.ts";
import {
  defaultUrlFilter,
  resolveUrl,
  type UrlFilter,
} from "./shared/url-filter.ts";

const DEFAULT_BUFFER_SECONDS = 30;
// each window starts with a full DOM snapshot: shorter windows mean more of them
const MIN_BUFFER_SECONDS = 5;
const DEFAULT_MAX_REPORT_BYTES = 512 * 1024;

export type NetworkTrigger = (entry: NetworkEntry) => boolean;

export type InitOptions = {
  endpoint: string;
  bufferSeconds?: number;
  replay?: boolean;
  maskInputs?: boolean;
  maskSelector?: string;
  bodyAllowlist?: readonly BodyRule[];
  // the default rule comes in as an argument: a custom one builds on it
  urlFilter?: (url: string, defaultFilter: UrlFilter) => string;
  networkTrigger?: (
    entry: NetworkEntry,
    defaultTrigger: NetworkTrigger,
  ) => boolean;
  consoleErrorTrigger?: boolean;
  maxReportBytes?: number;
  sampleRate?: number;
  beforeSend?: (report: Report) => Report | null;
  debug?: boolean;
  // a beacon to <endpoint>/started tells the receiver the page is covered
  coverage?: boolean;
  app?: Context["app"];
  tags?: Context["tags"];
};

export type CaptureOptions = { tags?: Context["tags"] };

export { defaultNetworkTrigger, defaultUrlFilter };
export type { BodyRule, UrlFilter };

export type {
  ConsoleLevel,
  ReplayData,
  StepKey,
  TriggerError,
  ConsoleEntry,
  Context,
  Limits,
  NetworkEntry,
  Range,
  Report,
  Step,
  Target,
  Trigger,
} from "./types.ts";

let started: boolean | undefined;
let failure = "";
let captureApi: Capture | undefined;
let reporter: Reporter | undefined;

// non-positive or non-finite values fall back to the default
const positive = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;

// a relative endpoint is resolved against the page
const httpUrl = (value: unknown): string | undefined => {
  const url = typeof value === "string" ? resolveUrl(value) : null;
  return url && (url.protocol === "http:" || url.protocol === "https:")
    ? url.href
    : undefined;
};

const supported = (): boolean =>
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof CompressionStream === "function" &&
  typeof MutationObserver === "function" &&
  typeof fetch === "function" &&
  typeof crypto?.getRandomValues === "function";

export const init = (options: InitOptions): boolean => {
  const fail = (reason: string) => {
    // debug output is opt-in: a library stays silent in the host console
    if (options?.debug) console.warn(`rewindbug: not started, ${reason}`);
    failure ||= reason;
    return false;
  };
  if (started !== undefined)
    return started || fail(`an earlier init failed: ${failure}`);
  started = false;
  if (!supported()) return fail("unsupported browser");
  const endpoint = httpUrl(options?.endpoint);
  if (!endpoint) return fail("endpoint is not http(s)");
  const rate = options.sampleRate ?? 1;
  if (!(Math.random() < (Number.isFinite(rate) ? rate : 1)))
    return fail("sampled out");
  const stops: (() => void)[] = [];
  try {
    start(options, endpoint, stops);
    started = true;
  } catch {
    // a half-started package must not stay installed on the host page
    for (const stop of stops.reverse()) stop();
    captureApi = undefined;
    reporter = undefined;
    return fail("setup failed");
  }
  return true;
};

const start = (
  options: InitOptions,
  endpoint: string,
  stops: (() => void)[],
): void => {
  const { urlFilter, networkTrigger } = options;
  const filter: UrlFilter = urlFilter
    ? (url) => urlFilter(url, defaultUrlFilter)
    : defaultUrlFilter;
  const maskInputs = options.maskInputs ?? true;
  const maskSelector = options.maskSelector ?? "";
  const bufferSeconds = Math.max(
    MIN_BUFFER_SECONDS,
    positive(options.bufferSeconds, DEFAULT_BUFFER_SECONDS),
  );
  const replay =
    options.replay === false
      ? undefined
      : startReplay({
          bufferSeconds,
          maskInputs,
          maskSelector,
          filter,
        });
  if (replay) stops.push(replay.stop);

  const steps = startSteps({ maskInputs, maskSelector, filter });
  stops.push(steps.stop);

  let onTrigger: (trigger: Trigger, tags?: Context["tags"]) => void = () =>
    undefined;
  const capture = startCapture(
    {
      endpoint,
      urlFilter: filter,
      ...(options.bodyAllowlist && { bodyAllowlist: options.bodyAllowlist }),
      ...(networkTrigger && {
        networkTrigger: (entry: NetworkEntry) =>
          networkTrigger(entry, defaultNetworkTrigger),
      }),
      ...(options.consoleErrorTrigger !== undefined && {
        consoleErrorTrigger: options.consoleErrorTrigger,
      }),
      ...(replay && {
        onNetworkSettle: replay.emitNet,
        onConsoleEntry: replay.emitConsole,
      }),
    },
    (trigger, tags) => onTrigger(trigger, tags),
  );
  stops.push(capture.stop);
  const report = startReport({
    endpoint,
    maxReportBytes: positive(options.maxReportBytes, DEFAULT_MAX_REPORT_BYTES),
    bufferSeconds,
    filter,
    ...(options.app && { app: options.app }),
    ...(options.tags && { tags: options.tags }),
    ...(options.beforeSend && { beforeSend: options.beforeSend }),
    capture: capture.snapshot,
    replay: (until) => (replay ? replay.snapshot(until) : { state: "off" }),
    steps: steps.snapshot,
    describeSteps: stepsMarkdown,
    describeTest: playwrightTest,
  });
  stops.push(report.stop);
  onTrigger = report.onTrigger;
  captureApi = capture;
  reporter = report;
  if (options.coverage !== false) sendStarted(endpoint, filter);
};

// tags here are added to the init tags of this one report
export const capture = (error?: unknown, options?: CaptureOptions): void => {
  captureApi?.manual(error, options?.tags);
};

export const flush = (): Promise<void> =>
  reporter ? reporter.flush() : Promise.resolve();
