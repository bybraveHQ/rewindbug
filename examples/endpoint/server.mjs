// rewindbug endpoint example: one file, Node 22, no dependencies.
// Receives the gzip-JSON reports the rewindbug SDK posts and stores them in
// the folder layout rewindbug-mcp reads, so a coding agent can pick them up.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL, URLSearchParams } from "node:url";
import { createGunzip } from "node:zlib";

const DEFAULT_PORT = 7358;
const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const HOST = process.env.HOST || "127.0.0.1";
const DIR = resolve(process.env.REWINDBUG_DIR || ".rewindbug");
const TOKEN = process.env.REWINDBUG_TOKEN || "";
const ORIGIN = process.env.REWINDBUG_ORIGIN || "*";
const OPEN = process.env.REWINDBUG_OPEN === "1";
// reading is its own secret: the write token sits in the app's bundle,
// where every visitor can see it
const VIEW_TOKEN_ENV = process.env.REWINDBUG_VIEW_TOKEN || "";
// set the first two and every new bug becomes a GitHub issue
const GITHUB_REPO = process.env.REWINDBUG_GITHUB_REPO || "";
const GITHUB_TOKEN = process.env.REWINDBUG_GITHUB_TOKEN || "";
const GITHUB_LABELS = (process.env.REWINDBUG_GITHUB_LABELS ?? "bug")
  .split(",")
  .map((label) => label.trim())
  .filter(Boolean);
const GITHUB_API = process.env.REWINDBUG_GITHUB_API || "https://api.github.com";
// the write token is public: anyone holding it can send reports with new
// fingerprints, so the issues and comments made for them are capped
const GITHUB_MAX_PER_HOUR_ENV =
  process.env.REWINDBUG_GITHUB_MAX_PER_HOUR ?? "20";
// the viewer as a browser reaches it, without the view token, for the
// recording link in an issue
const PUBLIC_URL = process.env.REWINDBUG_PUBLIC_URL || "";
// the screen at the moment of the error, rendered from the recording: the
// optional rewindbug-mcp/screenshot with playwright next to this file
const SCREENSHOT_MODULE =
  process.env.REWINDBUG_SCREENSHOT_MODULE || "rewindbug-mcp/screenshot";
// a stand on this machine (localhost) may draw its own styles. Off by
// default: behind a proxy the server listens on loopback while anyone with
// the public write token can name any page in a report
const SCREENSHOT_LOCAL_STAND =
  process.env.REWINDBUG_SCREENSHOT_LOCAL_STAND === "1";

const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_REPORTS = 100;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_SUMMARY_MESSAGE = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
// a body that stops arriving gives its slot back instead of holding it
const BODY_IDLE_MS = 5000;
// each request holds up to MAX_COMPRESSED_BYTES + MAX_BODY_BYTES in memory
const MAX_CONCURRENT = 4;
const GZIP_MAGIC = [0x1f, 0x8b];
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME = /^\d{8}T\d{9}Z-[0-9a-f-]{36}$/;
// the token is compared with the raw request path, so it must need no encoding
const TOKEN_CHARS = /^[A-Za-z0-9._~-]+$/;

const REPORTS = join(DIR, "reports");
const PATH = TOKEN ? `/report/${TOKEN}` : "/report";
const VIEW_PATH = "/view";
const VIEW_TOKEN_FILE = join(DIR, "view-token");
const VIEW_TOKEN_BYTES = 32;
// an issue waits this long for its picture, then goes without it
const ISSUE_SCREENSHOT_WAIT_MS = 10_000;
const SCREENSHOT_KEY_CHARS = 32;
// a page on another site must not write to a server on this machine; with
// no REWINDBUG_ORIGIN only pages served from loopback may post to loopback
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const CORS = {
  "access-control-allow-origin": ORIGIN,
  "access-control-allow-methods": "POST",
  "access-control-allow-headers": "content-type",
};

class HttpError extends Error {
  constructor(status) {
    super(String(status));
    this.status = status;
  }
}

const log = (text) => process.stderr.write(`rewindbug-endpoint: ${text}\n`);
const digest = (value) => createHash("sha256").update(value).digest();
const expected = digest(PATH);
// set at start: REWINDBUG_VIEW_TOKEN, else one kept in the folder on
// loopback; empty beyond loopback without the variable, reading is then off
let viewToken = "";
// set at start when the renderer module is there
let renderer = null;
const VIEWER = new URL("viewer.html", import.meta.url);

