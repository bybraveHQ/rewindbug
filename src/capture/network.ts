import type { NetworkEntry, Trigger } from "../types.ts";
import type { RingBuffer } from "../shared/ring.ts";
import { truncate } from "../shared/serialize.ts";
import { resolveUrl, type UrlFilter } from "../shared/url-filter.ts";

const MAX_BODY_LENGTH = 10_000;
const MAX_URL_LENGTH = 2000;
const MAX_MESSAGE_LENGTH = 1000;
const TEXT_BODY =
  /^(application\/json|application\/x-www-form-urlencoded|text\/(?!event-stream))/i;
const XHR_OPENED = 1;

export type BodyRule = string | RegExp;

export type NetworkOptions = {
  endpoint: string;
  bodyAllowlist: readonly BodyRule[];
  filter: UrlFilter;
  trigger: (entry: NetworkEntry) => boolean;
  now: () => number;
  onTrigger: (trigger: Trigger) => void;
  onSettle?: ((id: number) => void) | undefined;
  // errors of failed fetches that already produced a network trigger
  reported: WeakSet<object>;
};

type XhrState = {
  method: string;
  url: URL | null;
  sent: boolean;
  entry: NetworkEntry | null;
  startedAt: number;
  withBody: boolean;
  ended: NetworkEntry["error"] | undefined;
};

const IP_HOST = /^(\d+\.){3}\d+$|:/;

// shortcut: one label off the page host stands in for the registrable domain;
// a public suffix list would cost more than the bundle budget allows
const sameSite = (host: string, page: string): boolean => {
  if (host === page) return true;
  if (IP_HOST.test(page)) return false;
  const labels = page.split(".");
  const base = labels.length > 2 ? labels.slice(1).join(".") : page;
  return host === base || host.endsWith(`.${base}`);
};

// a server error from any origin is a bug the page saw; a request that never
// got a response counts only on the page's own site, so a third-party script
// stopped by an ad blocker or a privacy extension is not one
export const defaultNetworkTrigger = (entry: NetworkEntry): boolean => {
  if (entry.status !== undefined && entry.status >= 500) return true;
  if (entry.error !== "network") return false;
  const url = resolveUrl(entry.url);
  const page = globalThis.location?.hostname;
  return url !== null && page !== undefined && sameSite(url.hostname, page);
};

const originPath = (url: URL) => url.origin + url.pathname;

const isRequestLike = (input: unknown): input is Request =>
  typeof input === "object" &&
  input !== null &&
  !(input instanceof URL) &&
  typeof (input as Request).url === "string" &&
  typeof (input as Request).method === "string";

const requestBodyText = (body: unknown): string | undefined => {
  const text =
    typeof body === "string"
      ? body
      : body instanceof URLSearchParams
        ? body.toString()
        : undefined;
  return text !== undefined && text.length <= MAX_BODY_LENGTH
    ? text
    : undefined;
};

