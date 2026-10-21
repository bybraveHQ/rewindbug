import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { isIP, type LookupFunction } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "./log.ts";
import type { ReadReport } from "./store.ts";

// the screen at the moment of the error, rendered once per report from its
// rrweb recording in a headless Chromium: the receiver answers the page first
// and renders in the background, one report at a time
// (docs/decisions/20-10-2026-screenshot-from-snapshot.md)
export const MAX_RENDER_MS = 10_000;
export const IDLE_CLOSE_MS = 60_000;
export const MAX_QUEUE = 20;
export const MAX_PNG_BYTES = 2 * 1024 * 1024;
// a report file this large is not played: the recording alone would hold
// hundreds of megabytes in the browser
export const MAX_REPORT_BYTES = 8 * 1024 * 1024;
export const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_WIDTH = 2560;
export const MAX_HEIGHT = 1600;
const MAX_VIEWPORT = 10_000;
// one request, start to end; the render as a whole is bounded by its deadline
const FETCH_TIMEOUT_MS = 5_000;
const MAX_PARALLEL_FETCHES = 6;
const MAX_RENDER_BYTES = 20 * 1024 * 1024;
// resources one render may ask for at all: DNS and fetch work is bounded by
// this times the fetch timeout (security scan 14, 20-10-2026)
export const MAX_RESOURCES = 100;
const LAUNCH_TIMEOUT_MS = 30_000;
const MAX_FAILURE_CHARS = 200;
// Chromium itself reaches nothing: every request is answered from Node, so
// a dead proxy and a resolver that knows no name stop what the page could
// still start on its own, such as preconnect and DNS prefetch hints
export const OFFLINE_LAUNCH = {
  headless: true,
  timeout: LAUNCH_TIMEOUT_MS,
  // the page played is someone else's recording: the OS sandbox stays on
  chromiumSandbox: true,
  proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
  args: ["--host-resolver-rules=MAP * ~NOTFOUND"],
};
const SETTLE_QUIET_MS = 300;
const SETTLE_MAX_MS = 3_000;
const SETTLE_POLL_MS = 50;
// a Chromium that did not start is tried again after this long
const RELAUNCH_AFTER_MS = 5 * 60_000;
const FALLBACK_SIZE = { width: 1280, height: 720 };
// only what draws the page: styles, fonts, images. No scripts, no data
// requests, no navigation
const PASSIVE = new Set(["stylesheet", "font", "image"]);
const REDIRECT_MIN = 300;
const REDIRECT_MAX = 399;

export const screenshotPath = (reportPath: string): string =>
  reportPath.replace(/\.json$/, ".png");

