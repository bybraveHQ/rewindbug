export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export type ConsoleEntry = {
  t: number;
  level: ConsoleLevel;
  message: string;
};

export type NetworkEntry = {
  id: number;
  t: number;
  type: "fetch" | "xhr";
  method: string;
  url: string;
  state: "pending" | "done" | "failed";
  status?: number;
  durationMs?: number;
  error?: "abort" | "network" | "timeout";
  contentType?: string;
  requestBody?: string;
  responseBody?: string;
};

export type TriggerError = {
  name: string;
  message: string;
  stack?: string;
};

export type Trigger = {
  kind: "error" | "unhandledrejection" | "console.error" | "network" | "manual";
  at: number;
  message: string;
  error?: TriggerError;
  requestId?: number;
};

export type Context = {
  url: string;
  referrer?: string;
  title: string;
  userAgent: string;
  language: string;
  timezone: string;
  viewport: { width: number; height: number; dpr: number };
  app?: { release?: string; environment?: string };
  tags?: Record<string, string>;
};

export type Range = {
  start: number;
  end: number;
  startUrl: string;
};

export type ReplayData = {
  format: "rrweb";
  events: unknown[];
};

export type Limits = {
  truncated: Array<"body" | "console" | "network" | "steps" | "replay">;
  mutationStorm?: true;
  replayState?:
    "off" | "not-started" | "stopped" | "dom-too-large" | "too-large";
};

export type Report = {
  schemaVersion: 0;
  id: string;
  fingerprint: string;
  createdAt: number;
  sdk: { name: "rewindbug"; version: string; rrwebVersion: string };
  trigger: Trigger;
  context: Context;
  range: Range;
  steps: Step[];
  stepsMarkdown: string;
  test: string;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  replay: ReplayData | null;
  limits: Limits;
};

export type Target = {
  testId?: string;
  role?: string;
  name?: string;
  css: string;
  unique: boolean;
  nth?: number;
  // the name comes from a <label>, aria-label or aria-labelledby, so a field
  // without a role is found by its label
  label?: true;
};

export type StepKey = "Enter" | "Escape" | "Tab";

export type Step = {
  t: number;
  kind: "navigate" | "click" | "fill" | "check" | "select" | "press" | "scroll";
  target?: Target;
  value?: string;
  masked?: true;
  // the type of an <input> behind a fill, so a masked value can be replaced
  // by one the field accepts
  inputType?: string;
  checked?: boolean;
  key?: StepKey;
  x?: number;
  y?: number;
  url?: string;
  from?: string;
  // back or forward in the browser, not a navigation by the page;
  // "unknown" where the Navigation API cannot tell the direction
  popstate?: "back" | "forward" | "unknown";
  requestIds?: number[];
};
