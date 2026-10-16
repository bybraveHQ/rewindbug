// rewindbug endpoint example: one file, Node 22, no dependencies.
// Receives the gzip-JSON reports the rewindbug SDK posts and stores them in
// the folder layout rewindbug-mcp reads, so a coding agent can pick them up.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createGunzip } from "node:zlib";

const DEFAULT_PORT = 7358;
const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const HOST = process.env.HOST || "127.0.0.1";
const DIR = resolve(process.env.REWINDBUG_DIR || ".rewindbug");
const TOKEN = process.env.REWINDBUG_TOKEN || "";
const ORIGIN = process.env.REWINDBUG_ORIGIN || "*";

const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_REPORTS = 100;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_SUMMARY_MESSAGE = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const GZIP_MAGIC = [0x1f, 0x8b];
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME = /^\d{8}T\d{9}Z-[0-9a-f-]{36}$/;

const REPORTS = join(DIR, "reports");
const PATH = TOKEN ? `/report/${TOKEN}` : "/report";
const CORS = {
  "access-control-allow-origin": ORIGIN,
  "access-control-allow-methods": "POST",
  "access-control-allow-headers": "content-type",
  "access-control-allow-private-network": "true",
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
  // an older copy of the same report goes after the new one is in place
  const stale = bases.filter(
    (name) => name !== base && name.endsWith(report.id),
  );
  const kept = bases.filter((name) => !stale.includes(name));
  const excess = kept.slice(0, Math.max(0, kept.length - MAX_REPORTS));
  for (const name of [...stale, ...excess]) {
    await removeFile(join(REPORTS, `${name}.summary.json`));
    await removeFile(join(REPORTS, `${name}.json`));
  }
};

let queue = Promise.resolve();
const saveInOrder = (report, text, receivedAt) => {
  const done = queue.then(() => save(report, text, receivedAt));
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
  log(`saved ${report.id}: ${report.trigger.kind}`);
  return 204;
};

const respond = (response, status) => {
  if (!response.headersSent) response.writeHead(status, CORS).end();
};

// on loopback a page from another site could reach the server through DNS
// rebinding: only our own Host names pass
const hostAllowed = (header, port) =>
  !LOOPBACK.has(HOST) ||
  [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(
    header ?? "",
  );

const server = createServer(
  { requestTimeout: REQUEST_TIMEOUT_MS },
  async (request, response) => {
    try {
      if (!hostAllowed(request.headers.host, server.address().port))
        return respond(response, 421);
      if (!timingSafeEqual(digest(request.url ?? ""), expected)) {
        response.writeHead(404).end();
        return;
      }
      if (request.method === "OPTIONS") return respond(response, 204);
      if (request.method !== "POST") return respond(response, 405);
      respond(response, await receive(request));
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

if (!LOOPBACK.has(HOST) && !TOKEN)
  log(
    `listening on ${HOST} without REWINDBUG_TOKEN: anyone who reaches the port can write reports`,
  );

await mkdir(REPORTS, { recursive: true, mode: 0o700 });
server.listen(PORT, HOST, () => {
  const { port } = server.address();
  const shown = TOKEN ? PATH.replace(TOKEN, "<REWINDBUG_TOKEN>") : PATH;
  process.stdout.write(`listening on http://${HOST}:${port}${shown}\n`);
  log(`reports folder ${REPORTS}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