// the slice of the Playwright API the renderer uses: playwright is the
// project's own optional package, not a dependency of this one
type Request = {
  method(): string;
  resourceType(): string;
  url(): string;
};
type Route = {
  request(): Request;
  fulfill(options: {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }): Promise<void>;
  abort(): Promise<void>;
};
type Page = {
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  setContent(
    html: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<void>;
  waitForFunction(
    fn: string,
    arg: undefined,
    options: { timeout: number },
  ): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  screenshot(options: { type: "png"; timeout: number }): Promise<Buffer>;
};
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = {
  newContext(options: Record<string, unknown>): Promise<Context>;
  close(): Promise<void>;
  on(event: "disconnected", fn: () => void): void;
};
export type Chromium = {
  launch(options: typeof OFFLINE_LAUNCH): Promise<Browser>;
};

// private, loopback, link-local, carrier-grade NAT, reserved, multicast
const v4Private = (ip: string): boolean => {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
};

const HEXTETS = 8;

// eight 16-bit groups; an embedded dotted IPv4 becomes the last two
const expand = (ip: string): number[] | undefined => {
  let text = ip.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.split(".").map(Number);
    text = `${text.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : HEXTETS - left.length - right.length;
  if (fill < 0) return undefined;
  const groups = [...left, ...Array<string>(fill).fill("0"), ...right].map(
    (group) => parseInt(group, 16),
  );
  return groups.length === HEXTETS && groups.every(Number.isFinite)
    ? groups
    : undefined;
};

const v4Of = (high: number, low: number): string =>
  [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");

const v6Private = (ip: string): boolean => {
  const g = expand(ip);
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, , , g5 = 0, g6 = 0, g7 = 0] = g;
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::a.b.c.d, ::ffff:a.b.c.d and NAT64 64:ff9b::a.b.c.d carry an IPv4
  // ::a.b.c.d, ::ffff:a.b.c.d, ::ffff:0:a.b.c.d and NAT64 64:ff9b::/96 and
  // the local 64:ff9b:1::/48 carry an IPv4 in the last 32 bits
  if (zeroTo(6) || (zeroTo(5) && g5 === 0xffff)) return v4Private(v4Of(g6, g7));
  if (zeroTo(4) && g[4] === 0xffff && g5 === 0) return v4Private(v4Of(g6, g7));
  if (g0 === 0x64 && g1 === 0xff9b) return v4Private(v4Of(g6, g7));
  // 6to4: 2002:a.b.c.d::/48
  if (g0 === 0x2002) return v4Private(v4Of(g1, g2));
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local
    (g0 & 0xffc0) === 0xfe80 || // link-local
    (g0 & 0xffc0) === 0xfec0 || // site-local
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g1 === 0x0db8) || // documentation
    (g0 === 0x2001 && g1 === 0x0000) || // Teredo
    (g0 === 0x0100 && zeroTo(4)) // discard
  );
};

const isLoopback = (ip: string): boolean => {
  const kind = isIP(ip);
  if (kind === 4) return ip.startsWith("127.");
  const g = kind === 6 ? expand(ip) : undefined;
  if (!g) return false;
  const [, , , , g4 = 0, g5 = 0, g6 = 0] = g;
  if (g.slice(0, 7).every((x) => x === 0)) return g[7] === 1;
  return (
    g.slice(0, 4).every((x) => x === 0) &&
    g4 === 0 &&
    g5 === 0xffff &&
    g6 >> 8 === 127
  );
};

export const isPrivateAddress = (ip: string): boolean => {
  const kind = isIP(ip);
  if (kind === 4) return v4Private(ip);
  if (kind === 6) return v6Private(ip);
  return true;
};

type Resolve = (host: string) => Promise<string[]>;
const resolveAll: Resolve = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

const parse = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

const hostOf = (url: URL): string =>
  url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

// the page that sent the report, as the report says it: report text is page
// data, so its origin opens a private address only for a receiver on
// loopback, whose reports come from the developer's own browser
export type Stand = { origin?: string; privateOk: boolean };

export const standOf = (report: ReadReport, privateOk: boolean): Stand => {
  const parsed = parse(String(report.context.url));
  return {
    privateOk,
    ...(parsed && /^https?:$/.test(parsed.protocol)
      ? { origin: parsed.origin }
      : {}),
  };
};

// the one address the request goes to, already checked: the connection is
// made to it and nowhere else, so a name cannot change its answer in between
export const pinnedAddress = async (
  url: string,
  stand: Stand,
  resolve: Resolve = resolveAll,
): Promise<string | undefined> => {
  const parsed = parse(url);
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return undefined;
  const host = hostOf(parsed);
  if (!host) return undefined;
  const own = stand.privateOk && stand.origin === parsed.origin;
  if (
    !own &&
    (host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local"))
  )
    return undefined;
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    return undefined;
  }
  if (!addresses.length) return undefined;
  // a local stand is this machine: its own origin opens loopback only, never
  // the local network or a cloud metadata address
  if (own && addresses.every(isLoopback)) return addresses[0];
  return addresses.some(isPrivateAddress) ? undefined : addresses[0];
};

export const passive = (request: Request): boolean =>
  request.method() === "GET" && PASSIVE.has(request.resourceType());

type Fetched = { status: number; type: string; body: Buffer };

// a GET from Node to the pinned address: no cookies, no redirects followed,
// the body capped, the whole request bounded in time and cancelled with the
// render
export const fetchPinned = (
  url: string,
  address: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<Fetched | undefined> =>
  new Promise((resolve) => {
    const maxBytes = Math.min(
      options.maxBytes ?? MAX_RESOURCE_BYTES,
      MAX_RESOURCE_BYTES,
    );
    let settled = false;
    const done = (value: Fetched | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve(value);
    };
    const parsed = new URL(url);
    const pin: LookupFunction = (_host, options, callback) => {
      const family = isIP(address);
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const request = (parsed.protocol === "https:" ? httpsRequest : httpRequest)(
      parsed,
      {
        method: "GET",
        lookup: pin,
        headers: { accept: "*/*", "user-agent": "rewindbug-mcp screenshot" },
        agent: false,
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        if (status >= REDIRECT_MIN && status <= REDIRECT_MAX) {
          response.destroy();
          return done(undefined);
        }
        const parts: Buffer[] = [];
        let size = 0;
        response.on("data", (part: Buffer) => {
          size += part.length;
          if (size > maxBytes) {
            response.destroy();
            done(undefined);
            return;
          }
          parts.push(part);
        });
        response.on("end", () =>
          done({
            status,
            type: String(
              response.headers["content-type"] ?? "application/octet-stream",
            ),
            body: Buffer.concat(parts),
          }),
        );
        response.on("error", () => done(undefined));
      },
    );
    const stop = () => {
      request.destroy();
      done(undefined);
    };
    const timer = setTimeout(stop, FETCH_TIMEOUT_MS);
    timer.unref();
    if (options.signal?.aborted) return stop();
    options.signal?.addEventListener("abort", stop);
    request.on("error", () => done(undefined));
    request.end();
  });

type Event = { timestamp?: unknown };

const sizeOf = (report: ReadReport): { width: number; height: number } => {
  const viewport = (
    report.context as { viewport?: { width?: unknown; height?: unknown } }
  ).viewport;
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  const fine = (n: number) => Number.isFinite(n) && n >= 1 && n <= MAX_VIEWPORT;
  return fine(width) && fine(height)
    ? { width: Math.round(width), height: Math.round(height) }
    : FALLBACK_SIZE;
};

// where to stop the recording: the trigger, inside the recorded range
export const offsetOf = (events: Event[], at: unknown): number => {
  let first = Infinity;
  let last = -Infinity;
  for (const event of events) {
    const stamp = Number(event.timestamp);
    if (!Number.isFinite(stamp)) continue;
    if (stamp < first) first = stamp;
    if (stamp > last) last = stamp;
  }
  if (first === Infinity) return 0;
  const target = Number(at);
  if (!Number.isFinite(target)) return last - first;
  return Math.min(Math.max(target - first, 0), last - first);
};

const POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' http: https:",
  "img-src http: https: data: blob:",
  "font-src http: https: data:",
].join("; ");

// the recording is page data: it goes in as JSON that cannot close its tag
export const renderHtml = (
  events: unknown[],
  offset: number,
  size: { width: number; height: number },
): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${POLICY}" />
    <style>${__RRWEB_PLAYER_STYLE__}
      html, body { margin: 0; background: #fff; overflow: hidden; }
      #box { transform-origin: 0 0; }
      .replayer-mouse, .replayer-mouse-tail { display: none !important; }
      .replayer-wrapper > iframe { border: 0; display: block; }
    </style>
  </head>
  <body>
    <div id="box"></div>
    <script id="events" type="application/json">${JSON.stringify(events).replace(/</g, "\\u003c")}</script>
    <script>${__RRWEB_PLAYER_SCRIPT__}</script>
    <script>
      (() => {
        try {
          const events = JSON.parse(document.getElementById("events").textContent);
          const box = document.getElementById("box");
          let size = { width: ${size.width}, height: ${size.height} };
          const fit = () => {
            const scale = Math.min(1, ${MAX_WIDTH} / size.width, ${MAX_HEIGHT} / size.height);
            box.style.transform = "scale(" + scale + ")";
            window.__shot = {
              width: Math.max(1, Math.min(${MAX_WIDTH}, Math.ceil(size.width * scale))),
              height: Math.max(1, Math.min(${MAX_HEIGHT}, Math.ceil(size.height * scale))),
            };
          };
          const player = new window.rrwebReplay.Replayer(events, {
            root: box,
            mouseTail: false,
            showWarning: false,
            showDebug: false,
            triggerFocus: false,
          });
          player.on("resize", (next) => {
            if (next && next.width >= 1 && next.height >= 1 && next.width <= ${MAX_VIEWPORT} && next.height <= ${MAX_VIEWPORT}) {
              size = { width: next.width, height: next.height };
              fit();
            }
          });
          fit();
          // the player applies only events strictly before the offset: the
          // change at the trigger itself belongs on the picture
          player.pause(${offset + 1});
          fit();
          window.__ready = true;
        } catch (error) {
          window.__failed = String(error && error.message || error);
        }
      })();
    </script>
  </body>
</html>
`;

const sleep = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms).unref());

