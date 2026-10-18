import type { NetworkEntry, Trigger } from "../types.ts";

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RUN = /[0-9a-f]{8,}/gi;
const NUMBER = /\d+/g;
// numbers, uuids and long letter-digit runs (cuid, ObjectId, ULID, nanoid)
const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[a-z]*\d)(?=\d*[a-z])[0-9a-z]{16,})$/i;
const FILE_HASH = /[.-][0-9a-f]{8,}(?=[.\-/]|$)/gi;
const LINE_COL = /(:\d+){1,2}\)?$/;
const V8_FRAME = /^at\s/;
const DEDUP_WINDOW_MS = 60_000;
const MAX_REPORTS = 10;

export const fnv1a = (text: string): string => {
  let hash = FNV_OFFSET;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

export const normalizeText = (text: string): string =>
  text.replace(UUID, "x").replace(HEX_RUN, "x").replace(NUMBER, "0");

export const normalizePath = (pathname: string): string =>
  pathname
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

export const firstFrame = (stack: string | undefined): string => {
  if (!stack) return "";
  const lines = stack.split("\n").map((text) => text.trim());
  // only V8 starts the stack with the message line, which may hold a URL or
  // an @; Gecko and WebKit frames look like "fn@url" or "global code@url"
  const line = lines.some((text) => V8_FRAME.test(text))
    ? lines.find((text) => V8_FRAME.test(text))
    : lines.find((text) => text.includes("@"));
  if (!line) return "";
  return line
    .replace(LINE_COL, "")
    .replace(/\?[^\s)]*/, "")
    .replace(FILE_HASH, ".x");
};

export const fingerprintOf = (
  trigger: Trigger,
  pageUrl: string,
  request: NetworkEntry | undefined,
): string => {
  if (trigger.kind === "network") {
    // the entry left the ring buffer: the trigger message still names the call
    if (!request)
      return fnv1a([trigger.kind, normalizeText(trigger.message)].join("\n"));
    const status = request.status;
    const outcome =
      status !== undefined
        ? `${String(status).charAt(0)}xx`
        : (request.error ?? "");
    return fnv1a(
      [
        trigger.kind,
        request.method,
        normalizePath(pathOf(request.url)),
        outcome,
      ].join("\n"),
    );
  }
  return fnv1a(
    [
      trigger.kind,
      trigger.error?.name ?? "",
      normalizeText(trigger.message),
      firstFrame(trigger.error?.stack),
      normalizePath(pathOf(pageUrl)),
    ].join("\n"),
  );
};

// one fingerprint per minute and ten reports per page; deduped ones are free
export class ReportGate {
  private readonly lastSent = new Map<string, number>();
  private sent = 0;

  admit(fingerprint: string, at: number, dedup: boolean): boolean {
    if (dedup) {
      const last = this.lastSent.get(fingerprint);
      if (last !== undefined && at - last < DEDUP_WINDOW_MS) return false;
    }
    if (this.sent >= MAX_REPORTS) return false;
    this.sent += 1;
    if (dedup) this.lastSent.set(fingerprint, at);
    return true;
  }

  // a report that failed to build gives its slot and dedup window back;
  // one that beforeSend dropped keeps the window, so a loop is not rebuilt
  refund(fingerprint: string, keepWindow = false): void {
    this.sent -= 1;
    if (!keepWindow) this.lastSent.delete(fingerprint);
  }
}
