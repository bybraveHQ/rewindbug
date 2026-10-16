import {
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fixture } from "./fixture.ts";
import {
  cleanOrphans,
  ensureDirs,
  lastReadable,
  listSummaries,
  MAX_CLOCK_SKEW_MS,
  MAX_REPORTS,
  readReport,
  reportsDir,
  saveReport,
  stamp,
  validateReport,
  type ReadReport,
} from "./store.ts";

const NOW = fixture.createdAt + 1000;
let root: string;

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const report = (n: number, extra: Partial<ReadReport> = {}): ReadReport => {
  const value = validateReport(
    { ...fixture, id: uuid(n), createdAt: fixture.createdAt + n, ...extra },
    NOW + n,
  );
  if (typeof value === "string") throw new Error(value);
  return value;
};

const save = (value: ReadReport, receivedAt: number) =>
  saveReport(root, value, JSON.stringify(value), receivedAt);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rewindbug-store-"));
  await ensureDirs(root);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("validateReport", () => {
  test("accepts a report and unknown fields of a newer SDK", () => {
    const value = validateReport(
      { ...fixture, trigger: { ...fixture.trigger, kind: "future" }, extra: 1 },
      NOW,
    );
    expect(typeof value).toBe("object");
  });

  test.each([
    ["schemaVersion", { schemaVersion: 1 }],
    ["sdk", { sdk: { name: "other" } }],
    ["id", { id: "0B7C4C1E-6A51-4C8E-9A3E-2F1D6B0C9E11" }],
    ["createdAt", { createdAt: 1.5 }],
    ["createdAt", { createdAt: -1 }],
    ["createdAt", { createdAt: NOW + MAX_CLOCK_SKEW_MS + 1 }],
    ["steps", { steps: "no" }],
  ])("rejects a bad %s", (_, patch) => {
    expect(validateReport({ ...fixture, ...patch }, NOW)).toMatch(/^invalid/);
  });
});

describe("saveReport and listSummaries", () => {
  test("writes a pair and lists newest createdAt first", async () => {
    await save(report(1), NOW + 50);
    await save(report(2), NOW + 10);
    const files = await readdir(reportsDir(root));
    expect(files.filter((f) => f.endsWith(".summary.json"))).toHaveLength(2);
    expect(files.filter((f) => !f.endsWith(".summary.json"))).toHaveLength(2);

    const list = await listSummaries(root);
    expect(list.map((s) => s.id)).toEqual([uuid(2), uuid(1)]);
    expect(list[0]).toMatchObject({
      receivedAt: NOW + 10,
      kind: "error",
      message: "boom",
      stepsCount: 0,
      path: join(reportsDir(root), `${stamp(NOW + 10)}-${uuid(2)}.json`),
    });
    expect((await stat(list[0]?.path ?? "")).mode & 0o777).toBe(0o600);
  });

  test("replaces a report with the same id", async () => {
    await save(report(1), NOW);
    await save(report(1), NOW + 5);
    const files = await readdir(reportsDir(root));
    expect(files).toHaveLength(2);
    expect((await listSummaries(root))[0]?.receivedAt).toBe(NOW + 5);
  });

  test("deduplicates an id written twice by two processes", async () => {
    const value = report(1);
    await save(value, NOW);
    const dir = reportsDir(root);
    const base = `${stamp(NOW + 9)}-${value.id}`;
    await writeFile(join(dir, `${base}.json`), JSON.stringify(value));
    await writeFile(
      join(dir, `${base}.summary.json`),
      JSON.stringify({ ...(await listSummaries(root))[0], receivedAt: 0 }),
    );
    const list = await listSummaries(root);
    expect(list).toHaveLength(1);
    expect(list[0]?.receivedAt).toBe(NOW + 9);
  });

  test("keeps the last MAX_REPORTS by arrival", async () => {
    for (let n = 0; n < MAX_REPORTS + 2; n++) await save(report(n), NOW + n);
    const list = await listSummaries(root);
    expect(list).toHaveLength(MAX_REPORTS);
    expect(list.map((s) => s.id)).not.toContain(uuid(0));
    expect(list.map((s) => s.id)).not.toContain(uuid(1));
    expect(await readdir(reportsDir(root))).toHaveLength(MAX_REPORTS * 2);
  });

  test("lists only complete pairs and skips temp files", async () => {
    await save(report(1), NOW);
    const dir = reportsDir(root);
    await writeFile(join(dir, `${stamp(NOW)}-${uuid(2)}.summary.json`), "{}");
    await writeFile(join(dir, `${stamp(NOW)}-${uuid(3)}.json.1.ab.tmp`), "x");
    await writeFile(join(dir, "notes.json"), "{}");
    expect((await listSummaries(root)).map((s) => s.id)).toEqual([uuid(1)]);
  });

  test("respects the limit", async () => {
    for (let n = 1; n <= 3; n++) await save(report(n), NOW + n);
    expect(await listSummaries(root, 2)).toHaveLength(2);
  });
});