export type ShootOptions = {
  // the stand's own origin may be a private address
  privateStand?: boolean;
  resolve?: Resolve;
  fetch?: typeof fetchPinned;
  timeoutMs?: number;
};

export const shoot = async (
  browser: Browser,
  report: ReadReport,
  options: ShootOptions = {},
): Promise<Buffer | undefined> => {
  const events = (report.replay?.events ?? []) as Event[];
  if (!events.length) return undefined;
  const fetchOne = options.fetch ?? fetchPinned;
  const size = sizeOf(report);
  const context = await browser.newContext({
    viewport: {
      width: Math.min(size.width, MAX_WIDTH),
      height: Math.min(size.height, MAX_HEIGHT),
    },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  // the deadline closes the context: every call still running on it fails
  // at once, so a slow render ends here and the next one starts after it
  let closed = false;
  const cancel = new AbortController();
  const close = () => {
    closed = true;
    cancel.abort();
    return context.close().catch(() => undefined);
  };
  const limit = options.timeoutMs ?? MAX_RENDER_MS;
  const deadline = setTimeout(() => void close(), limit);
  deadline.unref();
  try {
    const page = await context.newPage();
    const stand = standOf(report, options.privateStand ?? false);
    let open = 0;
    let lastActivity = Date.now();
    // a recording may name hundreds of resources: a few at a time, and all
    // of them together within a byte budget
    let running = 0;
    const waiting: (() => void)[] = [];
    let budget = MAX_RENDER_BYTES;
    const slot = async () => {
      if (running >= MAX_PARALLEL_FETCHES)
        await new Promise<void>((go) => waiting.push(go));
      running++;
    };
    const release = () => {
      running--;
      waiting.shift()?.();
    };
    let asked = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        !passive(request) ||
        closed ||
        budget <= 0 ||
        asked >= MAX_RESOURCES
      ) {
        await route.abort().catch(() => undefined);
        return;
      }
      asked++;
      open++;
      lastActivity = Date.now();
      // the slot comes before the name is resolved: lookups are bounded too
      await slot();
      try {
        const address = closed
          ? undefined
          : await pinnedAddress(request.url(), stand, options.resolve);
        const response = address
          ? await fetchOne(request.url(), address, {
              signal: cancel.signal,
              maxBytes: budget,
            })
          : undefined;
        if (response) budget -= response.body.length;
        if (!response) await route.abort();
        else
          await route.fulfill({
            status: response.status,
            // the render page has no origin of its own: fonts from any host
            // need this to load
            headers: {
              "content-type": response.type,
              "access-control-allow-origin": "*",
            },
            body: response.body,
          });
      } catch {
        await route.abort().catch(() => undefined);
      } finally {
        release();
        open--;
        lastActivity = Date.now();
      }
    });
    const html = renderHtml(events, offsetOf(events, report.trigger.at), size);
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: MAX_RENDER_MS,
    });
    await page.waitForFunction("window.__ready || window.__failed", undefined, {
      timeout: MAX_RENDER_MS,
    });
    const failed = await page.evaluate<string | undefined>("window.__failed");
    // the message comes from the page's own recording: one line, bounded,
    // control characters escaped, so it cannot forge a log line or drive
    // the operator's terminal
    if (failed)
      throw new Error(
        `the player failed: ${JSON.stringify([...failed].slice(0, MAX_FAILURE_CHARS).join(""))}`,
      );
    // styles, fonts and images of the stand: wait until the network is quiet
    const started = Date.now();
    while (
      !closed &&
      Date.now() - started < SETTLE_MAX_MS &&
      (open > 0 || Date.now() - lastActivity < SETTLE_QUIET_MS)
    )
      await sleep(SETTLE_POLL_MS);
    const shot = await page.evaluate<{ width: number; height: number }>(
      "window.__shot",
    );
    await page.setViewportSize(shot);
    return await page.screenshot({ type: "png", timeout: MAX_RENDER_MS });
  } catch (error) {
    if (closed)
      throw new Error(`the screenshot took over ${limit} ms`, { cause: error });
    throw error;
  } finally {
    clearTimeout(deadline);
    await close();
  }
};

