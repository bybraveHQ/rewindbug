import { readFile, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { startServer } from "./server.ts";

const RUNS = 5;
const CPU_THROTTLE = 4;
const SETTLE_MS = 1000;
const CANVAS_WATCH_MS = 3000;
const LONG_TASK_MS = 50;
const EVENT_THRESHOLD_MS = 16;
const MB = 1024 * 1024;
const BASELINE = new URL("baseline.json", import.meta.url);

const BUDGETS = { inp: 10, tbt: 50, heapMb: 10 } as const;
const KIB = 1024;
const REPORT_TIMEOUT_MS = 30_000;

type Metrics = { inp: number; tbt: number; heapMb: number };
// rrweb = bare @rrweb/record with the package's options: the floor we only
// track; budgets apply to the delta between the package and that floor
type Variant = "without" | "rrweb" | "with";
type PageResult = Record<Variant, Metrics> & { noise: Metrics };
const VARIANTS: readonly Variant[] = ["without", "rrweb", "with"];
type Baseline = {
  date: string;
  chromium: string;
  cpuThrottle: number;
  runs: number;
  results: Record<string, PageResult>;
};

const VARIANT_SCRIPT: Record<Variant, string> = {
  without: "",
  rrweb: 'import "/dist/rrweb-floor.js";',
  with: 'import * as rb from "/dist/index.js"; rb.init?.({ endpoint: location.origin + "/__sink" });',
};

// --report: the package with its api on window, so the bench can capture
const REPORT_SCRIPT =
  'import * as rb from "/dist/index.js"; rb.init?.({ endpoint: location.origin + "/__sink" }); window.__rb = rb;';

const OBSERVERS = `
  window.__bench = { longTasks: [], events: [], mark: 0 };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__bench.longTasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.interactionId) window.__bench.events.push({ start: e.startTime, duration: e.duration });
    }
  }).observe({ type: "event", buffered: true, durationThreshold: ${EVENT_THRESHOLD_MS} });
`;

const SCENARIOS: Record<string, (page: Page) => Promise<void>> = {
  table: async (page) => {
    for (let i = 0; i < 3; i++) await page.click("#rerender");
    for (let i = 0; i < 2; i++) await page.click("#sort");
  },
  canvas: async (page) => {
    for (let i = 0; i < 3; i++) await page.click("#burst");
    await page.waitForTimeout(CANVAS_WATCH_MS);
  },
  form: async (page) => {
    const fields = await page.locator(".field").all();
    for (const field of fields.slice(0, 20)) {
      const tag = await field.evaluate((el) => el.tagName);
      if (tag === "SELECT") await field.selectOption("b");
      else await field.pressSequentially("hello");
    }
  },
  spa: async (page) => {
    for (const n of ["2", "3", "1"]) {
      await page.click(`a[data-page="${n}"]`);
      await page.waitForSelector(`text=Page ${n} item 0`);
    }
    await page.click("#modal-toggle");
    await page.click("#modal-toggle");
    await page.goBack();
  },
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const measureOnce = async (
  browser: Browser,
  origin: string,
  name: string,
  variant: Variant,
): Promise<Metrics> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/__variant.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: VARIANT_SCRIPT[variant],
    }),
  );
  await page.addInitScript(OBSERVERS);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  await cdp.send("Performance.enable");

  await page.goto(`${origin}/${name}.html`, { waitUntil: "load" });
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate(() => {
    (window as unknown as { __bench: { mark: number } }).__bench.mark =
      performance.now();
  });
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown bench page: ${name}`);
  await scenario(page);
  await page.waitForTimeout(SETTLE_MS);

  const { tbt, inp } = await page.evaluate((longTaskMs) => {
    const b = (
      window as unknown as {
        __bench: {
          mark: number;
          longTasks: { start: number; duration: number }[];
          events: { start: number; duration: number }[];
        };
      }
    ).__bench;
    const tasks = b.longTasks.filter((t) => t.start >= b.mark);
    const events = b.events.filter((e) => e.start >= b.mark);
    return {
      tbt: tasks.reduce(
        (sum, t) => sum + Math.max(0, t.duration - longTaskMs),
        0,
      ),
      inp: events.reduce((max, e) => Math.max(max, e.duration), 0),
    };
  }, LONG_TASK_MS);

  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const heap = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
  await context.close();
  return { inp, tbt, heapMb: heap / MB };
};

const measurePage = async (
  browser: Browser,
  origin: string,
  name: string,
): Promise<PageResult> => {
  const samples: Record<Variant, Metrics[]> = {
    without: [],
    rrweb: [],
    with: [],
  };
  for (let run = 0; run < RUNS; run++) {
    const order = run % 2 === 0 ? VARIANTS : [...VARIANTS].reverse();
    for (const variant of order)
      samples[variant].push(await measureOnce(browser, origin, name, variant));
  }
  const pick = (variant: Variant): Metrics => ({
    inp: median(samples[variant].map((m) => m.inp)),
    tbt: median(samples[variant].map((m) => m.tbt)),
    heapMb: median(samples[variant].map((m) => m.heapMb)),
  });
  const spread = (key: keyof Metrics) => {
    const values = samples.without.map((m) => m[key]);
    return Math.max(...values) - Math.min(...values);
  };
  return {
    without: pick("without"),
    rrweb: pick("rrweb"),
    with: pick("with"),
    noise: { inp: spread("inp"), tbt: spread("tbt"), heapMb: spread("heapMb") },
  };
};

type ReportMetrics = {
  kib: number;
  longestMs: number;
  tbt: number;
  sendMs: number;
};

// one capture() after the page scenario: compressed size of the posted
// report, long tasks while it was built, and time from the call to the post
const measureReportOnce = async (
  browser: Browser,
  origin: string,
  name: string,
): Promise<ReportMetrics> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/__variant.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: REPORT_SCRIPT }),
  );
  let posted: { bytes: number; at: number } | undefined;
  await page.route("**/__sink", async (route) => {
    posted = {
      bytes: route.request().postDataBuffer()?.length ?? 0,
      at: await page.evaluate(() => performance.now()),
    };
    await route.fulfill({ status: 204 });
  });
  await page.addInitScript(OBSERVERS);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });

  await page.goto(`${origin}/${name}.html`, { waitUntil: "load" });
  await page.waitForTimeout(SETTLE_MS);
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown bench page: ${name}`);
  await scenario(page);
  await page.waitForTimeout(SETTLE_MS);
  const start = await page.evaluate(() => {
    const w = window as unknown as {
      __bench: { mark: number };
      __rb: { capture: (error?: unknown) => void };
    };
    w.__bench.mark = performance.now();
    w.__rb.capture(new Error("bench report"));
    return w.__bench.mark;
  });
  const deadline = Date.now() + REPORT_TIMEOUT_MS;
  while (!posted && Date.now() < deadline) await page.waitForTimeout(50);
  if (!posted) throw new Error(`${name}: no report posted`);
  const done = posted;
  const tasks = await page.evaluate(
    (end) =>
      (
        window as unknown as {
          __bench: {
            mark: number;
            longTasks: { start: number; duration: number }[];
          };
        }
      ).__bench.longTasks.filter(
        (t) =>
          t.start >=
            (window as unknown as { __bench: { mark: number } }).__bench.mark &&
          t.start <= end,
      ),
    done.at,
  );
  await context.close();
  return {
    kib: done.bytes / KIB,
    longestMs: tasks.reduce((max, t) => Math.max(max, t.duration), 0),
    tbt: tasks.reduce(
      (sum, t) => sum + Math.max(0, t.duration - LONG_TASK_MS),
      0,
    ),
    sendMs: done.at - start,
  };
};

