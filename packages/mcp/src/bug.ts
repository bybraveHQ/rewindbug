import { z } from "zod";
import { BugSummary, type ReadReport, type Stored } from "./store.ts";

export const MAX_BODY_CHARS = 2000;
export const MAX_ENTRIES = 50;
export const MAX_BUG_BYTES = 200 * 1024;
const MAX_TRIMMED_STEPS = 20;
const MAX_TRIMMED_TEXT = 10_000;
const MAX_TRIMMED_URL = 2000;
// top-level fields of schema v0; anything else is dropped as a last resort
const KNOWN_FIELDS = new Set([
  "schemaVersion",
  "id",
  "fingerprint",
  "createdAt",
  "sdk",
  "trigger",
  "context",
  "range",
  "steps",
  "stepsMarkdown",
  "test",
  "console",
  "network",
  "replay",
  "limits",
]);

const NetworkView = z.looseObject({
  id: z.number().optional(),
  t: z.number().optional(),
  type: z.string().optional(),
  method: z.string().optional(),
  url: z.string().optional(),
  state: z.string().optional(),
  status: z.number().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
  contentType: z.string().optional(),
  requestBody: z.string().optional(),
  responseBody: z.string().optional(),
  requestBodyTruncated: z.literal(true).optional(),
  responseBodyTruncated: z.literal(true).optional(),
});

const ConsoleView = z.looseObject({
  t: z.number().optional(),
  level: z.string().optional(),
  message: z.string().optional(),
});

const StepView = z.looseObject({
  t: z.number().optional(),
  kind: z.string().optional(),
  target: z.looseObject({}).optional(),
  value: z.string().optional(),
  masked: z.boolean().optional(),
  checked: z.boolean().optional(),
  key: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  url: z.string().optional(),
  from: z.string().optional(),
  requestIds: z.array(z.number()).optional(),
});

// as loose as reading: a report of a newer SDK must not break the tools
const ReportView = z.looseObject({
  schemaVersion: z.number(),
  id: z.string(),
  createdAt: z.number(),
  fingerprint: z.string(),
  trigger: z.looseObject({
    kind: z.string(),
    message: z.string(),
    requestId: z.number().optional(),
  }),
  context: z.looseObject({ url: z.string() }),
  steps: z.array(StepView),
  stepsMarkdown: z.string(),
  test: z.string(),
  console: z.array(ConsoleView),
  network: z.array(NetworkView),
  limits: z.looseObject({}),
  replay: z.object({ events: z.number() }),
});

export const Bug = z.object({
  id: z.string(),
  receivedAt: z.number(),
  path: z
    .string()
    .describe(
      "Absolute path of the full report with rrweb events; large, no need to read it whole",
    ),
  report: ReportView,
  trimmed: z.array(z.enum(["console", "network", "steps", "test", "fields"])),
});
export type Bug = z.infer<typeof Bug>;

export const BugOutput = z.object({
  bug: Bug.nullable(),
  message: z.string().optional(),
});
export const BugsOutput = z.object({
  bugs: z.array(BugSummary),
  message: z.string().optional(),
});

type Shape = Record<string, z.ZodType>;
type Entry = Record<string, unknown>;

