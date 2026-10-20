import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { fixture } from "./fixture.ts";
import {
  createRenderer,
  fetchPinned,
  isPrivateAddress,
  loadChromium,
  MAX_QUEUE,
  MAX_REPORT_BYTES,
  MAX_RESOURCE_BYTES,
  MAX_RESOURCES,
  OFFLINE_LAUNCH,
  offsetOf,
  passive,
  pinnedAddress,
  renderHtml,
  screenshotPath,
  shoot,
  standOf,
  type Chromium,
} from "./screenshot.ts";
import type { ReadReport } from "./store.ts";

// synthetic-image-ok: PNG signature bytes to recognise a rendered file
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const isPng = (data: Buffer) => PNG_MAGIC.every((byte, i) => data[i] === byte);
// width and height from the IHDR chunk
const pngSize = (data: Buffer) => ({
  width: data.readUInt32BE(16),
  height: data.readUInt32BE(20),
});

const request = (url: string, resourceType = "stylesheet", method = "GET") => ({
  method: () => method,
  resourceType: () => resourceType,
  url: () => url,
});
const PUBLIC_IP = "93.184.216.34";
const publicDns = async () => [PUBLIC_IP];
const standOn = (url: string, privateOk = true) =>
  standOf({ context: { url } } as never, privateOk);

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

type Answer = {
  status: number;
  body?: string | Buffer;
  headers?: Record<string, string>;
};

const serve = async (handler: (url: string) => Answer) => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const { status, body = "", headers = {} } = handler(req.url ?? "");
    res.writeHead(status, headers).end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, hits };
};

describe("addresses", () => {
  test("private, loopback, reserved and embedded IPv4 forms are private", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "192.0.0.8",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::127.0.0.1",
      "::7f00:1",
      "::ffff:127.0.0.1",
      "::ffff:a9fe:a9fe",
      "64:ff9b::7f00:1",
      "64:ff9b::10.0.0.1",
      "64:ff9b:1::7f00:1",
      "::ffff:0:7f00:1",
      "2001::1",
      "2002:7f00:1::",
      "fd00::1",
      "fe80::1",
      "fec0::1",
      "ff02::1",
      "2001:db8::1",
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of [
      PUBLIC_IP,
      "8.8.8.8",
      "2606:4700::1111",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
      "2002:808:808::",
    ])
      expect(isPrivateAddress(ip), ip).toBe(false);
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });

  test("only a GET for a style, a font or an image is fetched at all", () => {
    expect(passive(request("https://a.dev/a.css"))).toBe(true);
    expect(passive(request("https://a.dev/f.woff2", "font"))).toBe(true);
    expect(passive(request("https://a.dev/i.png", "image"))).toBe(true);
    for (const type of [
      "script",
      "xhr",
      "fetch",
      "websocket",
      "document",
      "media",
      "other",
    ])
      expect(passive(request("https://a.dev/x", type)), type).toBe(false);
    expect(passive(request("https://a.dev/a.css", "stylesheet", "POST"))).toBe(
      false,
    );
  });

  test("a public host is pinned to its checked address; anything private is refused", async () => {
    const stand = standOn("https://stand.example.dev/");
    const pin = (url: string, resolve = publicDns) =>
      pinnedAddress(url, stand, resolve);
    expect(await pin("https://cdn.example.com/a.css")).toBe(PUBLIC_IP);
    expect(await pin("file:///etc/passwd")).toBeUndefined();
    expect(await pin("http://localhost:9000/a.css")).toBeUndefined();
    expect(await pin("http://printer.local/a.png")).toBeUndefined();
    expect(await pin("http://169.254.169.254/latest")).toBeUndefined();
    expect(await pin("http://[::1]:80/a.css")).toBeUndefined();
    // numeric forms of 127.0.0.1 are normalised by the URL parser
    for (const url of [
      "http://2130706433/a.css",
      "http://0177.0.0.1/a.css",
      "http://0x7f.1/a.css",
      "http://[::ffff:7f00:1]/a.css",
      "http://[::7f00:1]/a.css",
    ])
      expect(await pin(url), url).toBeUndefined();
    const rebound = async () => [PUBLIC_IP, "127.0.0.1"];
    expect(
      await pin("https://evil.example.com/a.css", rebound),
    ).toBeUndefined();
    const broken = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await pin("https://gone.example.com/a.css", broken)).toBeUndefined();
  });

  test("a local stand opens only its own origin, and only where that is allowed", async () => {
    const local = standOn("http://localhost:4244/cart");
    const loopback = async () => ["127.0.0.1"];
    expect(
      await pinnedAddress("http://localhost:4244/a.css", local, loopback),
    ).toBe("127.0.0.1");
    // another port on the same host is another service
    expect(
      await pinnedAddress("http://localhost:7357/a.css", local, loopback),
    ).toBeUndefined();
    // a receiver beyond loopback trusts no report with a private page
    expect(
      await pinnedAddress(
        "http://localhost:4244/a.css",
        standOn("http://localhost:4244/cart", false),
        loopback,
      ),
    ).toBeUndefined();
    // even where allowed, the own origin opens loopback only: not the local
    // network, not a cloud metadata address
    const lan = standOn("http://192.168.1.10/cart");
    expect(
      await pinnedAddress("http://192.168.1.10/a.css", lan, publicDns),
    ).toBeUndefined();
    const metadata = standOn("http://169.254.169.254/latest/");
    expect(
      await pinnedAddress(
        "http://169.254.169.254/latest/x.css",
        metadata,
        publicDns,
      ),
    ).toBeUndefined();
    const crafted = standOn("http://169.254.169.254/latest/", false);
    expect(
      await pinnedAddress(
        "http://169.254.169.254/latest/x.css",
        crafted,
        publicDns,
      ),
    ).toBeUndefined();
    expect(
      standOf({ context: { url: "javascript:alert(1)" } } as never, true)
        .origin,
    ).toBeUndefined();
  });
});