// playwright of the project: next to the reports folder (the qa repo) first,
// so the package matches the browsers it installed; then next to this package
// (npm, or a pnpm optional peer) and in the working folder. @playwright/test
// exports the same chromium, and under pnpm a test project resolves only it
const PLAYWRIGHT_PACKAGES = ["playwright", "@playwright/test"];

const playwrightCandidates = function* (
  dir: string,
): Generator<{ name: string; path: string }> {
  const bases = [
    pathToFileURL(join(dirname(dir), "package.json")).href,
    import.meta.url,
    pathToFileURL(join(process.cwd(), "package.json")).href,
  ];
  for (const base of bases) {
    for (const name of PLAYWRIGHT_PACKAGES) {
      try {
        yield { name, path: createRequire(base).resolve(name) };
      } catch {
        // not installed from this base
      }
    }
  }
};

// which package the renderer would load, without loading it
export const findPlaywright = (dir: string): string | undefined =>
  playwrightCandidates(dir).next().value?.name;

export const loadChromium = async (
  dir: string,
): Promise<Chromium | undefined> => {
  for (const { path } of playwrightCandidates(dir)) {
    const module = (await import(pathToFileURL(path).href)) as {
      chromium?: Chromium;
      default?: { chromium?: Chromium };
    };
    const chromium = module.chromium ?? module.default?.chromium;
    if (chromium) return chromium;
  }
  return undefined;
};

