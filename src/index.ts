import type { BodyRule } from "./capture/network.ts";
import { startCapture, type Capture } from "./capture/index.ts";
import { startReplay } from "./replay/index.ts";
import { startReport, type Reporter } from "./report/index.ts";
import { playwrightTest, startSteps, stepsMarkdown } from "./steps/index.ts";
import type { Context, NetworkEntry, Trigger } from "./types.ts";
import { defaultUrlFilter, type UrlFilter } from "./shared/url-filter.ts";

const DEFAULT_BUFFER_SECONDS = 30;
const DEFAULT_MAX_REPORT_BYTES = 512 * 1024;

export type InitOptions = {
  endpoint: string;
  bufferSeconds?: number;
  replay?: boolean;
  maskInputs?: boolean;
  maskText?: string;
  bodyAllowlist?: readonly BodyRule[];
  urlFilter?: UrlFilter;
  networkTrigger?: (entry: NetworkEntry) => boolean;
  consoleErrorTrigger?: boolean;
  maxReportBytes?: number;
  app?: Context["app"];
  tags?: Context["tags"];
};

export type {
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
let captureApi: Capture | undefined;
let reporter: Reporter | undefined;

// non-positive or non-finite values fall back to the default
const positive = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;

const httpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

const supported = (): boolean =>
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof CompressionStream === "function" &&
  typeof MutationObserver === "function" &&
  typeof fetch === "function" &&
  typeof crypto?.getRandomValues === "function";

export const init = (options: InitOptions): boolean => {
  if (started !== undefined) return started;
  if (!supported() || !httpUrl(options.endpoint)) {
    started = false;
    return false;
  }
  const stops: (() => void)[] = [];
  try {
    start(options, stops);
    started = true;
  } catch {
    // a half-started package must not stay installed on the host page
    for (const stop of stops.reverse()) stop();
    captureApi = undefined;
    reporter = undefined;
    started = false;
  }
  return started;
};

const start = (options: InitOptions, stops: (() => void)[]): void => {
  const filter = options.urlFilter ?? defaultUrlFilter;
  const bufferSeconds = positive(options.bufferSeconds, DEFAULT_BUFFER_SECONDS);
  const replay =
    options.replay === false
      ? undefined
      : startReplay({
          bufferSeconds,
          maskInputs: options.maskInputs ?? true,
          maskText: options.maskText ?? "",
          filter,
        });
  if (replay) stops.push(replay.stop);

  const maskInputs = options.maskInputs ?? true;
  const maskText = options.maskText ?? "";
  const steps = startSteps({ maskInputs, maskText, filter });
  stops.push(steps.stop);

  let onTrigger: (trigger: Trigger) => void = () => undefined;
  const capture = startCapture(
    {
      endpoint: options.endpoint,
      urlFilter: filter,
      ...(options.bodyAllowlist && { bodyAllowlist: options.bodyAllowlist }),
      ...(options.networkTrigger && { networkTrigger: options.networkTrigger }),
      ...(options.consoleErrorTrigger !== undefined && {
        consoleErrorTrigger: options.consoleErrorTrigger,
      }),
      ...(replay && {
        onNetworkSettle: replay.emitNet,
        onConsoleEntry: replay.emitConsole,
      }),
    },
    (trigger) => onTrigger(trigger),
  );
  stops.push(capture.stop);
  const report = startReport({
    endpoint: options.endpoint,
    maxReportBytes: positive(options.maxReportBytes, DEFAULT_MAX_REPORT_BYTES),
    bufferSeconds,
    filter,
    ...(options.app && { app: options.app }),
    ...(options.tags && { tags: options.tags }),
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
};

export const capture = (error?: unknown): void => {
  captureApi?.manual(error);
};

export const flush = (): Promise<void> =>
  reporter ? reporter.flush() : Promise.resolve();
