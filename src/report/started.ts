import type { UrlFilter } from "../shared/url-filter.ts";

// one beacon per document after a successful init: the receiver counts the
// pages rewindbug started on. Plain text keeps it a simple request with no
// preflight; a server without the path answers 404 and nobody looks
export const sendStarted = (endpoint: string, filter: UrlFilter): void => {
  try {
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/$/, "") + "/started";
    const body = JSON.stringify({
      host: location.hostname,
      path: new URL(filter(location.href)).pathname,
      sdk: __REWINDBUG_VERSION__,
    });
    navigator.sendBeacon(url.href, new Blob([body], { type: "text/plain" }));
  } catch {
    // a lost signal only means a page is not counted
  }
};