describe("fetching for the render", () => {
  test("the connection goes to the pinned address, whatever the name says", async () => {
    const site = await serve(() => ({
      status: 200,
      body: "body{}",
      headers: { "content-type": "text/css" },
    }));
    const got = await fetchPinned(
      `http://stand.invalid:${site.port}/a.css`,
      "127.0.0.1",
    );
    expect(got?.status).toBe(200);
    expect(got?.type).toBe("text/css");
    expect(got?.body.toString()).toBe("body{}");
    expect(site.hits).toEqual(["/a.css"]);
  });

  test("a request is cancelled with the render and capped by the render's budget", async () => {
    const hang = await new Promise<{ port: number }>((done) => {
      const server = createServer((_req, res) => {
        res.writeHead(200);
        res.write("a");
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        done({
          port: typeof address === "object" && address ? address.port : 0,
        });
      });
    });
    const cancel = new AbortController();
    const started = Date.now();
    setTimeout(() => cancel.abort(), 100);
    expect(
      await fetchPinned(`http://127.0.0.1:${hang.port}/slow.css`, "127.0.0.1", {
        signal: cancel.signal,
      }),
    ).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    const site = await serve(() => ({ status: 200, body: Buffer.alloc(100) }));
    expect(
      await fetchPinned(`http://127.0.0.1:${site.port}/a.png`, "127.0.0.1", {
        maxBytes: 50,
      }),
    ).toBeUndefined();
  });

  test("a redirect is not followed; an oversized body is dropped", async () => {
    const target = await serve(() => ({ status: 200, body: "secret" }));
    const site = await serve((url) =>
      url === "/big"
        ? { status: 200, body: Buffer.alloc(MAX_RESOURCE_BYTES + 1) }
        : {
            status: 302,
            headers: { location: `http://127.0.0.1:${target.port}/secret` },
          },
    );
    expect(
      await fetchPinned(`http://127.0.0.1:${site.port}/a.png`, "127.0.0.1"),
    ).toBeUndefined();
    expect(target.hits).toEqual([]);
    expect(
      await fetchPinned(`http://127.0.0.1:${site.port}/big`, "127.0.0.1"),
    ).toBeUndefined();
  });
});

describe("the render page", () => {
  test("the offset is the trigger, clamped to the recording", () => {
    const events = [{ timestamp: 1000 }, { timestamp: 4000 }];
    expect(offsetOf(events, 2500)).toBe(1500);
    expect(offsetOf(events, 500)).toBe(0);
    expect(offsetOf(events, 9000)).toBe(3000);
    expect(offsetOf(events, undefined)).toBe(3000);
    expect(offsetOf([], 1)).toBe(0);
    // no spread over the events: a long recording does not overflow the stack
    const many = Array.from({ length: 200_000 }, (_, i) => ({ timestamp: i }));
    expect(offsetOf(many, 150_000)).toBe(150_000);
  });

  test("page text in the events cannot close the data tag", () => {
    const text = "</script><script>alert(1)</script>";
    const html = renderHtml([{ type: 3, data: { text } }], 0, {
      width: 800,
      height: 600,
    });
    const data =
      /<script id="events" type="application\/json">([\s\S]*?)<\/script>/.exec(
        html,
      )?.[1] ?? "";
    expect(data).not.toContain("</script");
    expect(JSON.parse(data)).toEqual([{ type: 3, data: { text } }]);
    expect(html).toContain("rrwebReplay");
    expect(html).toContain("script-src 'unsafe-inline'");
    // the event at the trigger itself is applied
    expect(renderHtml([], 1500, { width: 1, height: 1 })).toContain(
      "player.pause(1501)",
    );
  });
});

