// pnpm test:endpoint: the server runs as a separate process, and
// rewindbug-mcp's own store reads what it wrote
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
// well under the server's GitHub timeout
const QUICK_MS = 1000;
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

// stands in for the GitHub API: records what the endpoint posts and answers
// with the next status in line, the last one repeating; "hang" never answers
const fakeGithub = async (statuses = [201]) => {
  const calls = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const status = statuses[Math.min(calls.length, statuses.length - 1)];
      calls.push({
        path: request.url,
        auth: request.headers.authorization,
        body: JSON.parse(body),
      });
      if (status === "hang") return;
      response.writeHead(status, { "content-type": "application/json" }).end(
        JSON.stringify({
          number: 7,
          html_url: "https://github.com/acme/app/issues/7",
        }),
      );
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  fakes.push(server);
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
};
const fakes = [];

// GitHub is called after the SDK got its answer
const waitFor = async (check, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await wait(20);
  }
};

const viewOf = (url, token = "") =>
  new URL(token ? `/view/${token}` : "/view", url).href;

after(async () => {
  for (const server of fakes) {
    server.closeAllConnections();
    server.close();
  }
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
  assert.equal((await post(`${url}/list`, "{}")).status, 404);
  assert.equal((await post(viewOf(url), "{}")).status, 404);
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

test("the viewer page lists reports and serves them", async () => {
  const { url } = await start();
  const view = viewOf(url);
  const page = await fetch(view);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  assert.match(await page.text(), /<title>rewindbug reports<\/title>/);
  assert.deepEqual(await (await fetch(`${view}/list`)).json(), []);

  assert.equal((await post(url, JSON.stringify(fixture))).status, 204);
  await wait(2);
  const later = { ...fixture, id: "1c8d5d2f-7b62-4d9f-8b4f-3a2e7c1d0f22" };
  later.context = { ...fixture.context, userAgent: "HeadlessChrome" };
  assert.equal((await post(url, JSON.stringify(later))).status, 204);

  const listed = await (await fetch(`${view}/list`)).json();
  assert.deepEqual(
    listed.map((item) => [item.id, item.automated]),
    [
      [later.id, true],
      [fixture.id, false],
    ],
  );
  assert.equal(listed[0].message, "boom");
  assert.match(listed[0].name, /^\d{8}T\d{9}Z-/);

  const report = await fetch(`${view}/${listed[1].name}.json`);
  assert.equal(report.status, 200);
  assert.equal(report.headers.get("access-control-allow-origin"), null);
  assert.equal((await report.json()).id, fixture.id);
  assert.equal((await fetch(`${view}/evil.json`)).status, 404);
  assert.equal((await fetch(`${view}/${listed[1].name}.txt`)).status, 404);
});

test("the write token does not open the viewer", async () => {
  const token = "write-token";
  const { url } = await start({ REWINDBUG_TOKEN: token });
  const write = new URL(`/report/${token}`, url).href;
  assert.equal((await fetch(write)).status, 405);
  assert.equal((await fetch(`${write}/list`)).status, 404);
  // on loopback the viewer needs no token of its own
  assert.equal((await fetch(viewOf(url))).status, 200);
});

test("beyond loopback the viewer needs a view token", async () => {
  const off = await start({ HOST: "0.0.0.0", REWINDBUG_TOKEN: "write-token" });
  const local = (url, path) =>
    new URL(path, url.replace("0.0.0.0", "127.0.0.1")).href;
  assert.equal((await fetch(local(off.url, "/view"))).status, 404);
  assert.equal((await fetch(local(off.url, "/view/list"))).status, 404);

  const open = await start({ HOST: "0.0.0.0", REWINDBUG_OPEN: "1" });
  assert.equal((await fetch(local(open.url, "/view"))).status, 404);

  const on = await start({
    HOST: "0.0.0.0",
    REWINDBUG_TOKEN: "write-token",
    REWINDBUG_VIEW_TOKEN: "view-token",
  });
  assert.equal((await fetch(local(on.url, "/view"))).status, 404);
  assert.equal((await fetch(local(on.url, "/view/write-token"))).status, 404);
  assert.equal((await fetch(local(on.url, "/view/view-token"))).status, 200);
  assert.equal(
    (await fetch(local(on.url, "/view/view-token/list"))).status,
    200,
  );
});

test("a view token equal to the write token is refused at start", async () => {
  await assert.rejects(
    start({
      REWINDBUG_TOKEN: "same-token",
      REWINDBUG_VIEW_TOKEN: "same-token",
    }),
    /server exited: 1/,
  );
  await assert.rejects(
    start({ REWINDBUG_VIEW_TOKEN: "ab c" }),
    /server exited: 1/,
  );
});

test("with a token the plain path is closed", async () => {
  const token = "test-token";
  const { url } = await start({ REWINDBUG_TOKEN: token });
  const open = new URL("/report", url);
  assert.equal((await post(open, JSON.stringify(fixture))).status, 404);
  const closed = new URL(`/report/${token}`, url);
  assert.equal((await post(closed, JSON.stringify(fixture))).status, 204);
});

test("a new bug opens a github issue and a repeat comments on it", async () => {
  const hub = await fakeGithub();
  const { dir, url } = await start({
    REWINDBUG_GITHUB_REPO: "acme/app",
    REWINDBUG_GITHUB_TOKEN: "ghp_test",
    REWINDBUG_GITHUB_API: hub.url,
    REWINDBUG_PUBLIC_URL: "https://bugs.example/view/secret",
  });
  const body = JSON.stringify(fixture);
  assert.equal((await post(url, body)).status, 204);
  await waitFor(() => hub.calls.length === 1);
  await waitFor(() => existsSync(join(dir, "issues.json")));
  const [opened] = hub.calls;
  assert.equal(opened.path, "/repos/acme/app/issues");
  assert.equal(opened.auth, "Bearer ghp_test");
  assert.equal(opened.body.title, "boom");
  assert.deepEqual(opened.body.labels, ["bug"]);
  assert.match(
    opened.body.body,
    /^\*\*Page:\*\* https:\/\/app\.example\/cart\n/,
  );
  assert.match(
    opened.body.body,
    /\*\*Recording:\*\* https:\/\/bugs\.example\/view\/secret#\d{8}T\d{9}Z-0b7c4c1e/,
  );
  assert.match(opened.body.body, /## Steps\nError: boom\n/);
  assert.match(
    opened.body.body,
    /<details><summary>Playwright test<\/summary>/,
  );
  assert.match(opened.body.body, /<!-- rewindbug fingerprint: f00dbabe -->$/);

  // the SDK sends the same report again: nothing new on GitHub
  assert.equal((await post(url, body)).status, 204);
  const again = { ...fixture, id: "1c8d5d2f-7b62-4d9f-8b4f-3a2e7c1d0f22" };
  assert.equal((await post(url, JSON.stringify(again))).status, 204);
  await waitFor(() => hub.calls.length === 2);
  assert.equal(hub.calls[1].path, "/repos/acme/app/issues/7/comments");
  assert.match(hub.calls[1].body.body, /^Seen again at 2025-10-09T/);

  await waitFor(() =>
    readFileSync(join(dir, "issues.json"), "utf8").includes(again.id),
  );
  const listed = await (await fetch(`${viewOf(url)}/list`)).json();
  assert.equal(listed[0].issue, "https://github.com/acme/app/issues/7");
  const map = JSON.parse(await readFile(join(dir, "issues.json"), "utf8"));
  assert.equal(map.f00dbabe.number, 7);
  assert.deepEqual(map.f00dbabe.ids, [fixture.id, again.id]);
  assert.equal(hub.calls.length, 2);
});

const withGithub = (hub) => ({
  REWINDBUG_GITHUB_REPO: "acme/app",
  REWINDBUG_GITHUB_TOKEN: "ghp_test",
  REWINDBUG_GITHUB_API: hub.url,
});

test("a github failure keeps the report, and a resend opens the issue", async () => {
  const hub = await fakeGithub([500, 201]);
  const { dir, url } = await start(withGithub(hub));
  const body = JSON.stringify(fixture);
  assert.equal((await post(url, body)).status, 204);
  await waitFor(() => hub.calls.length === 1);
  assert.equal((await readdir(join(dir, "reports"))).length, 2);
  assert.equal(existsSync(join(dir, "issues.json")), false);
  // the SDK retries the same report: GitHub never took it, so it goes now
  assert.equal((await post(url, body)).status, 204);
  await waitFor(() => hub.calls.length === 2);
  assert.equal(hub.calls[1].path, "/repos/acme/app/issues");
});

test("a hanging github does not hold the sdk's answer", async () => {
  const hub = await fakeGithub(["hang"]);
  const { url } = await start(withGithub(hub));
  const began = Date.now();
  assert.equal((await post(url, JSON.stringify(fixture))).status, 204);
  const later = { ...fixture, id: "1c8d5d2f-7b62-4d9f-8b4f-3a2e7c1d0f22" };
  assert.equal((await post(url, JSON.stringify(later))).status, 204);
  assert.ok(Date.now() - began < QUICK_MS);
  await waitFor(() => hub.calls.length === 1);
});

test("a broken issues.json is left alone and opens nothing", async () => {
  const hub = await fakeGithub();
  const { dir, url } = await start(withGithub(hub));
  const broken = '{ "f00dbabe": { "number": 7, },}';
  await writeFile(join(dir, "issues.json"), broken);
  assert.equal((await post(url, JSON.stringify(fixture))).status, 204);
  await wait(QUICK_MS);
  assert.equal(hub.calls.length, 0);
  assert.equal(await readFile(join(dir, "issues.json"), "utf8"), broken);
});

test("backticks in the test cannot close the issue's code block", async () => {
  const hub = await fakeGithub();
  const { url } = await start(withGithub(hub));
  const tricky = { ...fixture, test: "```\n</details>\n# not a heading" };
  assert.equal((await post(url, JSON.stringify(tricky))).status, 204);
  await waitFor(() => hub.calls.length === 1);
  assert.match(
    hub.calls[0].body.body,
    /\n````ts\n```\n<\/details>\n# not a heading\n````\n/,
  );
});

test("github settings are checked at start", async () => {
  await assert.rejects(
    start({ REWINDBUG_GITHUB_REPO: "acme/app" }),
    /server exited: 1/,
  );
  await assert.rejects(
    start({ REWINDBUG_GITHUB_REPO: "acme", REWINDBUG_GITHUB_TOKEN: "x" }),
    /server exited: 1/,
  );
});
