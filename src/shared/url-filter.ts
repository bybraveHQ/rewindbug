export type UrlFilter = (url: string) => string;

const SECRET_PARAM =
  /^(.*[_-])?(token|key|secret|pass(word)?|auth|session|code|sig(nature)?|jwt|otp)$/i;
const MASK = "*";
// ws(s) too: realtime clients put tokens in the query of their socket url
// parentheses may sit inside a url: one the url did not open is cut below
const URL_IN_TEXT = /(?:https?|wss?):\/\/[^\s"'<>\\]+/gi;
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
    // a closing parenthesis the url did not open ends a stack frame or a
    // css url(...): it belongs to the text around the url
    let end = match.length;
    const open = match.split("(").length - 1;
    let close = match.split(")").length - 1;
    while (close > open && match[end - 1] === ")") {
      end -= 1;
      close -= 1;
    }
    const url = match.slice(0, end);
    const tail = LINE_COL_TAIL.exec(url)?.[0] ?? "";
    const head = tail ? url.slice(0, -tail.length) : url;
    return filter(head) + tail + match.slice(end);
  });
