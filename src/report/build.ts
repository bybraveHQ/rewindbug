import type {
  ConsoleEntry,
  Context,
  Limits,
  NetworkEntry,
  Report,
  Step,
  Trigger,
} from "../types.ts";
import type { UrlFilter } from "../shared/url-filter.ts";

const MAX_URL_LENGTH = 2000;
const MAX_TITLE_LENGTH = 200;
const META = 4;
const STEP_REQUEST_WINDOW_MS = 1000;

export type CaptureSource = {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  lastEvicted: { console?: number; network?: number };
};

export type ReplaySource =
  | { state: "off" }
  | {
      state: "not-started" | "recording" | "stopped" | "dom-too-large";
      mutationStorm: boolean;
      events: unknown[] | null;
    };

export type StepsSource = {
  steps: Step[];
  lastEvicted?: number;
};

export type ReportInput = {
  id: string;
  fingerprint: string;
  createdAt: number;
  trigger: Trigger;
  context: Context;
  bufferSeconds: number;
  capture: CaptureSource;
  replay: ReplaySource;
  steps: StepsSource;
  describeSteps: (steps: Step[], message: string) => string;
  describeTest: (report: TestInput) => string;
};

export type TestInput = Pick<Report, "trigger" | "range" | "steps" | "network">;

type MetaEvent = { type: number; timestamp: number; data?: { href?: unknown } };

export const collectContext = (
  filter: UrlFilter,
  extra: Pick<Context, "app" | "tags">,
): Context => {
  const context: Context = {
    url: filter(location.href).slice(0, MAX_URL_LENGTH),
    title: document.title.slice(0, MAX_TITLE_LENGTH),
    userAgent: navigator.userAgent,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    },
  };
  if (document.referrer)
    context.referrer = filter(document.referrer).slice(0, MAX_URL_LENGTH);
  if (extra.app) context.app = { ...extra.app };
  if (extra.tags) context.tags = { ...extra.tags };
  return context;
};

export const reportId = (): string => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // RFC 4122 version 4 and variant bits
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const replayFields = (
  source: ReplaySource,
): Pick<Report, "replay"> & Pick<Limits, "mutationStorm" | "replayState"> => {
  if (source.state === "off") return { replay: null, replayState: "off" };
  const storm = source.mutationStorm ? { mutationStorm: true as const } : {};
  if (source.state === "recording" && source.events?.length)
    return { replay: { format: "rrweb", events: source.events }, ...storm };
  const replayState =
    source.state === "recording" ? "not-started" : source.state;
  return { replay: null, replayState, ...storm };
};

// requests that started within a second after the step and before the next
const linkRequests = (steps: Step[], requests: NetworkEntry[]): Step[] =>
  steps.map((step, index) => {
    const next = steps[index + 1]?.t ?? Infinity;
    const end = Math.min(step.t + STEP_REQUEST_WINDOW_MS, next);
    const ids = requests
      .filter((entry) => entry.t >= step.t && entry.t < end)
      .map((entry) => entry.id);
    return ids.length > 0 ? { ...step, requestIds: ids } : step;
  });

// without a recording the test starts where the first navigation in the
// window started, or on the current page
const firstAddress = (steps: Step[], fallback: string): string => {
  const navigate = steps.find((step) => step.kind === "navigate");
  return navigate?.from ?? navigate?.url ?? fallback;
};

export const buildReport = (input: ReportInput): Report => {
  const { trigger, capture, context } = input;
  const { replay, mutationStorm, replayState } = replayFields(input.replay);
  const meta = replay?.events[0] as MetaEvent | undefined;
  const fromReplay = meta?.type === META ? meta : undefined;
  const start =
    fromReplay?.timestamp ?? trigger.at - input.bufferSeconds * 1000;
  const href = fromReplay?.data?.href;
  const inRange = <T extends { t: number }>(entries: T[]) =>
    entries.filter((entry) => entry.t >= start && entry.t <= trigger.at);
  const steps = linkRequests(inRange(input.steps.steps), capture.network);
  // the request behind a network trigger stays even if it began earlier
  const requests = capture.network.filter(
    (entry) =>
      (entry.t >= start && entry.t <= trigger.at) ||
      entry.id === trigger.requestId,
  );

  const limits: Limits = { truncated: [] };
  const evicted = capture.lastEvicted;
  if (evicted.console !== undefined && evicted.console >= start)
    limits.truncated.push("console");
  if (evicted.network !== undefined && evicted.network >= start)
    limits.truncated.push("network");
  const stepsEvicted = input.steps.lastEvicted;
  if (stepsEvicted !== undefined && stepsEvicted >= start)
    limits.truncated.push("steps");
  if (mutationStorm) limits.mutationStorm = true;
  if (replayState) limits.replayState = replayState;

  const range = {
    start,
    end: trigger.at,
    startUrl:
      typeof href === "string" ? href : firstAddress(steps, context.url),
  };

  return {
    schemaVersion: 0,
    id: input.id,
    fingerprint: input.fingerprint,
    createdAt: input.createdAt,
    sdk: {
      name: "rewindbug",
      version: __REWINDBUG_VERSION__,
      rrwebVersion: __RRWEB_VERSION__,
    },
    trigger,
    context,
    range,
    steps,
    stepsMarkdown: input.describeSteps(steps, trigger.message),
    test: input.describeTest({ trigger, range, steps, network: requests }),
    console: inRange(capture.console),
    network: requests,
    replay,
    limits,
  };
};