const measureReport = async (
  browser: Browser,
  origin: string,
  names: string[],
) => {
  const lines = [
    "page    report KiB  longest task ms  TBT ms  capture→post ms",
    `(median of ${RUNS} runs, CPU ×${CPU_THROTTLE})`,
  ];
  for (const name of names) {
    const runs: ReportMetrics[] = [];
    for (let run = 0; run < RUNS; run++)
      runs.push(await measureReportOnce(browser, origin, name));
    const m = (key: keyof ReportMetrics) => median(runs.map((r) => r[key]));
    lines.push(
      `${name.padEnd(8)}${fmt(m("kib"))}   ${fmt(m("longestMs"))}        ${fmt(m("tbt"))}  ${fmt(m("sendMs"))}`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
};

const fmt = (n: number) => n.toFixed(1).padStart(8);

const report = (
  results: Record<string, PageResult>,
  baseline: Baseline | null,
) => {
  let overBudget = false;
  const lines = [
    "page    metric   without     rrweb      with     floor      ours     noise    budget  base-ours",
    "(floor = rrweb − without, tracked only; ours = with − rrweb, checked against budget;",
    " ! = ours above both budget and noise; noise = max-min of runs without package)",
  ];
  for (const [name, r] of Object.entries(results)) {
    for (const key of Object.keys(BUDGETS) as (keyof typeof BUDGETS)[]) {
      const floor = r.rrweb[key] - r.without[key];
      const ours = r.with[key] - r.rrweb[key];
      const ok = ours <= Math.max(BUDGETS[key], r.noise[key]);
      overBudget ||= !ok;
      const base = baseline?.results[name];
      // a baseline from before the rrweb variant has no floor to compare with
      const baseOurs = base?.rrweb
        ? fmt(base.with[key] - base.rrweb[key])
        : "       -";
      lines.push(
        `${name.padEnd(8)}${key.padEnd(8)}${fmt(r.without[key])}  ${fmt(r.rrweb[key])}  ${fmt(r.with[key])}  ${fmt(floor)}  ${fmt(ours)}  ${fmt(r.noise[key])}  ${fmt(BUDGETS[key])}${ok ? " " : "!"} ${baseOurs}`,
      );
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return overBudget;
};

const main = async () => {
  const updateBaseline = process.argv.includes("--update-baseline");
  const only = process.argv
    .find((a) => a.startsWith("--page="))
    ?.slice("--page=".length);
  const names = Object.keys(SCENARIOS).filter((n) => !only || n === only);

  const { server, origin } = await startServer();
  const browser = await chromium.launch();
  try {
    if (process.argv.includes("--report")) {
      await measureReport(browser, origin, names);
      return;
    }
    const results: Record<string, PageResult> = {};
    for (const name of names)
      results[name] = await measurePage(browser, origin, name);

    const baseline = await readFile(BASELINE, "utf8")
      .then((text) => JSON.parse(text) as Baseline)
      .catch(() => null);
    const overBudget = report(results, baseline);

    if (updateBaseline) {
      const next: Baseline = {
        date: new Date().toISOString().slice(0, 10),
        chromium: browser.version(),
        cpuThrottle: CPU_THROTTLE,
        runs: RUNS,
        results: { ...baseline?.results, ...results },
      };
      await writeFile(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
      process.stdout.write(`baseline written: ${BASELINE.pathname}\n`);
    }
    process.exitCode = overBudget ? 1 : 0;
  } finally {
    await browser.close();
    server.close();
  }
};

await main();