// 2026-10-16T12:00:00.123Z -> 20261016T120000123Z
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:.]/g, "");

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// the fields rewindbug-mcp reads; everything else passes, so a newer SDK
// revision is not refused
const invalid = (report, receivedAt) => {
  if (!isObject(report)) return "root";
  const { trigger, context, sdk, replay } = report;
  const checks = [
    ["schemaVersion", report.schemaVersion === 0],
    ["id", typeof report.id === "string" && UUID.test(report.id)],
    [
      "createdAt",
      Number.isSafeInteger(report.createdAt) &&
        report.createdAt > 0 &&
        report.createdAt <= receivedAt + MAX_CLOCK_SKEW_MS,
    ],
    ["fingerprint", typeof report.fingerprint === "string"],
    ["sdk", isObject(sdk) && sdk.name === "rewindbug"],
    [
      "trigger",
      isObject(trigger) &&
        typeof trigger.kind === "string" &&
        typeof trigger.message === "string",
    ],
    ["context", isObject(context) && typeof context.url === "string"],
    ["steps", Array.isArray(report.steps)],
    ["stepsMarkdown", typeof report.stepsMarkdown === "string"],
    ["test", typeof report.test === "string"],
    ["console", Array.isArray(report.console)],
    ["network", Array.isArray(report.network)],
    ["limits", isObject(report.limits)],
    [
      "replay",
      replay === null || (isObject(replay) && Array.isArray(replay.events)),
    ],
  ];
  return checks.find(([, ok]) => !ok)?.[0];
};

const summaryOf = (report, path, receivedAt) => ({
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

const removeFile = (path) => rm(path, { force: true });

const writeTemp = async (target, text) => {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  return tmp;
};

// summary first, then the report: a reader skips a summary without its pair
const save = async (report, text, receivedAt) => {
  // the folder may be deleted while the server runs
  await mkdir(REPORTS, { recursive: true, mode: 0o700 });
  // the first copy of a report stays: the SDK resends the same one, and the
  // write token is public, so a later body under a known id must not replace
  // what is stored and linked from an issue
  const stored = (await readdir(REPORTS))
    .map((file) => file.replace(/\.json$/, ""))
    .find((name) => NAME.test(name) && name.endsWith(`-${report.id}`));
  if (stored) return stored;
  const base = `${stamp(receivedAt)}-${report.id}`;
  const reportPath = join(REPORTS, `${base}.json`);
  const summaryPath = join(REPORTS, `${base}.summary.json`);
  const temps = [];
  try {
    temps.push(
      await writeTemp(
        summaryPath,
        JSON.stringify(summaryOf(report, reportPath, receivedAt)),
      ),
    );
    temps.push(await writeTemp(reportPath, text));
    await rename(temps[0], summaryPath);
    await rename(temps[1], reportPath);
  } catch (error) {
    for (const tmp of temps) await removeFile(tmp).catch(() => undefined);
    throw error;
  }
  const bases = [
    ...new Set(
      (await readdir(REPORTS))
        .map((file) => file.replace(/\.summary\.json$|\.json$/, ""))
        .filter((name) => NAME.test(name)),
    ),
  ].sort();
  const excess = bases.slice(0, Math.max(0, bases.length - MAX_REPORTS));
  for (const name of excess) {
    await removeFile(join(REPORTS, `${name}.summary.json`));
    await removeFile(join(REPORTS, `${name}.json`));
    await removeFile(join(REPORTS, `${name}.png`));
  }
  return base;
};

// GitHub has a queue of its own: the SDK gets its answer once the report is
// on disk, and one at a time keeps one issue per fingerprint
let githubQueue = Promise.resolve();
let githubPending = 0;
const toGithub = (report, base) => {
  githubPending += 1;
  githubQueue = githubQueue
    .then(() => notifyGithub(report, base))
    .catch((error) => log(`github: ${error.message}`))
    .finally(() => {
      githubPending -= 1;
    });
};

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

let queue = Promise.resolve();
const saveInOrder = (report, text, receivedAt) => {
  const done = queue.then(async () => {
    const base = await save(report, text, receivedAt);
    // in the background: the SDK gets its answer before the picture
    if (renderer && !(await exists(join(REPORTS, `${base}.png`))))
      renderer.enqueue(join(REPORTS, `${base}.json`));
    if (GITHUB_REPO) toGithub(report, base);
  });
  queue = done.catch(() => undefined);
  return done;
};

const inflate = (raw) =>
  new Promise((done, fail) => {
    const gunzip = createGunzip();
    const parts = [];
    let size = 0;
    gunzip.on("data", (part) => {
      size += part.length;
      if (size > MAX_BODY_BYTES) {
        gunzip.destroy();
        fail(new HttpError(413));
        return;
      }
      parts.push(part);
    });
    gunzip.on("error", () => fail(new HttpError(400)));
    gunzip.on("end", () => done(Buffer.concat(parts)));
    gunzip.end(raw);
  });

// an oversized body is still read to the end: closing the socket mid-upload
// makes the browser see a reset instead of 413
const readBody = (request) =>
  new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    let over = Number(request.headers["content-length"]) > MAX_COMPRESSED_BYTES;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_COMPRESSED_BYTES) over = true;
      if (!over) chunks.push(chunk);
    });
    request.on("error", () => fail(new HttpError(400)));
    // a destroyed request has no end; after a normal end this is a no-op
    request.on("close", () => fail(new HttpError(400)));
    request.on("end", () => {
      if (over) return fail(new HttpError(413));
      const raw = Buffer.concat(chunks);
      if (raw.length === 0) return fail(new HttpError(400));
      const gzip = raw[0] === GZIP_MAGIC[0] && raw[1] === GZIP_MAGIC[1];
      done(gzip ? inflate(raw) : raw);
    });
  });

