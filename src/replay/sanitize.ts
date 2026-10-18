import { filterUrlsInText, type UrlFilter } from "../shared/url-filter.ts";
import type { RecordedEvent } from "./buffer.ts";

const META = 4;
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
// one url each: rrweb makes most absolute, so even href="#main" carries the
// page's own address with its query, but leaves some relative; all pass the
// url filter like the page url does
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "rr_src",
  "xlink:href",
  "action",
  "formaction",
  "poster",
  "data",
]);
// text with absolute urls inside: a source list, inline css with url(...)
const URLS_IN_TEXT_ATTRIBUTES = new Set(["srcset", "style", "_cssText"]);
const MUTATION_SOURCE = 0;
// css the page sets through the CSSOM: inserted rules and replace(),
// setProperty(), adopted stylesheets
const CSS_SOURCES = new Set([8, 13, 15]);
const MAX_URL_LENGTH = 2000;

type MetaData = { href?: unknown };
type SerializedNode = {
  attributes?: Record<string, unknown>;
  textContent?: unknown;
  childNodes?: unknown[];
};

const filterAttributes = (
  attributes: Record<string, unknown> | undefined,
  filter: UrlFilter,
): void => {
  if (!attributes) return;
  for (const name in attributes) {
    const value = attributes[name];
    // a style change comes as an object of properties
    if (name === "style" && value && typeof value === "object") {
      const style = value as Record<string, unknown>;
      for (const property in style) {
        const css = style[property];
        if (typeof css === "string")
          style[property] = filterUrlsInText(css, filter);
        // an !important value comes as [value, priority]
        else if (Array.isArray(css) && typeof css[0] === "string")
          css[0] = filterUrlsInText(css[0], filter);
      }
      continue;
    }
    if (typeof value !== "string") continue;
    if (URL_ATTRIBUTES.has(name)) attributes[name] = filter(value);
    else if (URLS_IN_TEXT_ATTRIBUTES.has(name))
      attributes[name] = filterUrlsInText(value, filter);
  }
};

// a loop, not recursion: a deep DOM must not overflow the stack
const filterTree = (root: unknown, filter: UrlFilter): void => {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as SerializedNode | undefined;
    if (!node || typeof node !== "object") continue;
    filterAttributes(node.attributes, filter);
    // text, including the css inside a <style>
    if (typeof node.textContent === "string")
      node.textContent = filterUrlsInText(node.textContent, filter);
    if (Array.isArray(node.childNodes)) stack.push(...node.childNodes);
  }
};
// every string of a css event: its fields differ by source and rrweb version
const filterStrings = (root: unknown, filter: UrlFilter): void => {
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    for (const key in record) {
      const item = record[key];
      if (typeof item === "string")
        record[key] = filterUrlsInText(item, filter);
      else stack.push(item);
    }
  }
};

type MutationData = {
  source?: unknown;
  adds?: unknown[];
  removes?: unknown[];
  attributes?: unknown[];
  texts?: unknown[];
};

// mutates the event in place: rrweb hands it over and keeps no reference
export const sanitizeEvent = (
  event: RecordedEvent,
  filter: UrlFilter,
): void => {
  if (event.type === FULL_SNAPSHOT) {
    filterTree((event.data as { node?: unknown } | undefined)?.node, filter);
    return;
  }
  if (event.type === INCREMENTAL) {
    const data = event.data as MutationData | undefined;
    if (CSS_SOURCES.has(data?.source as number)) {
      filterStrings(data, filter);
      return;
    }
    if (data?.source !== MUTATION_SOURCE) return;
    for (const add of data.adds ?? [])
      filterTree((add as { node?: unknown } | undefined)?.node, filter);
    for (const change of data.attributes ?? [])
      filterAttributes(
        (change as { attributes?: Record<string, unknown> } | undefined)
          ?.attributes,
        filter,
      );
    for (const change of data.texts ?? []) {
      const text = change as { value?: unknown } | undefined;
      if (text && typeof text.value === "string")
        text.value = filterUrlsInText(text.value, filter);
    }
    return;
  }
  if (event.type !== META) return;
  const data = event.data as MetaData | undefined;
  if (data && typeof data.href === "string") {
    data.href = filter(data.href).slice(0, MAX_URL_LENGTH);
  }
};

export const mutationCount = (event: RecordedEvent): number => {
  if (event.type !== INCREMENTAL) return 0;
  const data = event.data as MutationData | undefined;
  if (data?.source !== MUTATION_SOURCE) return 0;
  return (
    (data.adds?.length ?? 0) +
    (data.removes?.length ?? 0) +
    (data.attributes?.length ?? 0) +
    (data.texts?.length ?? 0)
  );
};

export class MutationRate {
  private windowStart = -Infinity;
  private count = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  // true: more than `limit` mutations inside one window
  exceeded(count: number, at: number): boolean {
    if (count === 0) return false;
    if (at - this.windowStart >= this.windowMs) {
      this.windowStart = at;
      this.count = 0;
    }
    this.count += count;
    return this.count > this.limit;
  }
}
