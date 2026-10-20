export type UrlFilter = (url: string) => string;

// a ; before the name: html-escaped text splits ?a=1&amp;token=S at & only
const SECRET_PARAM =
  /^(.*[_;-])?(token|key|secret|pass(word)?|auth|session|code|sig(nature)?|jwt|otp)$/i;
const MASK = "*";
// ws(s) too: realtime clients put tokens in the query of their socket url
// parentheses may sit inside a url: one the url did not open is cut below;
// an apostrophe too (Mary's.jpg), unless it closes a quote around the url
const URL_IN_TEXT = /(?:https?|wss?):\/\/(?:[^\s"'<>\\]|'(?![\s),.;\]}]|$))+/gi;
// css url(...) the page wrote relative or protocol-relative: rrweb keeps
// such urls as written in CSSOM events and style changes
const CSS_URL = /url\(\s*(['"]?)([^'"()\s]+)\1\s*\)/gi;
// a scheme goes to the text filter, #id names an element of the page itself
const NOT_RELATIVE = /^([a-z][\w+.-]*:|#)/i;
const LINE_COL_TAIL = /(:\d+){1,2}$/;
const FALLBACK_BASE = "http://localhost/";
// for a url the parser refuses: browsers quote exactly such urls in errors
const USERINFO = /^([a-z][\w+.-]*:\/\/)[^/?#@\s]*@/i;
// a value ends at ? too: next=/x?token=S holds a pair of its own
const PAIR = /([?&#;])([^=&#?;\s]+)=([^&#;?\s]*)/g;
// a longer url is cut before anything else: page text can be any length,
// and what lies past the cut is dropped rather than scanned (fails closed)
const MAX_URL_CHARS = 8192;

const maskPairs = (text: string): string =>
  text.replace(PAIR, (pair, lead: string, name: string) =>
    SECRET_PARAM.test(name) ? `${lead}${name}=${MASK}` : pair,
  );

// a secret inside another parameter's value: a redirect target, a nested
// url, a ; separated pair. The scan is flat, so any depth is covered
const maskValue = (value: string): string =>
  value.includes("=") ? maskPairs(`?${value}`).slice(1) : value;

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
  const text = raw.length > MAX_URL_CHARS ? raw.slice(0, MAX_URL_CHARS) : raw;
  const url = resolveUrl(text);
  // fails closed: secrets are masked by pattern when the parser gives up
  if (!url) return maskPairs(text.replace(USERINFO, "$1"));
  url.username = "";
  url.password = "";
  // one pass over the query and one serialization: set() per parameter
  // re-serialized the whole query each time, quadratic on a long url
  let changed = false;
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    if (SECRET_PARAM.test(name)) {
      changed = true;
      if (!seen.has(name)) pairs.push([name, MASK]);
      seen.add(name);
      continue;
    }
    const masked = maskValue(value);
    if (masked !== value) changed = true;
    pairs.push([name, masked]);
  }
  if (changed) url.search = new URLSearchParams(pairs).toString();
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

export const filterCssUrls = (css: string, filter: UrlFilter): string =>
  css.replace(CSS_URL, (whole, quote: string, url: string) =>
    NOT_RELATIVE.test(url) ? whole : `url(${quote}${filter(url)}${quote})`,
  );
