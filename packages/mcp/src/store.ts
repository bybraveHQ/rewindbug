import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { log } from "./log.ts";

export const MAX_REPORTS = 100;
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_SUMMARY_MESSAGE = 1000;
const ORPHAN_AGE_MS = 60 * 60_000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const UUID = new RegExp(`^${UUID_SOURCE}$`);
const BASE = new RegExp(`^(\\d{8}T\\d{9}Z)-(${UUID_SOURCE})$`);
const SUMMARY_EXT = ".summary.json";
const REPORT_EXT = ".json";
const TMP_EXT = ".tmp";

// what the server reads from a report; newer SDK revisions add fields and
// enum values, so everything is loose and enums are plain strings
export const ReadReport = z.looseObject({
  schemaVersion: z.literal(0),
  id: z.string().regex(UUID),
  createdAt: z.number(),
  fingerprint: z.string(),
  sdk: z.looseObject({ name: z.literal("rewindbug") }),
  trigger: z.looseObject({
    kind: z.string(),
    message: z.string(),
    requestId: z.number().optional(),
  }),
  context: z.looseObject({ url: z.string() }),
  steps: z.array(z.unknown()),
  stepsMarkdown: z.string(),
  test: z.string(),
  console: z.array(z.unknown()),
  network: z.array(z.unknown()),
  limits: z.looseObject({}),
  replay: z.looseObject({ events: z.array(z.unknown()) }).nullable(),
});
export type ReadReport = z.infer<typeof ReadReport>;

export const BugSummary = z.looseObject({
  id: z.string(),
  receivedAt: z.number(),
  createdAt: z.number(),
  kind: z.string(),
  message: z.string(),
  url: z.string(),
  fingerprint: z.string(),
  stepsCount: z.number(),
  path: z.string(),
});
export type BugSummary = z.infer<typeof BugSummary>;

export type Stored = { summary: BugSummary; report: ReadReport };
export type ReadResult =
  | { status: "ok"; stored: Stored }
  | { status: "missing" }
  | { status: "invalid" };

export const reportsDir = (root: string): string =>
  join(resolve(root), "reports");

export const ensureDirs = async (root: string): Promise<void> => {
  await mkdir(resolve(root), { recursive: true, mode: DIR_MODE });
  await mkdir(reportsDir(root), { recursive: true, mode: DIR_MODE });
};

// 2026-10-16T12:00:00.123Z -> 20261016T120000123Z
export const stamp = (ms: number): string =>
  new Date(ms).toISOString().replace(/[-:.]/g, "");