const isEntry = (value: unknown): value is Entry =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// known fields of a wrong type are dropped, unknown fields pass as they are
const sanitize = (list: unknown[], shape: Shape): Entry[] =>
  list.filter(isEntry).map((raw) => {
    const entry: Entry = {};
    for (const [key, value] of Object.entries(raw)) {
      // own keys only: "constructor" or "__proto__" from a page are plain data
      const field = Object.hasOwn(shape, key) ? shape[key] : undefined;
      if (field && !field.safeParse(value).success) continue;
      Object.defineProperty(entry, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return entry;
  });

const cut = (text: string, max: number): string | undefined => {
  const points = [...text];
  return points.length > max ? points.slice(0, max).join("") : undefined;
};

const cutBodies = (entry: Entry): Entry => {
  const result = { ...entry };
  for (const key of ["requestBody", "responseBody"] as const) {
    const value = result[key];
    const short =
      typeof value === "string" ? cut(value, MAX_BODY_CHARS) : undefined;
    if (short === undefined) continue;
    result[key] = short;
    result[`${key}Truncated`] = true;
  }
  return result;
};

// the last n entries; the one with keepId stays even if it is older
const lastEntries = (list: Entry[], n: number, keepId?: number): Entry[] => {
  if (list.length <= n) return list;
  if (n === 0) return [];
  const keep = list.slice(-n);
  if (keepId === undefined) return keep;
  const pinned = list.find((entry) => entry.id === keepId);
  if (!pinned || keep.includes(pinned)) return keep;
  return [pinned, ...keep.slice(1)];
};

type Limits = {
  entries: number;
  steps?: number;
  text?: number;
  knownOnly?: true;
};

const project = (stored: Stored, limits: Limits): Bug => {
  const { summary, report } = stored;
  const trimmed = new Set<Bug["trimmed"][number]>();
  const network = sanitize(report.network, NetworkView.shape).map(cutBodies);
  const consoleEntries = sanitize(report.console, ConsoleView.shape);
  const steps = sanitize(report.steps, StepView.shape);
  const keptNetwork = lastEntries(
    network,
    limits.entries,
    report.trigger.requestId,
  );
  const keptConsole = lastEntries(consoleEntries, limits.entries);
  if (keptNetwork.length < network.length) trimmed.add("network");
  if (keptConsole.length < consoleEntries.length) trimmed.add("console");
  const keptSteps =
    limits.steps === undefined ? steps : lastEntries(steps, limits.steps);
  if (keptSteps.length < steps.length) trimmed.add("steps");
  let { test, stepsMarkdown } = report;
  if (limits.text !== undefined) {
    const shortTest = cut(test, limits.text);
    const shortSteps = cut(stepsMarkdown, limits.text);
    if (shortTest !== undefined || shortSteps !== undefined)
      trimmed.add("test");
    test = shortTest ?? test;
    stepsMarkdown = shortSteps ?? stepsMarkdown;
  }
  let { trigger, context } = report;
  if (limits.text !== undefined) {
    const message = cut(trigger.message, limits.text);
    const url = cut(context.url, MAX_TRIMMED_URL);
    if (message !== undefined || url !== undefined) trimmed.add("test");
    trigger = { ...trigger, message: message ?? trigger.message };
    context = { ...context, url: url ?? context.url };
  }
  const { replay, ...all } = report as ReadReport & Entry;
  const rest: Entry = {};
  for (const [key, value] of Object.entries(all)) {
    if (limits.knownOnly && !KNOWN_FIELDS.has(key)) {
      trimmed.add("fields");
      continue;
    }
    Object.defineProperty(rest, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const view = {
    ...rest,
    trigger,
    context,
    steps: keptSteps,
    stepsMarkdown,
    test,
    console: keptConsole,
    network: keptNetwork,
    replay: { events: replay?.events.length ?? 0 },
  };
  return {
    id: summary.id,
    receivedAt: summary.receivedAt,
    path: summary.path,
    report: view as Bug["report"],
    trimmed: [...trimmed],
  };
};

const bytes = (bug: Bug): number => Buffer.byteLength(JSON.stringify(bug));

// rrweb events never reach the agent; the rest is cut until it fits
export const toBug = (stored: Stored): Bug => {
  const limits: Limits = { entries: MAX_ENTRIES };
  let bug = project(stored, limits);
  while (bytes(bug) > MAX_BUG_BYTES && limits.entries > 0) {
    limits.entries = Math.floor(limits.entries / 2);
    bug = project(stored, limits);
  }
  if (bytes(bug) > MAX_BUG_BYTES) {
    limits.steps = MAX_TRIMMED_STEPS;
    bug = project(stored, limits);
  }
  if (bytes(bug) > MAX_BUG_BYTES) {
    limits.text = MAX_TRIMMED_TEXT;
    bug = project(stored, limits);
  }
  if (bytes(bug) > MAX_BUG_BYTES) {
    limits.knownOnly = true;
    bug = project(stored, limits);
  }
  return bug;
};
