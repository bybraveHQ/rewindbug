export type UrlFilter = (url: string) => string;

const SECRET_PARAM =
  /^(.*[_-])?(token|key|secret|pass(word)?|auth|session|code|sig(nature)?|jwt|otp)$/i;
const MASK = "*";
const URL_IN_TEXT = /https?:\/\/[^\s"'<>()\\]+/gi;
const LINE_COL_TAIL = /(:\d+){1,2}$/;
const FALLBACK_BASE = "http://localhost/";

export const pageBase = (): string =>
  globalThis.document?.baseURI ?? globalThis.location?.href ?? FALLBACK_BASE;

export const resolveUrl = (raw: string): URL | null => {
  try {
    return new URL(raw, pageBase());
  } catch {
    return null;
  }
};

export const defaultUrlFilter: UrlFilter = (raw) => {
  const url = resolveUrl(raw);
  if (!url) return raw;
  url.username = "";
  url.password = "";
  for (const name of new Set(url.searchParams.keys())) {
    if (SECRET_PARAM.test(name)) url.searchParams.set(name, MASK);
  }
  if (url.hash.includes("=")) url.hash = "";
  return url.href;
};

export const filterUrlsInText = (text: string, filter: UrlFilter): string =>
  text.replace(URL_IN_TEXT, (match) => {
    const tail = LINE_COL_TAIL.exec(match)?.[0] ?? "";
    const head = tail ? match.slice(0, -tail.length) : match;
    return filter(head) + tail;
  });