const receive = async (request) => {
  const text = (await readBody(request)).toString("utf8");
  const receivedAt = Date.now();
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new HttpError(400);
  }
  const field = invalid(report, receivedAt);
  if (field) {
    log(`refused a report: invalid ${field}`);
    throw new HttpError(400);
  }
  try {
    await saveInOrder(report, text, receivedAt);
  } catch (error) {
    log(`cannot save a report: ${error.message}`);
    return 500;
  }
  // report text is quoted: a newline or an escape code cannot forge a log line
  log(`saved ${report.id}: ${JSON.stringify(report.trigger.kind)}`);
  return 204;
};

const respond = (response, status) => {
  if (!response.headersSent) response.writeHead(status, CORS).end();
};

// the viewer is same-origin: no CORS on what it reads, so a page from
// another site cannot read reports through the user's browser
const send = (response, status, type, body) => {
  response.writeHead(status, { "content-type": type }).end(body);
};

const AUTOMATED = /Headless|Playwright/;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const ISSUES = join(DIR, "issues.json");
const ISSUE_TITLE_MAX = 120;
const ISSUE_LINES_MAX = 20;
const ISSUE_LINE_MAX = 200;
// GitHub refuses bodies over 65536 characters
const ISSUE_BODY_MAX = 60_000;
// report fields are cut before they are escaped, never after: a fence or a
// code span can at most triple a field, so the head stays under the limit
const ISSUE_FIELD_MAX = 1000;
const ISSUE_BLOCK_MAX = 6000;
const ISSUE_IDS_MAX = 100;
const GITHUB_TIMEOUT_MS = 10_000;
const HOUR_MS = 60 * 60_000;
const GITHUB_MAX_PER_HOUR = Number(GITHUB_MAX_PER_HOUR_ENV);
// times of the GitHub writes in the last hour
let githubWrites = [];
let githubCapLogged = false;

const githubAllowed = (report) => {
  const now = Date.now();
  githubWrites = githubWrites.filter((at) => now - at < HOUR_MS);
  if (githubWrites.length < GITHUB_MAX_PER_HOUR) {
    githubCapLogged = false;
    githubWrites.push(now);
    return true;
  }
  if (!githubCapLogged) {
    log(
      `github limit: ${GITHUB_MAX_PER_HOUR} issues and comments in the last hour, reports stay on disk only (first: ${report.id})`,
    );
    githubCapLogged = true;
  }
  return false;
};
const HTTPS = /^https:\/\//;