// a fake Chromium: every report becomes a fixed PNG
// synthetic-image-ok: a format stub for the renderer contract, never shown as a picture
const FAKE_PNG = Buffer.from([...PNG_MAGIC, 0x0d, 0x0a, 0x1a, 0x0a]);
const fakeChromium = (delayMs = 0, hang = false) => {
  const launches = vi.fn();
  const closes = vi.fn();
  const chromium: Chromium = {
    launch: async () => {
      launches();
      return {
        on: () => undefined,
        close: async () => undefined,
        newContext: async () => {
          let closed: () => void = () => undefined;
          const gone = new Promise<never>((_, fail) => {
            closed = () => fail(new Error("Target closed"));
          });
          gone.catch(() => undefined);
          return {
            close: async () => {
              closes();
              closed();
            },
            newPage: async () =>
              ({
                route: async () => undefined,
                setContent: async () => undefined,
                waitForFunction: async () => (hang ? gone : true),
                evaluate: async (fn: string) =>
                  fn === "window.__shot"
                    ? { width: 10, height: 10 }
                    : undefined,
                setViewportSize: async () => undefined,
                screenshot: async () => {
                  await new Promise((done) => setTimeout(done, delayMs));
                  return FAKE_PNG;
                },
              }) as never,
          };
        },
      };
    },
  };
  return { chromium, launches, closes };
};

const playable = (id = fixture.id): ReadReport =>
  ({
    ...fixture,
    id,
    replay: {
      format: "rrweb",
      events: [
        {
          type: 4,
          timestamp: fixture.trigger.at,
          data: { width: 10, height: 10, href: "" },
        },
      ],
    },
  }) as unknown as ReadReport;

