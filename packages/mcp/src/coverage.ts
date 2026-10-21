import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { log } from "./log.ts";

// the page's "rewindbug started here" beacon, counted per host in one file
// next to reports/: counters, not reports, so there is no rotation; deleting
// the file starts the count again
export const MAX_STARTED_BYTES = 4 * 1024;
export const MAX_PATH_CHARS = 2048;
export const MAX_SDK_CHARS = 32;
export const MAX_HOSTS = 50;
export const FLUSH_MS = 1000;
const FILE_MODE = 0o600;
// a host name as init-script takes it: no login, port, path or query
export const HOSTNAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export const Started = z.object({
  host: z.string().max(253).regex(HOSTNAME),
  // a URL pathname is printable ASCII: nothing else can come from a page
  path: z
    .string()
    .max(MAX_PATH_CHARS)
    .regex(/^\/[\x21-\x7e]*$/),
  sdk: z
    .string()
    .max(MAX_SDK_CHARS)
    .regex(/^[\w.+-]+$/)
    .optional(),
});
export type Started = z.infer<typeof Started>;

export const HostCoverage = z.object({
  pages: z.number(),
  lastAt: z.number(),
  lastPath: z.string(),
  sdk: z.string().optional(),
});
export type HostCoverage = z.infer<typeof HostCoverage>;

export const CoverageFile = z.object({
  since: z.number(),
  hosts: z.record(z.string(), HostCoverage),
});
export type CoverageFile = z.infer<typeof CoverageFile>;

export const coveragePath = (root: string): string =>
  join(resolve(root), "coverage.json");

export const parseStarted = (text: string): Started | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = Started.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

// a missing or broken file reads as no coverage yet
export const readCoverage = async (
  root: string,
): Promise<CoverageFile | undefined> => {
  try {
    const parsed = CoverageFile.safeParse(
      JSON.parse(await readFile(coveragePath(root), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export type Coverage = {
  add(signal: Started, at?: number): void;
  // writes what is pending now; close() also stops the timer
  flush(): Promise<void>;
  close(): Promise<void>;
};

export const createCoverage = (root: string): Coverage => {
  const path = coveragePath(root);
  let pending = new Map<string, HostCoverage & { firstAt: number }>();
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  let warned = false;

  // the file is read again on every write: a deleted file restarts the
  // count, and nothing is held in memory but the last second of signals
  const write = async (): Promise<void> => {
    if (!pending.size) return;
    const batch = pending;
    pending = new Map();
    // a new file counts from its first signal, not from the write
    const first = Math.min(...[...batch.values()].map((item) => item.firstAt));
    const file = (await readCoverage(root)) ?? { since: first, hosts: {} };
    for (const [host, delta] of batch) {
      const known = file.hosts[host];
      if (!known && Object.keys(file.hosts).length >= MAX_HOSTS) {
        if (!warned) log(`coverage keeps ${MAX_HOSTS} hosts, more are dropped`);
        warned = true;
        continue;
      }
      file.hosts[host] = {
        pages: (known?.pages ?? 0) + delta.pages,
        lastAt: Math.max(known?.lastAt ?? 0, delta.lastAt),
        lastPath: delta.lastPath,
        ...((delta.sdk ?? known?.sdk) && { sdk: delta.sdk ?? known?.sdk }),
      };
    }
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(file, null, 2), { mode: FILE_MODE });
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true });
      log(`cannot write ${path}: ${(error as Error).message}`);
    }
  };

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    chain = chain.then(write, write);
    return chain;
  };

  return {
    add(signal, at = Date.now()) {
      const known = pending.get(signal.host);
      pending.set(signal.host, {
        firstAt: known?.firstAt ?? at,
        pages: (known?.pages ?? 0) + 1,
        lastAt: at,
        lastPath: signal.path,
        ...((signal.sdk ?? known?.sdk) && { sdk: signal.sdk ?? known?.sdk }),
      });
      timer ??= setTimeout(() => void flush(), FLUSH_MS);
    },
    flush,
    close: flush,
  };
};
