import type { UrlFilter } from "../shared/url-filter.ts";
import type { RecordedEvent } from "./buffer.ts";

const META = 4;
const INCREMENTAL = 3;
const MUTATION_SOURCE = 0;
const MAX_URL_LENGTH = 2000;

type MetaData = { href?: unknown };
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
