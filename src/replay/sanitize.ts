import { filterUrlsInText, type UrlFilter } from "../shared/url-filter.ts";
import type { RecordedEvent } from "./buffer.ts";

const META = 4;
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
// rrweb makes these absolute, so even href="#main" carries the page's own
// address with its query: they pass the url filter like the page url does
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "srcset",
  "xlink:href",
  "action",
  "formaction",
  "poster",
  "data",
]);
const MUTATION_SOURCE = 0;
const MAX_URL_LENGTH = 2000;

type MetaData = { href?: unknown };
type SerializedNode = {
  attributes?: Record<string, unknown>;
  childNodes?: unknown[];
};

const filterAttributes = (
  attributes: Record<string, unknown> | undefined,
  filter: UrlFilter,
): void => {
  if (!attributes) return;
  for (const name in attributes) {
    const value = attributes[name];
    if (URL_ATTRIBUTES.has(name) && typeof value === "string")
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
    if (Array.isArray(node.childNodes)) stack.push(...node.childNodes);
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
    if (data?.source !== MUTATION_SOURCE) return;
    for (const add of data.adds ?? [])
      filterTree((add as { node?: unknown } | undefined)?.node, filter);
    for (const change of data.attributes ?? [])
      filterAttributes(
        (change as { attributes?: Record<string, unknown> } | undefined)
          ?.attributes,
        filter,
      );
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
