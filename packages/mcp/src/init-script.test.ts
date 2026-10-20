import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, test } from "vitest";
import {
  findBuild,
  initScriptSource,
  parseInitScriptArgs,
  validHost,
  writeInitScript,
} from "./init-script.ts";

const root = await mkdtemp(join(tmpdir(), "rewindbug-init-script-"));
afterAll(() => rm(root, { recursive: true, force: true }));

// a project with the browser build in node_modules, one level above the cwd
const project = async (name: string): Promise<string> => {
  const dir = join(root, name);
  const dist = join(dir, "node_modules", "rewindbug", "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(
    join(dist, "rewindbug.global.js"),
    "var rewindbug = { init(o) { globalThis.started = o; } };",
  );
  await mkdir(join(dir, "qa"), { recursive: true });
  return dir;
};

// the script run against a fake page: what init received, or nothing
const runOn = (source: string, hostname: string, top = true) => {
  const window: Record<string, unknown> = {};
  window.top = top ? window : {};
  const sandbox: Record<string, unknown> = {
    window,
    location: { hostname },
  };
  runInNewContext(source, sandbox);
  return sandbox.started as
    | {
        endpoint: string;
        urlFilter?: (u: string, f: (u: string) => string) => string;
      }
    | undefined;
};

describe("arguments", () => {
  test("hosts are bare names; a URL, a login or a path is refused without echo", () => {
    expect(
      parseInitScriptArgs([
        "--host",
        "Stand.Example.dev",
        "--host",
        "localhost",
        "--mask-param",
        "x-vercel-protection-bypass",
        "--out",
        "a.js",
      ]),
    ).toEqual({
      hosts: ["stand.example.dev", "localhost"],
      maskParams: ["x-vercel-protection-bypass"],
      out: "a.js",
    });
    for (const bad of [
      "https://u:pw-secret@a.dev",
      "a.dev/path",
      "a.dev?t=1",
      "intranet",
    ])
      expect(() => parseInitScriptArgs(["--host", bad])).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining("pw-secret") as unknown,
        }),
      );
    expect(validHost("a.dev")).toBe(true);
    expect(() => parseInitScriptArgs([])).toThrow(/at least one --host/);
    expect(() => parseInitScriptArgs(["--host"])).toThrow(/needs a value/);
    expect(() => parseInitScriptArgs(["--mask-param", "a b"])).toThrow(
      /parameter name/,
    );
    expect(() => parseInitScriptArgs(["--host", "a.dev", "tok-123"])).toThrow(
      /\(a value\)/,
    );
  });
});

describe("the script", () => {
  test("starts on the named hosts in the top frame only, with the receiver endpoint", () => {
    const source = initScriptSource({
      build: "var rewindbug = { init(o) { globalThis.started = o; } };",
      hosts: ["stand.example.dev"],
      endpoint: "http://127.0.0.1:7400/abc",
      maskParams: [],
    });
    expect(runOn(source, "stand.example.dev")?.endpoint).toBe(
      "http://127.0.0.1:7400/abc",
    );
    expect(runOn(source, "tracker.example.com")).toBeUndefined();
    expect(runOn(source, "stand.example.dev", false)).toBeUndefined();
    expect(source).not.toContain("urlFilter");
  });

  test("mask params are masked over the default filter", () => {
    const source = initScriptSource({
      build: "var rewindbug = { init(o) { globalThis.started = o; } };",
      hosts: ["a.dev"],
      endpoint: "http://127.0.0.1:7400/abc",
      maskParams: ["x-vercel-protection-bypass"],
    });
    const filter = runOn(source, "a.dev")?.urlFilter;
    expect(
      filter?.("https://a.dev/?X-Vercel-Protection-Bypass=tok&p=2", (u) => u),
    ).toBe("https://a.dev/?X-Vercel-Protection-Bypass=*&p=2");
  });
});

describe("writing", () => {
  test("one token with the receiver, file 0600, the build found up from cwd", async () => {
    const dir = await project("write");
    const store = join(dir, "qa", ".rewindbug");
    const first = await writeInitScript(
      { hosts: ["a.dev", "a.dev", "b.dev"], maskParams: [] },
      { dir: store, port: 7411, cwd: join(dir, "qa") },
    );
    expect(first).toEqual({ path: join(store, "init-script.js"), hosts: 2 });
    const token = (await readFile(join(store, "token"), "utf8")).trim();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const text = await readFile(first.path, "utf8");
    expect(text).toContain(`http://127.0.0.1:7411/${token}`);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);
    await writeInitScript(
      { hosts: ["a.dev"], maskParams: [], out: join(dir, "other.js") },
      { dir: store, port: 7411, cwd: join(dir, "qa") },
    );
    expect((await readFile(join(store, "token"), "utf8")).trim()).toBe(token);
    expect(await readFile(join(dir, "other.js"), "utf8")).toContain(token);
  });

  test("no build installed: a clear error", async () => {
    const empty = join(root, "empty");
    await mkdir(empty, { recursive: true });
    expect(() => findBuild(empty)).toThrow(/install rewindbug/);
  });
});
