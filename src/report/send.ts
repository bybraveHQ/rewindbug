import type { Report } from "../types.ts";

const CHUNK_CHARS = 64 * 1024;
const BEACON_MAX_BYTES = 60 * 1024;

type Scheduler = { yield?: () => Promise<void> };

// scheduler.yield where it exists, a MessageChannel task elsewhere (Safari)
const yieldToMain = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: Scheduler }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
};

// metadata in one stringify, replay events in ~64 KiB pieces with a yield
// between them, everything streamed into one gzip stream
export const compress = async (report: Report): Promise<Blob> => {
  const stream = new CompressionStream("gzip");
  const output = new Response(stream.readable, {
    headers: { "content-type": "text/plain" },
  }).blob();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const { replay, ...rest } = report;
  const head = JSON.stringify(rest).slice(0, -1);
  if (!replay) {
    await writer.write(encoder.encode(`${head},"replay":null}`));
  } else {
    await writer.write(
      encoder.encode(`${head},"replay":{"format":"rrweb","events":[`),
    );
    let piece = "";
    for (let i = 0; i < replay.events.length; i++) {
      piece += (i > 0 ? "," : "") + JSON.stringify(replay.events[i]);
      if (piece.length >= CHUNK_CHARS) {
        await writer.write(encoder.encode(piece));
        piece = "";
        await yieldToMain();
      }
    }
    await writer.write(encoder.encode(`${piece}]}}`));
  }
  await writer.close();
  return output;
};

const withoutBodies = (report: Report): Report => ({
  ...report,
  network: report.network.map((entry) => {
    const copy = { ...entry };
    delete copy.requestBody;
    delete copy.responseBody;
    return copy;
  }),
  limits: { ...report.limits, truncated: [...report.limits.truncated, "body"] },
});

const withoutReplay = (report: Report): Report => ({
  ...report,
  replay: null,
  limits: {
    ...report.limits,
    truncated: [...report.limits.truncated, "replay"],
    replayState: "too-large",
  },
});

// over the cap: drop request bodies, then the replay; other fields are bounded
// by their buffers and string limits, so the last attempt is sent as is
const hasBodies = (report: Report): boolean =>
  report.network.some(
    (entry) =>
      entry.requestBody !== undefined || entry.responseBody !== undefined,
  );

export const fitReport = async (
  report: Report,
  maxBytes: number,
): Promise<Blob> => {
  let blob = await compress(report);
  if (blob.size <= maxBytes) return blob;
  if (!hasBodies(report))
    return report.replay ? compress(withoutReplay(report)) : blob;
  const lean = withoutBodies(report);
  blob = await compress(lean);
  if (blob.size <= maxBytes || !lean.replay) return blob;
  return compress(withoutReplay(lean));
};

type Queued = { blob: Blob; inflight: Promise<void> | undefined };

export class Sender {
  private readonly queue: Queued[] = [];
  private readonly pending = new Set<Promise<void>>();

  // taken at init: wrappers the host adds later (auth headers, other SDKs)
  // must not see our reports
  private readonly send: typeof fetch;

  constructor(private readonly endpoint: string) {
    this.send = globalThis.fetch;
  }

  // a report still compressing; flush() waits for it
  track(work: Promise<Blob | undefined>): void {
    const done = work.then(
      (blob) => {
        this.pending.delete(done);
        if (blob) this.push(blob);
      },
      () => {
        this.pending.delete(done);
      },
    );
    this.pending.add(done);
  }

  push(blob: Blob): void {
    const item: Queued = { blob, inflight: undefined };
    this.queue.push(item);
    this.post(item);
  }

  private request(blob: Blob): Promise<Response> {
    try {
      return this.send.call(globalThis, this.endpoint, {
        method: "POST",
        body: blob,
        credentials: "omit",
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private post(item: Queued): Promise<void> {
    item.inflight ??= this.request(item.blob)
      .then((response) => {
        if (response.ok) this.remove(item);
      })
      .catch(() => undefined)
      .finally(() => {
        item.inflight = undefined;
      });
    return item.inflight;
  }

  private remove(item: Queued): void {
    const index = this.queue.indexOf(item);
    if (index >= 0) this.queue.splice(index, 1);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
    await Promise.all(this.queue.map((item) => this.post(item)));
  }

  // page is going away: beacon what fits and has no request in flight; false
  // means not queued and keeps the report, true is not proof of delivery
  unload(): void {
    for (const item of [...this.queue]) {
      if (item.inflight || item.blob.size > BEACON_MAX_BYTES) continue;
      let queued = false;
      try {
        queued = navigator.sendBeacon(this.endpoint, item.blob);
      } catch {
        // nothing left to do on a closing page
      }
      if (queued) this.remove(item);
    }
  }

  get size(): number {
    return this.queue.length;
  }
}
