// pnpm test:endpoint: the server runs as a separate process, and
// rewindbug-mcp's own store reads what it wrote
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { fixture } from "../../packages/mcp/src/fixture.ts";
import { listSummaries, readReport } from "../../packages/mcp/src/store.ts";

const SERVER = fileURLToPath(new URL("server.mjs", import.meta.url));
const OVERSIZE_BYTES = 3 * 1024 * 1024;
// a little over the server's BODY_IDLE_MS
const BODY_WAIT_MS = 6000;
const started = [];

const start = async (env = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "rewindbug-endpoint-"));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: "0", REWINDBUG_DIR: dir, ...env },
    stdio: ["ignore", "pipe", "ignore"],
  });
  started.push({ child, dir });
  const url = await new Promise((done, fail) => {
    child.stdout.on("data", (data) => {
      const match = /listening on (\S+)/.exec(String(data));
      if (match) done(match[1]);
    });
    child.on("exit", (code) => fail(new Error(`server exited: ${code}`)));
  });
  return { dir, url };
};

after(async () => {
  for (const { child, dir } of started) {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

const post = (url, body) => fetch(url, { method: "POST", body });

test("a gzip report lands as a pair that rewindbug-mcp reads", async () => {
  const { dir, url } = await start();
  const response = await post(url, gzipSync(JSON.stringify(fixture)));
  assert.equal(response.status, 204);
  const files = await readdir(join(dir, "reports"));
  assert.equal(files.length, 2);
  const [summary] = await listSummaries(dir);
  assert.equal(summary?.id, fixture.id);
  const read = await readReport(dir, fixture.id);
  assert.equal(read.status, "ok");
});

test("the same report sent again replaces the older copy", async () => {
  const { dir, url } = await start();
  const body = gzipSync(JSON.stringify(fixture));
  assert.equal((await post(url, body)).status, 204);
  assert.equal((await post(url, body)).status, 204);
  assert.equal((await readdir(join(dir, "reports"))).length, 2);
});

test("bad bodies are refused", async () => {
  const { url } = await start();
  assert.equal((await post(url, "not json")).status, 400);
  assert.equal((await post(url, Buffer.from([0x1f, 0x8b, 1, 2]))).status, 400);
  // JSON drops a field set to undefined
  const noVersion = { ...fixture, schemaVersion: undefined };
  assert.equal((await post(url, JSON.stringify(noVersion))).status, 400);
  assert.equal((await post(url, Buffer.alloc(OVERSIZE_BYTES))).status, 413);
});

test("only the report path takes posts", async () => {
  const { url } = await start();
  assert.equal((await post(new URL("/other", url), "{}")).status, 404);
  assert.equal((await fetch(url)).status, 405);
  const preflight = await fetch(url, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
});

test("beyond loopback it needs a token or an explicit opt-out", async () => {
  await assert.rejects(start({ HOST: "0.0.0.0" }), /server exited: 1/);
  const { url } = await start({ HOST: "0.0.0.0", REWINDBUG_OPEN: "1" });
  assert.match(url, /^http:\/\/0\.0\.0\.0:\d+\/report$/);
});

test("more requests at once than it holds are refused with 503", async () => {
  const { url } = await start();
  const target = new URL(url);
  // bodies that never finish keep four requests open
  const { request } = await import("node:http");
  const held = [];
  for (let i = 0; i < 4; i++) {
    const req = request(target, { method: "POST" });
    req.on("error", () => undefined);
    req.write("{");
    held.push(req);
  }
  const deadline = Date.now() + 2000;
  let status = 0;
  while (Date.now() < deadline && status !== 503) {
    status = (await post(url, JSON.stringify(fixture))).status;
  }
  for (const req of held) req.destroy();
  assert.equal(status, 503);
});

test("a token that needs url encoding is refused at start", async () => {
  await assert.rejects(
    start({ REWINDBUG_TOKEN: "ab c#d" }),
    /server exited: 1/,
  );
});

test("a body that stops arriving gives its slot back", async () => {
  const { url } = await start();
  const target = new URL(url);
  const { request } = await import("node:http");
  const held = [];
  for (let i = 0; i < 4; i++) {
    const req = request(target, { method: "POST" });
    req.on("error", () => undefined);
    req.write("{");
    held.push(req);
  }
  await wait(BODY_WAIT_MS);
  const status = (await post(url, JSON.stringify(fixture))).status;
  for (const req of held) req.destroy();
  assert.equal(status, 204);
});

test("with a token the plain path is closed", async () => {
  const token = "test-token";
  const { url } = await start({ REWINDBUG_TOKEN: token });
  const open = new URL("/report", url);
  assert.equal((await post(open, JSON.stringify(fixture))).status, 404);
  const closed = new URL(`/report/${token}`, url);
  assert.equal((await post(closed, JSON.stringify(fixture))).status, 204);
});
