/// <reference lib="webworker" />
import { CART, CLAIM } from "./shared.ts";

// the demo's endpoint and API: a static host cannot answer a POST, the
// worker does it inside the browser

declare const self: ServiceWorkerGlobalScope;

const GZIP_MAGIC = [0x1f, 0x8b];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const text = async (request: Request): Promise<string> => {
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw[0] !== GZIP_MAGIC[0] || raw[1] !== GZIP_MAGIC[1])
    return new TextDecoder().decode(raw);
  const inflated = new Blob([raw])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(inflated).text();
};

// the report goes back to the tab that sent it; a beacon from a closed tab
// has nobody to show it to
const receive = async (event: FetchEvent): Promise<Response> => {
  let report: unknown;
  try {
    report = JSON.parse(await text(event.request));
  } catch {
    return new Response(null, { status: 400 });
  }
  const client = await self.clients.get(event.clientId);
  client?.postMessage(report);
  return new Response(null, { status: 204 });
};

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// a hard reload leaves the page uncontrolled while the worker is already
// active: no activate comes, so the page asks to be claimed
self.addEventListener("message", (event) => {
  if (event.data === CLAIM) event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const base = new URL(self.registration.scope);
  const url = new URL(event.request.url);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
    return;
  const path = url.pathname.slice(base.pathname.length);
  const method = event.request.method;
  if (path === "report" && method === "POST") event.respondWith(receive(event));
  else if (path === "api/cart" && method === "GET")
    event.respondWith(json(200, { items: CART }));
  else if (path === "api/pay" && method === "POST")
    event.respondWith(json(500, { error: "payment provider timed out" }));
});
