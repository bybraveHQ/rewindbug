export type RecordedEvent = {
  type: number;
  timestamp: number;
  data?: unknown;
};

const META = 4;

// Two segments split at rrweb checkouts: the older one guarantees that the
// window still starts with Meta + FullSnapshot right after a fresh checkout.
export class SegmentBuffer {
  private previous: RecordedEvent[] = [];
  private current: RecordedEvent[] = [];

  constructor(private readonly maxEvents: number) {}

  // false: the current segment alone is over the cap, recording must stop
  push(event: RecordedEvent, isCheckout: boolean): boolean {
    if (isCheckout && event.type === META) {
      this.previous = this.current;
      this.current = [];
    }
    this.current.push(event);
    if (this.size <= this.maxEvents) return true;
    if (this.previous.length > 0) {
      this.previous = [];
      return this.current.length <= this.maxEvents;
    }
    return false;
  }

  get size(): number {
    return this.previous.length + this.current.length;
  }

  // events up to `until` inclusive, from the start of the older segment
  slice(until: number): RecordedEvent[] {
    const events: RecordedEvent[] = [];
    for (const segment of [this.previous, this.current]) {
      for (const event of segment) {
        if (event.timestamp > until) return events;
        events.push(event);
      }
    }
    return events;
  }

  clear(): void {
    this.previous = [];
    this.current = [];
  }
}