// newest first; a summary without its report (being written) is skipped
const list = async () => {
  const names = (await readdir(REPORTS).catch(() => []))
    .filter((file) => file.endsWith(".summary.json"))
    .map((file) => file.slice(0, -".summary.json".length))
    .filter((name) => NAME.test(name))
    .sort()
    .reverse();
  const issues = await readIssues();
  const items = [];
  for (const name of names) {
    try {
      const summary = JSON.parse(
        await readFile(join(REPORTS, `${name}.summary.json`), "utf8"),
      );
      const { context } = JSON.parse(
        await readFile(join(REPORTS, `${name}.json`), "utf8"),
      );
      items.push({
        ...summary,
        name,
        automated: AUTOMATED.test(context?.userAgent ?? ""),
        issue: issues?.[summary.fingerprint]?.url,
        screenshot: await exists(join(REPORTS, `${name}.png`)),
      });
    } catch {
      // a pair being replaced or removed right now is not listed
    }
  }
  return items;
};

// one issue per fingerprint: the map lives outside reports/, which
// rewindbug-mcp lists
// null when the file is there but unreadable: it is then left alone, not
// overwritten with a fresh map that would open duplicate issues
const readIssues = async () => {
  let text;
  try {
    text = await readFile(ISSUES, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    log(`cannot read ${ISSUES}: ${error.message}`);
    return null;
  }
  try {
    const map = JSON.parse(text);
    if (isObject(map)) return map;
  } catch {
    // reported below
  }
  log(`${ISSUES} is not a JSON object: fix or delete it`);
  return null;
};

const writeIssues = async (map) => {
  const tmp = await writeTemp(ISSUES, JSON.stringify(map, null, 2));
  await rename(tmp, ISSUES);
};

const clip = (line) =>
  line.length > ISSUE_LINE_MAX ? `${line.slice(0, ISSUE_LINE_MAX)}…` : line;

const tail = (items) =>
  items.length === 0
    ? "none"
    : [
        ...(items.length > ISSUE_LINES_MAX
          ? [`… ${items.length - ISSUE_LINES_MAX} earlier lines`]
          : []),
        ...items.slice(-ISSUE_LINES_MAX).map(clip),
      ].join("\n");

const pathOf = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
};

// a picture in an issue is fetched by GitHub's image proxy, which sends no
// header: its link carries a key that opens this one picture and nothing else
const screenshotKey = (base) =>
  createHmac("sha256", viewToken)
    .update(base)
    .digest("hex")
    .slice(0, SCREENSHOT_KEY_CHARS);

const screenshotLine = (base, shown) =>
  shown && PUBLIC_URL && viewToken
    ? `![Screen at the moment of the error](${PUBLIC_URL.replace(/\/+$/, "")}/${base}.png?key=${screenshotKey(base)})`
    : "";

const recordingLink = (base) =>
  PUBLIC_URL
    ? `${PUBLIC_URL}#report=${base}`
    : `\`${base}.json\` in the endpoint folder`;

// report text is whatever anyone with the public write token sent: in an
// issue it stays plain text, never markdown, mentions or html
// eslint-disable-next-line no-control-regex -- these are what it removes
const CONTROL = /[\u0000-\u001f\u007f]/g;
const FINGERPRINT = /^[\w-]{1,64}$/;

const plain = (text) => String(text).replace(CONTROL, " ");