const errorKind = (
  error: unknown,
  signal: AbortSignal | null | undefined,
): NonNullable<NetworkEntry["error"]> => {
  if (signal?.aborted) {
    return (signal.reason as { name?: unknown } | undefined)?.name ===
      "TimeoutError"
      ? "timeout"
      : "abort";
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError") return "abort";
  if (name === "TimeoutError") return "timeout";
  return "network";
};

export const installNetwork = (
  buffer: RingBuffer<NetworkEntry>,
  options: NetworkOptions,
): (() => void) => {
  const endpoint = resolveUrl(options.endpoint);
  const endpointKey = endpoint ? originPath(endpoint) : null;
  let nextId = 1;
  let active = true;

  const isOwn = (url: URL) =>
    endpointKey !== null && originPath(url) === endpointKey;

  const bodyAllowed = (url: URL) =>
    options.bodyAllowlist.some((rule) => {
      if (typeof rule !== "string") {
        rule.lastIndex = 0;
        return rule.test(url.href);
      }
      const key = originPath(url);
      return (
        key === rule || key.startsWith(rule.endsWith("/") ? rule : `${rule}/`)
      );
    });

  const open = (
    type: NetworkEntry["type"],
    method: string,
    url: URL,
  ): NetworkEntry => {
    const entry: NetworkEntry = {
      id: nextId++,
      t: options.now(),
      type,
      method: method.toUpperCase(),
      url: options.filter(url.href).slice(0, MAX_URL_LENGTH),
      state: "pending",
    };
    buffer.push(entry);
    return entry;
  };

  const settle = (entry: NetworkEntry, startedAt: number): boolean => {
    try {
      entry.durationMs = Math.round(performance.now() - startedAt);
      if (active) options.onSettle?.(entry.id);
    } catch {
      // a failing settle hook must never reach the host request
    }
    try {
      if (!active || !options.trigger(entry)) return false;
      const path = resolveUrl(entry.url)?.pathname ?? entry.url;
      options.onTrigger({
        kind: "network",
        at: options.now(),
        message: truncate(
          `${entry.method} ${path} → ${entry.status ?? entry.error ?? "unknown"}`,
          MAX_MESSAGE_LENGTH,
        ),
        requestId: entry.id,
      });
      return true;
    } catch {
      // a failing trigger callback must never reach the host request
      return false;
    }
  };

  const readBody = async (response: Response, entry: NetworkEntry) => {
    const type = response.headers.get("content-type");
    const length = Number(response.headers.get("content-length"));
    if (
      !type ||
      !TEXT_BODY.test(type) ||
      !(length > 0 && length <= MAX_BODY_LENGTH)
    )
      return;
    const text = await response.clone().text();
    entry.responseBody = text.slice(0, MAX_BODY_LENGTH);
  };

  const originalFetch = globalThis.fetch;
  let fetchWrapper: typeof fetch | null = null;
  if (typeof originalFetch === "function") {
    fetchWrapper = function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      let entry: NetworkEntry | null = null;
      let startedAt = 0;
      let withBody = false;
      let signal: AbortSignal | null | undefined;
      try {
        if (active) {
          const request = isRequestLike(input) ? input : null;
          const url = resolveUrl(request ? request.url : String(input));
          if (url && !isOwn(url)) {
            entry = open(
              "fetch",
              init?.method ?? request?.method ?? "GET",
              url,
            );
            startedAt = performance.now();
            signal = init?.signal ?? request?.signal;
            withBody = bodyAllowed(url);
            const body = withBody ? requestBodyText(init?.body) : undefined;
            if (body !== undefined) entry.requestBody = body;
          }
        }
      } catch {
        entry = null;
      }
      const result = originalFetch.call(this, input, init);
      if (!entry) return result;
      const tracked = entry;
      return result.then(
        async (response) => {
          try {
            tracked.state = "done";
            tracked.status = response.status;
            const type = response.headers.get("content-type");
            if (type) tracked.contentType = type;
            if (withBody)
              await readBody(response, tracked).catch(() => undefined);
          } catch {
            // tracking must never break the host request
          }
          settle(tracked, startedAt);
          return response;
        },
        (error: unknown) => {
          try {
            tracked.state = "failed";
            tracked.error = errorKind(error, signal);
          } catch {
            // tracking must never break the host request
          }
          if (
            settle(tracked, startedAt) &&
            typeof error === "object" &&
            error !== null
          ) {
            options.reported.add(error);
          }
          throw error;
        },
      );
    } as typeof fetch;
    try {
      globalThis.fetch = fetchWrapper;
    } catch {
      fetchWrapper = null;
    }
  }

  const proto = globalThis.XMLHttpRequest?.prototype;
  const originalOpen = proto?.open;
  const originalSend = proto?.send;
  const states = new WeakMap<XMLHttpRequest, XhrState>();
  let openWrapper: typeof XMLHttpRequest.prototype.open | null = null;
  let sendWrapper: typeof XMLHttpRequest.prototype.send | null = null;

  const finishXhr = (xhr: XMLHttpRequest, state: XhrState) => {
    const entry = state.entry;
    if (!entry || entry.state !== "pending") return;
    try {
      if (state.ended || xhr.status === 0) {
        entry.state = "failed";
        entry.error = state.ended ?? "network";
      } else {
        entry.state = "done";
        entry.status = xhr.status;
        const type = xhr.getResponseHeader("content-type");
        if (type) entry.contentType = type;
        const textual = xhr.responseType === "" || xhr.responseType === "text";
        if (state.withBody && textual && type && TEXT_BODY.test(type)) {
          entry.responseBody = xhr.responseText.slice(0, MAX_BODY_LENGTH);
        }
      }
    } catch {
      // tracking must never break the host request
    }
    settle(entry, state.startedAt);
  };

  const listen = (xhr: XMLHttpRequest) => {
    const mark = (kind: NonNullable<NetworkEntry["error"]>) => () => {
      const state = states.get(xhr);
      if (state) state.ended = kind;
    };
    xhr.addEventListener("abort", mark("abort"));
    xhr.addEventListener("timeout", mark("timeout"));
    xhr.addEventListener("error", mark("network"));
    xhr.addEventListener("loadend", () => {
      const state = states.get(xhr);
      if (state) finishXhr(xhr, state);
    });
  };

  if (proto && originalOpen && originalSend) {
    openWrapper = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      const result = (originalOpen as (...args: unknown[]) => void).call(
        this,
        method,
        url,
        ...rest,
      );
      try {
        const previous = states.get(this);
        if (previous?.entry?.state === "pending") {
          previous.ended = "abort";
          finishXhr(this, previous);
        }
        if (!previous) listen(this);
        states.set(this, {
          method,
          url: resolveUrl(String(url)),
          sent: false,
          entry: null,
          startedAt: 0,
          withBody: false,
          ended: undefined,
        });
      } catch {
        // tracking must never break the host request
      }
      return result;
    } as typeof XMLHttpRequest.prototype.open;
    sendWrapper = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      const state = states.get(this);
      let tracked = false;
      try {
        if (
          active &&
          state?.url &&
          !state.sent &&
          this.readyState === XHR_OPENED &&
          !isOwn(state.url)
        ) {
          state.sent = true;
          state.entry = open("xhr", state.method, state.url);
          state.startedAt = performance.now();
          state.withBody = bodyAllowed(state.url);
          const requestBody = state.withBody
            ? requestBodyText(body)
            : undefined;
          if (requestBody !== undefined) state.entry.requestBody = requestBody;
          tracked = true;
        }
      } catch {
        tracked = false;
      }
      try {
        return originalSend.call(this, body);
      } catch (error) {
        if (tracked && state) {
          state.ended = errorKind(error, null);
          finishXhr(this, state);
        }
        throw error;
      }
    };
    try {
      proto.open = openWrapper;
      proto.send = sendWrapper;
    } catch {
      openWrapper = null;
      sendWrapper = null;
    }
  }

  return () => {
    active = false;
    if (fetchWrapper && globalThis.fetch === fetchWrapper)
      globalThis.fetch = originalFetch;
    if (proto && originalOpen && proto.open === openWrapper)
      proto.open = originalOpen;
    if (proto && originalSend && proto.send === sendWrapper)
      proto.send = originalSend;
  };
};
