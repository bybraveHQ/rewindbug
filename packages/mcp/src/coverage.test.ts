import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  coveragePath,
  createCoverage,
  FLUSH_MS,
  MAX_HOSTS,
  parseStarted,
  readCoverage,
} from "./coverage.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rewindbug-coverage-"));
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const signal = { host: "stand.example.dev", path: "/", sdk: "0.6.0" };

describe("coverage", () => {
  test("parseStarted takes the page's shape only", () => {
    expect(parseStarted(JSON.stringify(signal))).toEqual(signal);
    expect(parseStarted(JSON.stringify({ host: "a.dev", path: "/" }))).toEqual({
      host: "a.dev",
      path: "/",
    });
    expect(parseStarted(JSON.stringify({ ...signal, extra: 1 }))).toEqual(
      signal,
    );
    expect(parseStarted(JSON.stringify({ ...signal, host: "A.dev" }))).toBe(
      undefined,
    );
    expect(parseStarted("[]")).toBeUndefined();
  });

  test("writes once a second, adding to what the file holds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const coverage = createCoverage(root);
    coverage.add(signal, 1000);
    coverage.add({ ...signal, path: "/b" }, 2000);
    expect(await readCoverage(root)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    await coverage.flush();
    expect((await readCoverage(root))?.since).toBe(1000);
    expect((await readCoverage(root))?.hosts["stand.example.dev"]).toEqual({
      pages: 2,
      lastAt: 2000,
      lastPath: "/b",
      sdk: "0.6.0",
    });
    coverage.add(signal, 3000);
    await coverage.close();
    expect((await readCoverage(root))?.hosts["stand.example.dev"]?.pages).toBe(
      3,
    );
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  test("a deleted or broken file starts the count again", async () => {
    const coverage = createCoverage(root);
    coverage.add(signal);
    await coverage.flush();
    await writeFile(coveragePath(root), "{broken");
    coverage.add(signal);
    await coverage.close();
    expect((await readCoverage(root))?.hosts["stand.example.dev"]?.pages).toBe(
      1,
    );
  });

  test(`keeps at most ${MAX_HOSTS} hosts`, async () => {
    const coverage = createCoverage(root);
    for (let i = 0; i <= MAX_HOSTS; i++)
      coverage.add({ host: `h${i}.example.dev`, path: "/" });
    await coverage.close();
    const hosts = Object.keys((await readCoverage(root))?.hosts ?? {});
    expect(hosts).toHaveLength(MAX_HOSTS);
  });
});