// inline code with a fence longer than any backtick run inside
const code = (text) => {
  const clean = plain(text);
  const longest = Math.max(
    0,
    ...(clean.match(/`+/g) ?? []).map((run) => run.length),
  );
  const ticks = "`".repeat(longest + 1);
  return `${ticks} ${clean} ${ticks}`;
};

const issueTitle = (report) => {
  const [line] = report.trigger.message.split("\n");
  const clean = plain(line).trim() || plain(report.trigger.kind);
  return clean.length > ISSUE_TITLE_MAX
    ? `${clean.slice(0, ISSUE_TITLE_MAX - 1)}…`
    : clean;
};

// one backtick longer than any run inside, so the text cannot close it
const fence = (text, lang = "") => {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text}\n${ticks}`;
};

const cut = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const issueBody = (report, base, screenshot = false) => {
  const { context, trigger } = report;
  const picture = screenshotLine(base, screenshot);
  const head = [
    `**Page:** ${code(cut(context.url, ISSUE_FIELD_MAX))}`,
    `**When:** ${new Date(report.createdAt).toISOString()}`,
    `**Browser:** ${code(cut(String(context.userAgent), ISSUE_FIELD_MAX))}`,
    `**Recording:** ${recordingLink(base)}`,
    ...(picture ? ["", picture] : []),
    "",
    "## Steps",
    fence(cut(report.stepsMarkdown || "none", ISSUE_BLOCK_MAX)),
    "",
    "## Error",
    fence(
      cut(String(trigger.error?.stack || trigger.message), ISSUE_BLOCK_MAX),
    ),
  ].join("\n");
  const logs = [
    "## Console",
    fence(
      tail(report.console.map((entry) => `${entry.level}: ${entry.message}`)),
    ),
    "",
    "## Network",
    fence(
      tail(
        report.network.map(
          (entry) =>
            `${entry.method} ${pathOf(entry.url)} ${entry.status ?? entry.error ?? "pending"}${entry.durationMs === undefined ? "" : ` (${entry.durationMs} ms)`}`,
        ),
      ),
    ),
  ].join("\n");
  const test = [
    "<details><summary>Playwright test</summary>",
    "",
    fence(report.test, "ts"),
    "",
    "</details>",
  ].join("\n");
  // a fingerprint that could close the comment is left out
  const foot = FINGERPRINT.test(report.fingerprint)
    ? `<!-- rewindbug fingerprint: ${report.fingerprint} -->`
    : "";
  // the limit is met by dropping the logs first, then the test; the head
  // alone always fits, so escaped text is never cut
  const bodies = [
    [head, logs, test],
    [head, test],
    [
      head,
      "_Console, network and the test were cut: the issue would be too long._",
    ],
  ].map((parts) => [...parts, "", foot].join("\n\n"));
  return bodies.find((body) => body.length <= ISSUE_BODY_MAX) ?? bodies.at(-1);
};

const repeatComment = (report, base, screenshot = false) =>
  [
    `Seen again at ${new Date(report.createdAt).toISOString()} on ${code(cut(report.context.url, ISSUE_FIELD_MAX))}, ${report.steps.length} steps.`,
    `**Recording:** ${recordingLink(base)}`,
    screenshotLine(base, screenshot),
  ]
    .filter(Boolean)
    .join("\n");

// the picture may still be rendering: an issue waits for it a little
const screenshotReady = async (base) => {
  const path = join(REPORTS, `${base}.json`);
  await renderer?.wait(path, ISSUE_SCREENSHOT_WAIT_MS);
  return exists(join(REPORTS, `${base}.png`));
};

const github = async (path, body) => {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "rewindbug-endpoint",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`github answered ${response.status}`);
  return response.json();
};

// a report id is remembered only once GitHub took it, so the SDK sending the
// same report again after a GitHub failure still gets its issue
const remember = (entry, id) => {
  const ids = Array.isArray(entry.ids) ? entry.ids : [];
  entry.ids = [...ids, id].slice(-ISSUE_IDS_MAX);
};

const notifyGithub = async (report, base) => {
  const issues = await readIssues();
  if (issues === null) return;
  const known = issues[report.fingerprint];
  if (isObject(known) && known.ids?.includes(report.id)) return;
  if (!githubAllowed(report)) return;
  const screenshot = await screenshotReady(base);
  if (isObject(known) && Number.isSafeInteger(known.number)) {
    await github(`/repos/${GITHUB_REPO}/issues/${known.number}/comments`, {
      body: repeatComment(report, base, screenshot),
    });
    remember(known, report.id);
    await writeIssues(issues);
    log(`commented on issue #${known.number} for ${report.id}`);
    return;
  }
  const issue = await github(`/repos/${GITHUB_REPO}/issues`, {
    title: issueTitle(report),
    body: issueBody(report, base, screenshot),
    labels: GITHUB_LABELS,
  });
  const entry = {
    number: issue.number,
    ...(HTTPS.test(issue.html_url ?? "") ? { url: issue.html_url } : {}),
    createdAt: Date.now(),
  };
  remember(entry, report.id);
  issues[report.fingerprint] = entry;
  await writeIssues(issues);
  log(`opened issue #${issue.number} for ${report.id}`);
};

// the token travels in a header, never in the path: a recording rebuilt in
// the viewer could otherwise send the page's address to another site
const authorized = (header) =>
  timingSafeEqual(digest(header ?? ""), digest(`Bearer ${viewToken}`));

const view = async (request, response, rest) => {
  if (rest === "" || rest.startsWith("?")) {
    const page = await readFile(VIEWER).catch(() => null);
    if (page === null) {
      log(
        `cannot read ${VIEWER.pathname}: keep viewer.html next to server.mjs`,
      );
      return send(response, 404, "text/plain", "viewer.html is missing");
    }
    response.setHeader("referrer-policy", "no-referrer");
    return send(response, 200, "text/html; charset=utf-8", page);
  }
  const [path, query = ""] = rest.split("?", 2);
  if (path.startsWith("/") && path.endsWith(".png")) {
    const name = path.slice(1, -".png".length);
    const key = new URLSearchParams(query).get("key") ?? "";
    const keyed =
      NAME.test(name) &&
      timingSafeEqual(digest(key), digest(screenshotKey(name)));
    if (!keyed && !authorized(request.headers.authorization)) {
      response.setHeader("www-authenticate", "Bearer");
      return send(response, 401, "text/plain", "");
    }
    if (!NAME.test(name)) return send(response, 404, "text/plain", "");
    const png = await readFile(join(REPORTS, `${name}.png`)).catch(() => null);
    if (png === null) return send(response, 404, "text/plain", "");
    response.setHeader("x-content-type-options", "nosniff");
    // a new view token turns the keyed links off; GitHub's image proxy may
    // still hold a copy it fetched before
    response.setHeader("cache-control", "no-store");
    return send(response, 200, "image/png", png);
  }
  if (!authorized(request.headers.authorization)) {
    response.setHeader("www-authenticate", "Bearer");
    return send(response, 401, "text/plain", "");
  }
  if (rest === "/list") {
    return send(
      response,
      200,
      "application/json",
      JSON.stringify(await list()),
    );
  }
  const name =
    rest.startsWith("/") && rest.endsWith(".json")
      ? rest.slice(1, -".json".length)
      : "";
  if (!NAME.test(name)) return send(response, 404, "text/plain", "");
  const report = await readFile(join(REPORTS, `${name}.json`)).catch(
    () => null,
  );
  if (report === null) return send(response, 404, "text/plain", "");
  return send(response, 200, "application/json", report);
};

// on loopback a page from another site could reach the server through DNS
// rebinding: only our own Host names pass
const hostAllowed = (header, port) =>
  !LOOPBACK.has(HOST) ||
  [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(
    header ?? "",
  );

let active = 0;

const server = createServer(
  { requestTimeout: REQUEST_TIMEOUT_MS },
  async (request, response) => {
    try {
      if (!hostAllowed(request.headers.host, server.address().port))
        return respond(response, 421);
      const url = request.url ?? "";
      const viewing = url === VIEW_PATH || /^\/view[/?]/.test(url);
      if (viewing && request.method === "GET" && viewToken)
        return await view(request, response, url.slice(VIEW_PATH.length));
      if (!timingSafeEqual(digest(url), expected)) {
        response.writeHead(404).end();
        return;
      }
      // a set REWINDBUG_ORIGIN is the only page that may post; with "*" on
      // loopback, pages on loopback; a request without Origin is not a page
      const origin = request.headers.origin;
      if (
        origin !== undefined &&
        (ORIGIN === "*"
          ? LOOPBACK.has(HOST) && !LOOPBACK_ORIGIN.test(origin)
          : origin !== ORIGIN)
      )
        return respond(response, 403);
      if (request.method === "OPTIONS") return respond(response, 204);
      if (request.method !== "POST") return respond(response, 405);
      // the SDK keeps a refused report queued and sends it again later
      if (active >= MAX_CONCURRENT) {
        response.setHeader("connection", "close");
        return respond(response, 503);
      }
      active += 1;
      request.setTimeout(BODY_IDLE_MS, () => request.destroy());
      try {
        respond(response, await receive(request));
      } finally {
        active -= 1;
      }
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 413) response.setHeader("connection", "close");
        return respond(response, error.status);
      }
      log(`request failed: ${error.message}`);
      respond(response, 500);
    }
  },
);