describe("the renderer queue", () => {
  let dir: string;
  const reportAt = async (
    name: string,
    report: ReadReport | null = playable(),
  ) => {
    const path = join(dir, name);
    await writeFile(
      path,
      JSON.stringify(report ?? { ...playable(), replay: null }),
    );
    return path;
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rewindbug-shot-"));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  test("a report is read from its file and becomes a PNG next to it", async () => {
    const { chromium, launches } = fakeChromium(50);
    const renderer = createRenderer({ dir, load: async () => chromium });
    const path = await reportAt("r.json");
    renderer.enqueue(path);
    // the same report again while it renders: one render
    renderer.enqueue(path);
    await renderer.wait(path, 3000);
    expect(isPng(await readFile(screenshotPath(path)))).toBe(true);
    expect((await stat(screenshotPath(path))).mode & 0o777).toBe(0o600);
    const second = await reportAt("s.json");
    renderer.enqueue(second);
    await renderer.wait(second, 3000);
    // the browser stays for the next report
    expect(launches).toHaveBeenCalledTimes(1);
    await renderer.close();
  });

  test("wait gives up after its time; a report without a recording or too large is skipped", async () => {
    const { chromium } = fakeChromium(400);
    const renderer = createRenderer({ dir, load: async () => chromium });
    const path = await reportAt("r.json");
    renderer.enqueue(path);
    const started = Date.now();
    await renderer.wait(path, 50);
    expect(Date.now() - started).toBeLessThan(300);
    await renderer.wait(path, 3000);
    const bare = await reportAt("bare.json", null);
    renderer.enqueue(bare);
    await renderer.wait(bare, 1000);
    await expect(stat(screenshotPath(bare))).rejects.toThrow();
    const big = join(dir, "big.json");
    await writeFile(big, " ".repeat(MAX_REPORT_BYTES + 1));
    renderer.enqueue(big);
    await renderer.wait(big, 1000);
    await expect(stat(screenshotPath(big))).rejects.toThrow();
    await renderer.close();
  });

  test("a report removed while it rendered leaves no PNG behind", async () => {
    const { chromium } = fakeChromium(200);
    const renderer = createRenderer({ dir, load: async () => chromium });
    const path = await reportAt("gone.json");
    renderer.enqueue(path);
    await new Promise((done) => setTimeout(done, 100));
    await rm(path);
    await renderer.wait(path, 3000);
    await expect(stat(screenshotPath(path))).rejects.toThrow();
    await renderer.close();
  });

  test("a render past its deadline closes its context and fails", async () => {
    const { chromium, closes } = fakeChromium(0, true);
    const browser = await chromium.launch(OFFLINE_LAUNCH);
    await expect(
      shoot(browser, playable(), { timeoutMs: 100 }),
    ).rejects.toThrow(/took over 100 ms/);
    expect(closes).toHaveBeenCalled();
  });

  test("a full queue skips new reports with a log line", async () => {
    const { chromium } = fakeChromium(30);
    const renderer = createRenderer({ dir, load: async () => chromium });
    const paths: string[] = [];
    for (let i = 0; i < MAX_QUEUE + 2; i++)
      paths.push(await reportAt(`q${i}.json`));
    for (const path of paths) renderer.enqueue(path);
    expect(
      String(vi.mocked(process.stderr.write).mock.calls.at(-1)?.[0]),
    ).toMatch(/queue is full/);
    await renderer.wait(paths[MAX_QUEUE - 1] ?? "", 20_000);
    await expect(stat(screenshotPath(paths.at(-1) ?? ""))).rejects.toThrow();
    await renderer.close();
    // each render waits for a quiet network: a full queue takes seconds
  }, 30_000);

  test("no playwright: one log line, reports go without a picture", async () => {
    const renderer = createRenderer({ dir, load: async () => undefined });
    const path = await reportAt("r.json");
    renderer.enqueue(path);
    await renderer.wait(path, 1000);
    renderer.enqueue(path);
    await renderer.wait(path, 1000);
    const lines = vi
      .mocked(process.stderr.write)
      .mock.calls.map((c) => String(c[0]));
    expect(
      lines.filter((l) => /playwright is not installed/.test(l)),
    ).toHaveLength(1);
    await expect(stat(screenshotPath(path))).rejects.toThrow();
  });

  test("Chromium that does not start: one log line, no new attempt right away", async () => {
    const launch = vi.fn(async () =>
      Promise.reject(new Error("Executable doesn't exist\nlong")),
    );
    const renderer = createRenderer({ dir, load: async () => ({ launch }) });
    const path = await reportAt("r.json");
    renderer.enqueue(path);
    await renderer.wait(path, 1000);
    const other = await reportAt("o.json");
    renderer.enqueue(other);
    await renderer.wait(other, 1000);
    expect(launch).toHaveBeenCalledTimes(1);
    const lines = vi
      .mocked(process.stderr.write)
      .mock.calls.map((c) => String(c[0]));
    expect(
      lines.some(
        (l) => /npx playwright install chromium/.test(l) && !/long/.test(l),
      ),
    ).toBe(true);
  });

  test("@playwright/test stands in for playwright, as under pnpm", async () => {
    const project = join(dir, "project");
    const pkg = join(project, "node_modules", "@playwright", "test");
    await mkdir(pkg, { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@playwright/test", main: "index.js" }),
    );
    await writeFile(
      join(pkg, "index.js"),
      "module.exports = { chromium: { launch: async () => 'stub' } };",
    );
    await writeFile(join(project, "package.json"), "{}");
    const chromium = await loadChromium(join(project, ".rewindbug"));
    expect(await chromium?.launch(OFFLINE_LAUNCH)).toBe("stub");
  });
});