describe("readReport and lastReadable", () => {
  test("reads by id and reports a missing one", async () => {
    await save(report(1), NOW);
    const found = await readReport(root, uuid(1));
    expect(found.status).toBe("ok");
    expect(await readReport(root, uuid(9))).toEqual({ status: "missing" });
  });

  test("returns the newest readable report", async () => {
    await save(report(1), NOW);
    const newer = await save(report(2), NOW + 1);
    await writeFile(newer.path, "{ broken");
    expect((await lastReadable(root))?.summary.id).toBe(uuid(1));
    expect((await readReport(root, uuid(2))).status).toBe("invalid");
  });

  test("an empty folder has no last report", async () => {
    expect(await lastReadable(root)).toBeUndefined();
    await rm(reportsDir(root), { recursive: true });
    expect(await listSummaries(root)).toEqual([]);
  });
});

describe("cleanOrphans", () => {
  test("removes old halves and temp files, keeps fresh ones", async () => {
    await save(report(1), NOW);
    const dir = reportsDir(root);
    const old = (Date.now() - 2 * 60 * 60_000) / 1000;
    const orphan = join(dir, `${stamp(NOW)}-${uuid(2)}.json`);
    const tmp = join(dir, `${stamp(NOW)}-${uuid(3)}.json.1.ab.tmp`);
    const fresh = join(dir, `${stamp(NOW)}-${uuid(4)}.summary.json`);
    for (const file of [orphan, tmp, fresh]) await writeFile(file, "{}");
    await utimes(orphan, old, old);
    await utimes(tmp, old, old);

    await cleanOrphans(root);
    const files = await readdir(dir);
    expect(files).toHaveLength(3);
    expect(files).toContain(`${stamp(NOW)}-${uuid(4)}.summary.json`);
  });
});

describe("names over content", () => {
  test("a moved folder still reads, a summary cannot redirect the read", async () => {
    await save(report(1), NOW);
    const [summary] = await listSummaries(root);
    // a summary that claims another id and another file
    await writeFile(
      join(reportsDir(root), `${stamp(NOW)}-${uuid(1)}.summary.json`),
      JSON.stringify({ ...summary, id: uuid(7), path: "/etc/hosts" }),
    );
    const moved = `${root}-moved`;
    await rename(root, moved);
    try {
      const [listed] = await listSummaries(moved);
      expect(listed?.id).toBe(uuid(1));
      expect(listed?.path).toBe(
        join(reportsDir(moved), `${stamp(NOW)}-${uuid(1)}.json`),
      );
      expect((await readReport(moved, uuid(1))).status).toBe("ok");
      expect((await readReport(moved, uuid(7))).status).toBe("missing");
      expect((await lastReadable(moved))?.report.id).toBe(uuid(1));
    } finally {
      await rename(moved, root);
    }
  });

  test("a folder deleted while running is created again", async () => {
    await rm(reportsDir(root), { recursive: true });
    await save(report(1), NOW);
    expect(await listSummaries(root)).toHaveLength(1);
  });
});