for (const [name, value] of [
  ["REWINDBUG_TOKEN", TOKEN],
  ["REWINDBUG_VIEW_TOKEN", VIEW_TOKEN_ENV],
]) {
  if (value && !TOKEN_CHARS.test(value)) {
    log(`${name} may hold only letters, digits and . _ ~ -`);
    process.exit(1);
  }
}
if (VIEW_TOKEN_ENV && VIEW_TOKEN_ENV === TOKEN) {
  log(
    "REWINDBUG_VIEW_TOKEN must differ from REWINDBUG_TOKEN, which the app's code shows to everyone",
  );
  process.exit(1);
}

if (GITHUB_REPO && !REPO_NAME.test(GITHUB_REPO)) {
  log("REWINDBUG_GITHUB_REPO must look like owner/name");
  process.exit(1);
}
if (
  !Number.isSafeInteger(GITHUB_MAX_PER_HOUR) ||
  GITHUB_MAX_PER_HOUR < 1 ||
  String(GITHUB_MAX_PER_HOUR) !== GITHUB_MAX_PER_HOUR_ENV
) {
  log("REWINDBUG_GITHUB_MAX_PER_HOUR must be a whole number, 1 or more");
  process.exit(1);
}
if (GITHUB_REPO && !GITHUB_TOKEN) {
  log(
    "REWINDBUG_GITHUB_TOKEN is needed to open issues in REWINDBUG_GITHUB_REPO",
  );
  process.exit(1);
}

