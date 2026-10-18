import {
  filterCssUrls,
  filterUrlsInText,
  type UrlFilter,
} from "../shared/url-filter.ts";
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
  id?: unknown;
  tagName?: unknown;
  attributes?: Record<string, unknown>;
  textContent?: unknown;
  childNodes?: unknown[];
};

// rrweb masks a field's value only when its live value is not empty: the
// value attribute the server rendered and the text of a textarea go in as is
// when the field was cleared, so every one passes the mask again here
export type InputMask = {
  // the value as the recording may keep it, for the node with this rrweb id:
  // a field, or a text node inside a textarea; any other node keeps it
  value: (id: number, value: string) => string;
  // its value attribute changing on every key tells how long it is and how
  // fast it was typed; the value itself comes in input events
  isPassword: (id: number) => boolean;
};

const FIELDS = new Set(["input", "textarea", "select"]);

const maskField = (node: SerializedNode, mask: InputMask): void => {
  if (typeof node.id !== "number" || !FIELDS.has(node.tagName as string))
    return;
  const id = node.id;
  const attributes = node.attributes;
  if (attributes && typeof attributes.value === "string")
    attributes.value = mask.value(id, attributes.value);
  if (node.tagName !== "textarea") return;
  for (const child of node.childNodes ?? []) {
    const text = child as SerializedNode | undefined;
    if (text && typeof text.textContent === "string")
      text.textContent = mask.value(id, text.textContent);
  }
};

// absolute urls anywhere in the text, relative ones inside css url(...)
const filterText = (text: string, filter: UrlFilter): string =>
  filterCssUrls(filterUrlsInText(text, filter), filter);

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
        if (typeof css === "string") style[property] = filterText(css, filter);
        // an !important value comes as [value, priority]
        else if (Array.isArray(css) && typeof css[0] === "string")
          css[0] = filterText(css[0], filter);
      }
      continue;
    }
    if (typeof value !== "string") continue;
    if (URL_ATTRIBUTES.has(name)) attributes[name] = filter(value);
    else if (URLS_IN_TEXT_ATTRIBUTES.has(name))
      attributes[name] = filterText(value, filter);
  }
};

// a loop, not recursion: a deep DOM must not overflow the stack
const filterTree = (
  root: unknown,
  filter: UrlFilter,
  mask: InputMask | undefined,
): void => {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as SerializedNode | undefined;
    if (!node || typeof node !== "object") continue;
    if (mask) maskField(node, mask);
    filterAttributes(node.attributes, filter);
    // text, including the css inside a <style>
    if (typeof node.textContent === "string")
      node.textContent = filterText(node.textContent, filter);
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
      if (typeof item === "string") record[key] = filterText(item, filter);
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

// mutates the event in place: rrweb hands it over and keeps no reference;
// false: nothing is left of it to record
export const sanitizeEvent = (
  event: RecordedEvent,
  filter: UrlFilter,
  mask?: InputMask,
): boolean => {
  if (event.type === FULL_SNAPSHOT) {
    filterTree(
      (event.data as { node?: unknown } | undefined)?.node,
      filter,
      mask,
    );
    return true;
  }
  if (event.type === INCREMENTAL) {
    const data = event.data as MutationData | undefined;
    if (CSS_SOURCES.has(data?.source as number)) {
      filterStrings(data, filter);
      return true;
    }
    if (data?.source !== MUTATION_SOURCE) return true;
    for (const add of data.adds ?? [])
      filterTree((add as { node?: unknown } | undefined)?.node, filter, mask);
    let dropped = false;
    data.attributes = (data.attributes ?? []).filter((item) => {
      const change = item as
        { id?: unknown; attributes?: Record<string, unknown> } | undefined;
      const attributes = change?.attributes;
      if (mask && attributes && typeof change.id === "number") {
        if (mask.isPassword(change.id) && "value" in attributes) {
          delete attributes.value;
          // an empty change on every key would still count the keys
          if (Object.keys(attributes).length === 0) {
            dropped = true;
            return false;
          }
        } else if (typeof attributes.value === "string")
          attributes.value = mask.value(change.id, attributes.value);
      }
      filterAttributes(attributes, filter);
      return true;
    });
    for (const change of data.texts ?? []) {
      const text = change as { id?: unknown; value?: unknown } | undefined;
      if (!text || typeof text.value !== "string") continue;
      // the text of a textarea a script changed
      const value =
        mask && typeof text.id === "number"
          ? mask.value(text.id, text.value)
          : text.value;
      text.value = filterText(value, filter);
    }
    return !dropped || mutationCount(event) > 0;
  }
  if (event.type !== META) return true;
  const data = event.data as MetaData | undefined;
  if (data && typeof data.href === "string") {
    data.href = filter(data.href).slice(0, MAX_URL_LENGTH);
  }
  return true;
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