const unstamp = (value: string): number =>
  Date.parse(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T` +
      `${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.` +
      `${value.slice(15, 18)}Z`,
  );

type Name = { base: string; id: string; receivedAt: number };

const parseBase = (base: string): Name | undefined => {
  const match = BASE.exec(base);
  if (!match?.[1] || !match[2]) return undefined;
  return { base, id: match[2], receivedAt: unstamp(match[1]) };
};

const code = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | null)?.code;

const isMissing = (error: unknown): boolean => code(error) === "ENOENT";

const removeFile = async (path: string): Promise<void> => {
  try {
    await rm(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
};

const listDir = async (root: string): Promise<string[]> => {
  try {
    return await readdir(reportsDir(root));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
};

type Listing = {
  summaries: Map<string, Name>;
  reports: Set<string>;
  others: string[];
};

const scan = async (root: string): Promise<Listing> => {
  const listing: Listing = {
    summaries: new Map(),
    reports: new Set(),
    others: [],
  };
  for (const file of await listDir(root)) {
    if (file.endsWith(SUMMARY_EXT)) {
      const name = parseBase(file.slice(0, -SUMMARY_EXT.length));
      if (name) listing.summaries.set(name.base, name);
      else listing.others.push(file);
    } else if (file.endsWith(REPORT_EXT)) {
      const name = parseBase(file.slice(0, -REPORT_EXT.length));
      if (name) listing.reports.add(name.base);
      else listing.others.push(file);
    } else {
      listing.others.push(file);
    }
  }
  return listing;
};

export const validateReport = (
  value: unknown,
  receivedAt: number,
): ReadReport | string => {
  const parsed = ReadReport.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return `invalid report: ${issue?.path.join(".") || "root"} ${issue?.message ?? ""}`.trim();
  }
  const { createdAt } = parsed.data;
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0)
    return "invalid report: createdAt";
  if (createdAt > receivedAt + MAX_CLOCK_SKEW_MS)
    return "invalid report: createdAt is in the future";
  return parsed.data;
};

export const toSummary = (
  report: ReadReport,
  path: string,
  receivedAt: number,
): BugSummary => ({
  id: report.id,
  receivedAt,
  createdAt: report.createdAt,
  kind: report.trigger.kind,
  message: [...report.trigger.message].slice(0, MAX_SUMMARY_MESSAGE).join(""),
  url: report.context.url,
  fingerprint: report.fingerprint,
  stepsCount: report.steps.length,
  path,
});

const writeAtomic = async (target: string, text: string): Promise<string> => {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}${TMP_EXT}`;
  await writeFile(tmp, text, { mode: FILE_MODE });
  return tmp;
};

const prune = async (root: string): Promise<void> => {
  const { summaries, reports } = await scan(root);
  const bases = [...new Set([...summaries.keys(), ...reports])].sort();
  const excess = bases.slice(0, Math.max(0, bases.length - MAX_REPORTS));
  const dir = reportsDir(root);
  for (const base of excess) {
    await removeFile(join(dir, base + SUMMARY_EXT));
    await removeFile(join(dir, base + REPORT_EXT));
  }
};

const save = async (
  root: string,
  report: ReadReport,
  text: string,
  receivedAt: number,
): Promise<BugSummary> => {
  // the user may delete the folder while the server runs
  await ensureDirs(root);
  const dir = reportsDir(root);
  const base = `${stamp(receivedAt)}-${report.id}`;
  const reportPath = join(dir, base + REPORT_EXT);
  const summary = toSummary(report, reportPath, receivedAt);
  const summaryPath = join(dir, base + SUMMARY_EXT);
  const temps: string[] = [];
  try {
    temps.push(await writeAtomic(summaryPath, JSON.stringify(summary)));
    temps.push(await writeAtomic(reportPath, text));
    await rename(temps[0] ?? "", summaryPath);
    await rename(temps[1] ?? "", reportPath);
  } catch (error) {
    for (const tmp of temps) await removeFile(tmp).catch(() => undefined);
    throw error;
  }
  // the older copy goes only after the new one is in place
  const { summaries, reports } = await scan(root);
  for (const old of new Set([...summaries.keys(), ...reports])) {
    if (old !== base && parseBase(old)?.id === report.id) {
      await removeFile(join(dir, old + SUMMARY_EXT));
      await removeFile(join(dir, old + REPORT_EXT));
    }
  }
  await prune(root);
  return summary;
};

let queue: Promise<unknown> = Promise.resolve();

// writes in one process go one at a time; two processes are reconciled by
// deduplication on read
export const saveReport = (
  root: string,
  report: ReadReport,
  text: string,
  receivedAt: number,
): Promise<BugSummary> => {
  const result = queue.then(() => save(root, report, text, receivedAt));
  queue = result.catch(() => undefined);
  return result;
};

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

// newest first: by createdAt, then by arrival
export const listSummaries = async (
  root: string,
  limit = MAX_REPORTS,
): Promise<BugSummary[]> => {
  const { summaries, reports } = await scan(root);
  const dir = reportsDir(root);
  const byId = new Map<string, BugSummary>();
  for (const name of summaries.values()) {
    if (!reports.has(name.base)) continue;
    let value: unknown;
    try {
      value = await readJson(join(dir, name.base + SUMMARY_EXT));
    } catch (error) {
      if (!isMissing(error)) log(`skipped ${name.base}: unreadable summary`);
      continue;
    }
    const parsed = BugSummary.safeParse(value);
    if (!parsed.success) {
      log(`skipped ${name.base}: invalid summary`);
      continue;
    }
    // id and path come from the file name: a moved folder still reads, and
    // a summary cannot point the server at another file
    const summary = {
      ...parsed.data,
      id: name.id,
      receivedAt: name.receivedAt,
      path: join(dir, name.base + REPORT_EXT),
    };
    const known = byId.get(summary.id);
    if (!known || known.receivedAt < summary.receivedAt)
      byId.set(summary.id, summary);
  }
  return [...byId.values()]
    .sort((a, b) => b.createdAt - a.createdAt || b.receivedAt - a.receivedAt)
    .slice(0, limit);
};

const readStored = async (summary: BugSummary): Promise<ReadResult> => {
  let value: unknown;
  try {
    value = await readJson(summary.path);
  } catch (error) {
    if (isMissing(error)) return { status: "missing" };
    log(`skipped ${summary.id}: unreadable report`);
    return { status: "invalid" };
  }
  const parsed = ReadReport.safeParse(value);
  if (!parsed.success) {
    log(`skipped ${summary.id}: invalid report`);
    return { status: "invalid" };
  }
  return { status: "ok", stored: { summary, report: parsed.data } };
};

export const readReport = async (
  root: string,
  id: string,
): Promise<ReadResult> => {
  const summary = (await listSummaries(root)).find((item) => item.id === id);
  return summary ? readStored(summary) : { status: "missing" };
};

export const lastReadable = async (
  root: string,
): Promise<Stored | undefined> => {
  for (const summary of await listSummaries(root)) {
    const result = await readStored(summary);
    if (result.status === "ok") return result.stored;
  }
  return undefined;
};

// leftovers of a crash: temp files and halves of a pair older than an hour
export const cleanOrphans = async (
  root: string,
  now = Date.now(),
): Promise<void> => {
  const dir = reportsDir(root);
  const { summaries, reports, others } = await scan(root);
  const candidates = [
    ...others.filter((file) => file.endsWith(TMP_EXT)),
    ...[...summaries.keys()]
      .filter((base) => !reports.has(base))
      .map((base) => base + SUMMARY_EXT),
    ...[...reports]
      .filter((base) => !summaries.has(base))
      .map((base) => base + REPORT_EXT),
  ];
  for (const file of candidates) {
    const path = join(dir, file);
    try {
      const { mtimeMs } = await stat(path);
      if (now - mtimeMs > ORPHAN_AGE_MS) await rm(path, { force: true });
    } catch (error) {
      // cleanup is best effort: a stuck leftover must not stop the server
      if (!isMissing(error)) log(`cannot clean ${file}: ${code(error)}`);
    }
  }
};