// anyone who reaches an open port could fill the folder an agent reads
if (!LOOPBACK.has(HOST) && !TOKEN) {
  if (!OPEN) {
    log(
      `refusing to listen on ${HOST} without REWINDBUG_TOKEN; set REWINDBUG_OPEN=1 to accept reports from anyone who reaches the port`,
    );
    process.exit(1);
  }
  log(`listening on ${HOST} without REWINDBUG_TOKEN: anyone can write reports`);
}

// on loopback the viewer gets a token of its own, kept between runs, so
// another user or process on the machine cannot read the reports either
const loopbackViewToken = async () => {
  const kept = (await readFile(VIEW_TOKEN_FILE, "utf8").catch(() => "")).trim();
  if (TOKEN_CHARS.test(kept)) return kept;
  const fresh = randomBytes(VIEW_TOKEN_BYTES).toString("hex");
  await writeFile(VIEW_TOKEN_FILE, `${fresh}\n`, { mode: 0o600 });
  return fresh;
};

// next to this file or in the working folder; missing — reports go without
// a picture
const loadRenderer = async () => {
  for (const base of [
    import.meta.url,
    pathToFileURL(join(process.cwd(), "package.json")).href,
  ]) {
    let path;
    try {
      path = createRequire(base).resolve(SCREENSHOT_MODULE);
    } catch {
      continue;
    }
    try {
      const { createRenderer } = await import(pathToFileURL(path).href);
      return createRenderer({ dir: DIR, privateStand: SCREENSHOT_LOCAL_STAND });
    } catch (error) {
      log(`cannot load ${SCREENSHOT_MODULE}: ${error.message}`);
      return null;
    }
  }
  log(
    "screenshots off: install rewindbug-mcp and playwright next to server.mjs for a PNG of each bug",
  );
  return null;
};

// leftovers of a crash or of a picture that outlived its report
const ORPHAN_AGE_MS = 60 * 60_000;
const cleanOrphans = async () => {
  const files = await readdir(REPORTS).catch(() => []);
  const reports = new Set(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length)),
  );
  for (const file of files) {
    const orphan =
      file.endsWith(".tmp") ||
      (file.endsWith(".png") && !reports.has(file.slice(0, -".png".length)));
    if (!orphan) continue;
    const path = join(REPORTS, file);
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > ORPHAN_AGE_MS)
      await removeFile(path).catch(() => undefined);
  }
};

await mkdir(REPORTS, { recursive: true, mode: 0o700 });
await cleanOrphans();
viewToken =
  VIEW_TOKEN_ENV || (LOOPBACK.has(HOST) ? await loopbackViewToken() : "");
renderer = await loadRenderer();
server.listen(PORT, HOST, () => {
  const { port } = server.address();
  const shown = TOKEN ? PATH.replace(TOKEN, "<REWINDBUG_TOKEN>") : PATH;
  process.stdout.write(`listening on http://${HOST}:${port}${shown}\n`);
  log(`reports folder ${REPORTS}`);
  // a token from the environment is the operator's own: it is not printed
  log(
    !viewToken
      ? "viewer off: set REWINDBUG_VIEW_TOKEN to read reports beyond loopback"
      : `viewer on http://${HOST}:${port}${VIEW_PATH}#token=${VIEW_TOKEN_ENV ? "<REWINDBUG_VIEW_TOKEN>" : viewToken}`,
  );
  if (GITHUB_REPO) log(`new bugs go to github.com/${GITHUB_REPO}/issues`);
});

const shutdown = () => {
  if (githubPending > 0)
    log(`stopping with ${githubPending} reports not yet sent to GitHub`);
  server.close(async () => {
    await renderer?.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
