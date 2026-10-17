import { Replayer } from "@rrweb/replay";
import "@rrweb/replay/dist/style.css";
import { init, type Report } from "../src/index.ts";
import { CART, CLAIM, type Item } from "./shared.ts";

const CHECKOUT = "checkout";
const BUTTONS = ["checkout", "coupon", "address", "pay", "back"];
const CLAIM_TIMEOUT_MS = 3000;

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing`);
  return element as T;
};

const status = byId("status");

// the screen lives in the query: a plain static host serves it on reload,
// and the generated test can goto it directly
const showScreen = () => {
  const checkout =
    new URL(location.href).searchParams.get("screen") === CHECKOUT;
  byId("cart").hidden = checkout;
  byId("details").hidden = !checkout;
};

const go = (screen: string | null) => {
  const url = new URL(location.href);
  if (screen) url.searchParams.set("screen", screen);
  else url.searchParams.delete("screen");
  history.pushState(null, "", url);
  showScreen();
};

const loadCart = async () => {
  const response = await fetch("./api/cart");
  const { items } = (await response.json()) as { items: Item[] };
  byId("items").replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("li");
      row.textContent = `${item.name}, $${item.price}`;
      return row;
    }),
  );
};

type Coupon = { discount: { percent: number } };

// the bugs are on purpose: each one is a different trigger
const applyCoupon = () => {
  // the config lost WELCOME's discount, the type still promises one
  const coupons = JSON.parse('{"WELCOME":{}}') as Record<string, Coupon>;
  const code = document.querySelector<HTMLInputElement>("[name=coupon]")?.value;
  const coupon = coupons[code?.toUpperCase() ?? ""] ?? coupons.WELCOME;
  status.textContent = `Discount ${coupon?.discount.percent}%`;
};

const saveAddress = () => {
  console.error("Address service is unavailable: cannot save the address");
};

const pay = async () => {
  const response = await fetch("./api/pay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ total: CART.reduce((sum, i) => sum + i.price, 0) }),
  });
  status.textContent = response.ok
    ? "Paid"
    : `Payment failed: ${response.status}`;
};

const lines = (rows: string[]) => rows.join("\n") || "(empty)";

// a custom urlFilter may leave a relative or placeholder url; a throw here
// would become a bug report of its own
const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

type ReplayEvents = ConstructorParameters<typeof Replayer>[0];

let player: Replayer | undefined;

// the recording is drawn at the size of the recorded viewport and scaled
// down to the panel
const showReplay = (report: Report) => {
  player?.destroy();
  player = undefined;
  const box = byId("replay");
  const again = byId<HTMLButtonElement>("replay-again");
  const events = report.replay?.events ?? [];
  if (events.length < 2) {
    box.textContent = `No recording: ${report.limits.replayState ?? "off"}`;
    box.style.height = "";
    again.hidden = true;
    return;
  }
  const stage = document.createElement("div");
  stage.className = "replay-stage";
  box.replaceChildren(stage);
  const next = new Replayer(events as ReplayEvents, {
    root: stage,
    mouseTail: false,
    showWarning: false,
  });
  const fit = ({ width, height }: { width: number; height: number }) => {
    const scale = Math.min(1, box.clientWidth / width);
    stage.style.transform = `scale(${scale})`;
    box.style.height = `${Math.ceil(height * scale)}px`;
  };
  next.on("resize", (size) => fit(size as { width: number; height: number }));
  next.play();
  player = next;
  again.hidden = false;
};

const showReport = (report: Report) => {
  byId("empty").hidden = true;
  byId("report").hidden = false;
  byId("headline").textContent =
    `${report.trigger.kind}: ${report.trigger.message}`;
  byId("steps").textContent = report.stepsMarkdown;
  byId("test").textContent = report.test;
  showReplay(report);
  byId("console").textContent = lines(
    report.console.map((entry) => `${entry.level}: ${entry.message}`),
  );
  // bodies are in the report only for urls in bodyAllowlist
  byId("network").textContent = lines(
    report.network.map((entry) =>
      [
        `${entry.method} ${pathOf(entry.url)} ${entry.status ?? entry.error ?? "pending"}${entry.durationMs === undefined ? "" : ` (${entry.durationMs} ms)`}`,
        entry.requestBody === undefined ? "" : `  sent: ${entry.requestBody}`,
        entry.responseBody === undefined
          ? ""
          : `  received: ${entry.responseBody}`,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  );
  const link = byId<HTMLAnchorElement>("download");
  // the same name the receivers use: time of the report, then its id
  link.download = `${new Date(report.createdAt).toISOString().replace(/[-:.]/g, "")}-${report.id}.json`;
  URL.revokeObjectURL(link.href);
  link.href = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  status.textContent = `Report ${report.id} received`;
};

// a fresh worker claims the page on activate; after a hard reload the
// worker is already active and nothing would claim it, so the page asks
const takeControl = async (): Promise<boolean> => {
  const { serviceWorker } = navigator;
  if (serviceWorker.controller) return true;
  const changed = new Promise<boolean>((done) =>
    serviceWorker.addEventListener("controllerchange", () => done(true), {
      once: true,
    }),
  );
  (await serviceWorker.ready).active?.postMessage(CLAIM);
  const timeout = new Promise<boolean>((done) =>
    setTimeout(() => done(false), CLAIM_TIMEOUT_MS),
  );
  return Promise.race([changed, timeout]);
};

const start = async () => {
  showScreen();
  addEventListener("popstate", showScreen);
  if (!("serviceWorker" in navigator)) {
    status.textContent =
      "This browser has no service workers: the demo cannot run.";
    return;
  }
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    showReport(event.data as Report);
  });
  await navigator.serviceWorker.register("./sw.js");
  // without the worker the endpoint and the API would not answer
  if (!(await takeControl())) {
    status.textContent =
      "The service worker did not take this page. Reload it.";
    return;
  }
  // console.error is off as a trigger by default: libraries are noisy there.
  // Here it is the bug
  // bodies are off by default; the demo's own api has no secrets in them
  init({
    endpoint: new URL("./report", location.href).href,
    consoleErrorTrigger: true,
    bodyAllowlist: [new URL("./api", location.href).href],
  });
  await loadCart();
  byId("checkout").addEventListener("click", () => go(CHECKOUT));
  byId("back").addEventListener("click", () => go(null));
  byId("coupon").addEventListener("click", applyCoupon);
  byId("address").addEventListener("click", saveAddress);
  byId("pay").addEventListener("click", () => void pay());
  byId("replay-again").addEventListener("click", () => player?.play(0));
  for (const id of BUTTONS) byId<HTMLButtonElement>(id).disabled = false;
  status.textContent = "Ready. Click around, then break something.";
};

start().catch((error: unknown) => {
  status.textContent = `The demo failed to start: ${(error as Error).message}`;
});