// a real recording of a real page, played back to the trigger in Chromium
describe("a real render", async () => {
  const chromium = await loadChromium(tmpdir());
  let browser: Awaited<ReturnType<Chromium["launch"]>> | undefined;
  try {
    browser = await chromium?.launch(OFFLINE_LAUNCH);
  } catch {
    browser = undefined;
  }
  afterAll(async () => {
    await browser?.close();
  });

  const css = (color: string): Answer => ({
    status: 200,
    body: `body { background: ${color}; }`,
    headers: { "content-type": "text/css" },
  });

  test.skipIf(!browser)(
    "the PNG has the viewport size; the stand's CSS loads, a redirect and other local hosts do not",
    async () => {
      if (!browser) throw new Error("no browser");
      const secret = await serve(() => css("rgb(0, 255, 0)"));
      const other = await serve(() => css("rgb(0, 0, 255)"));
      const stand = await serve((url) =>
        url === "/r.css"
          ? {
              status: 302,
              headers: { location: `http://127.0.0.1:${secret.port}/s.css` },
            }
          : css("rgb(255, 0, 0)"),
      );
      const record = readFileSync(
        fileURLToPath(
          new URL(
            "../../../node_modules/@rrweb/record/dist/record.umd.min.cjs",
            import.meta.url,
          ),
        ),
        "utf8",
      );
      const origin = `http://127.0.0.1:${stand.port}`;
      const recorder = browser as unknown as {
        newPage(o: object): Promise<{
          route(
            u: string,
            f: (r: { fulfill(o: object): Promise<void> }) => Promise<void>,
          ): Promise<void>;
          goto(u: string): Promise<void>;
          addScriptTag(o: { content: string }): Promise<void>;
          evaluate<T>(fn: string): Promise<T>;
          close(): Promise<void>;
        }>;
      };
      // record a page of the stand: its stylesheet, one that redirects into
      // another local service, and one on another local host
      const page = await recorder.newPage({
        viewport: { width: 640, height: 400 },
      });
      await page.route(`${origin}/page`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<link rel="stylesheet" href="${origin}/s.css"><link rel="stylesheet" href="${origin}/r.css"><link rel="stylesheet" href="http://localhost:${other.port}/o.css"><h1>Cart</h1>`,
        }),
      );
      await page.goto(`${origin}/page`);
      await page.addScriptTag({ content: record });
      const events = await page.evaluate<{ timestamp: number }[]>(
        `new Promise((done) => { const events = []; rrwebRecord.record({ emit: (e) => events.push(e), inlineStylesheet: false }); setTimeout(() => { document.querySelector("h1").textContent = "Cart: error"; setTimeout(() => done(events), 100); }, 100); })`,
      );
      await page.close();
      for (const server of [stand, secret, other]) server.hits.length = 0;
      const report = {
        ...fixture,
        trigger: {
          ...fixture.trigger,
          at: Math.max(...events.map((e) => e.timestamp)),
        },
        context: {
          ...fixture.context,
          url: `${origin}/page`,
          viewport: { width: 640, height: 400, dpr: 2 },
        },
        replay: { format: "rrweb", events },
      } as unknown as ReadReport;
      const png = await shoot(browser as never, report, { privateStand: true });
      if (!png) throw new Error("no picture");
      expect(isPng(png)).toBe(true);
      expect(pngSize(png)).toEqual({ width: 640, height: 400 });
      expect(stand.hits).toContain("/s.css");
      expect(stand.hits).toContain("/r.css");
      // the redirect led into another local service: never followed
      expect(secret.hits).toEqual([]);
      expect(other.hits).toEqual([]);
      // beyond loopback the same report draws nothing from the private stand
      stand.hits.length = 0;
      await shoot(browser as never, report, { privateStand: false });
      expect(stand.hits).toEqual([]);
    },
    30_000,
  );

  test.skipIf(!browser)(
    "a recording that names hundreds of hosts gets at most MAX_RESOURCES lookups",
    async () => {
      if (!browser) throw new Error("no browser");
      const t = fixture.trigger.at;
      const node = (id: number, tagName: string, attributes: object) => ({
        type: 2,
        id,
        tagName,
        attributes,
        childNodes: [],
      });
      const images = Array.from({ length: MAX_RESOURCES + 50 }, (_, i) =>
        node(100 + i, "img", { src: `https://h${i}.example.invalid/i.png` }),
      );
      const events = [
        {
          type: 4,
          timestamp: t,
          data: { href: "https://stand.example.dev/", width: 400, height: 300 },
        },
        {
          type: 2,
          timestamp: t + 1,
          data: {
            node: {
              type: 0,
              id: 1,
              childNodes: [
                {
                  type: 2,
                  id: 2,
                  tagName: "html",
                  attributes: {},
                  childNodes: [
                    {
                      type: 2,
                      id: 3,
                      tagName: "head",
                      attributes: {},
                      childNodes: [],
                    },
                    {
                      type: 2,
                      id: 4,
                      tagName: "body",
                      attributes: {},
                      childNodes: images,
                    },
                  ],
                },
              ],
            },
            initialOffset: { top: 0, left: 0 },
          },
        },
      ];
      const report = {
        ...fixture,
        context: { ...fixture.context, url: "https://stand.example.dev/" },
        trigger: { ...fixture.trigger, at: t + 1 },
        replay: { format: "rrweb", events },
      } as unknown as ReadReport;
      const resolve = vi.fn(async () => {
        throw new Error("ENOTFOUND");
      });
      await shoot(browser as never, report, { resolve });
      expect(resolve.mock.calls.length).toBeLessThanOrEqual(MAX_RESOURCES);
      expect(resolve.mock.calls.length).toBeGreaterThan(0);
    },
    30_000,
  );
});