// what the renderer reads back from a report file before it plays it
const readPlayable = async (
  reportPath: string,
): Promise<ReadReport | undefined> => {
  const { size } = await stat(reportPath);
  if (size > MAX_REPORT_BYTES) {
    log(`screenshot skipped: ${reportPath} is over ${MAX_REPORT_BYTES} bytes`);
    return undefined;
  }
  const report = JSON.parse(await readFile(reportPath, "utf8")) as ReadReport;
  const events = report.replay?.events;
  return Array.isArray(events) && events.length && report.context
    ? report
    : undefined;
};

export type Renderer = {
  // the report is read from its file when its turn comes: the queue holds
  // paths, not recordings
  enqueue(reportPath: string): void;
  // a report still in the queue: wait for its picture, at most `ms`
  wait(reportPath: string, ms: number): Promise<void>;
  close(): Promise<void>;
};

export const createRenderer = (options: {
  dir: string;
  // the stand's own origin may be a private address: only for a receiver on
  // loopback, whose reports come from the developer's own browser
  privateStand?: boolean;
  load?: () => Promise<Chromium | undefined>;
  resolve?: Resolve;
  fetch?: typeof fetchPinned;
}): Renderer => {
  const load = options.load ?? (() => loadChromium(options.dir));
  const pending = new Map<string, Promise<void>>();
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  let chromium: Promise<Chromium | undefined> | undefined;
  let browser: Promise<Browser> | undefined;
  let idle: NodeJS.Timeout | undefined;
  let missing = false;
  let failedAt = 0;

  const stopBrowser = async () => {
    clearTimeout(idle);
    const current = browser;
    browser = undefined;
    if (current)
      await (
        await current.catch(() => undefined)
      )
        ?.close()
        .catch(() => undefined);
  };

  const getBrowser = async (): Promise<Browser | undefined> => {
    chromium ??= load().catch((error: unknown) => {
      log(
        `cannot load playwright for screenshots: ${(error as Error).message}`,
      );
      return undefined;
    });
    const engine = await chromium;
    if (!engine) {
      if (!missing)
        log(
          "playwright is not installed next to the reports folder: reports come without a screenshot until it is installed and the server restarts",
        );
      missing = true;
      return undefined;
    }
    if (failedAt && Date.now() - failedAt < RELAUNCH_AFTER_MS) return undefined;
    if (!browser) {
      const launching = engine.launch(OFFLINE_LAUNCH).then((started) => {
        // only this browser's own end clears the slot: a newer one may
        // already be in it
        started.on("disconnected", () => {
          if (browser === launching) browser = undefined;
        });
        return started;
      });
      browser = launching;
    }
    try {
      const started = await browser;
      failedAt = 0;
      return started;
    } catch (error) {
      browser = undefined;
      failedAt = Date.now();
      log(
        `cannot start Chromium for screenshots (${String((error as Error).message).split("\n")[0]}); run \`npx playwright install chromium\` in the project, next try in ${RELAUNCH_AFTER_MS / 60_000} min`,
      );
      return undefined;
    }
  };

  const save = async (reportPath: string, png: Buffer) => {
    if (png.length > MAX_PNG_BYTES) {
      log(`screenshot over ${MAX_PNG_BYTES} bytes skipped`);
      return;
    }
    const target = screenshotPath(reportPath);
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, png, { mode: 0o600 });
    try {
      // the report may have been replaced or pruned while it rendered
      await stat(reportPath);
      await rename(tmp, target);
    } catch {
      await rm(tmp, { force: true });
    }
  };

  const run = async (reportPath: string) => {
    if (missing) return;
    const report = await readPlayable(reportPath);
    if (!report) return;
    const current = await getBrowser();
    if (!current) return;
    clearTimeout(idle);
    try {
      const png = await shoot(current, report, {
        privateStand: options.privateStand ?? false,
        ...(options.resolve ? { resolve: options.resolve } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      if (png) await save(reportPath, png);
    } finally {
      idle = setTimeout(() => void stopBrowser(), IDLE_CLOSE_MS);
      idle.unref();
    }
  };

  return {
    enqueue(reportPath) {
      // the same report sent again while its picture renders: one render
      if (missing || pending.has(reportPath)) return;
      if (queued >= MAX_QUEUE) {
        log(
          `screenshot queue is full (${MAX_QUEUE}): ${reportPath} goes without one`,
        );
        return;
      }
      queued++;
      const job = chain
        .then(() => run(reportPath))
        .catch((error: unknown) =>
          log(
            `cannot render a screenshot for ${reportPath}: ${(error as Error).message}`,
          ),
        )
        .finally(() => {
          queued--;
          if (pending.get(reportPath) === job) pending.delete(reportPath);
        });
      chain = job;
      pending.set(reportPath, job);
    },
    async wait(reportPath, ms) {
      const job = pending.get(reportPath);
      if (job) await Promise.race([job, sleep(ms)]);
    },
    close: stopBrowser,
  };
};
