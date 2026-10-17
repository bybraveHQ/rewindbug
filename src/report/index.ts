import type { Context, Report, Step, Trigger } from "../types.ts";
import type { UrlFilter } from "../shared/url-filter.ts";
import {
  buildReport,
  collectContext,
  reportId,
  type CaptureSource,
  type ReportInput,
  type ReplaySource,
  type StepsSource,
} from "./build.ts";
import { fingerprintOf, ReportGate } from "./fingerprint.ts";
import { fitReport, Sender } from "./send.ts";

export type ReportOptions = {
  endpoint: string;
  maxReportBytes: number;
  bufferSeconds: number;
  filter: UrlFilter;
  app?: Context["app"];
  tags?: Context["tags"];
  beforeSend?: (report: Report) => Report | null;
  capture: () => CaptureSource;
  replay: (until: number) => ReplaySource;
  steps: () => StepsSource;
  describeSteps: (steps: Step[], message: string) => string;
  describeTest: ReportInput["describeTest"];
  now?: () => number;
};

export type Reporter = {
  onTrigger: (trigger: Trigger, tags?: Context["tags"]) => void;
  flush: () => Promise<void>;
  stop: () => void;
};

export const startReport = (options: ReportOptions): Reporter => {
  const gate = new ReportGate();
  const sender = new Sender(options.endpoint);
  const now = options.now ?? Date.now;

  // everything up to the queue runs synchronously: buffers are copied at the
  // trigger, only compression is async
  const onTrigger = (trigger: Trigger, tags?: Context["tags"]) => {
    try {
      const capture = options.capture();
      const merged = (options.tags || tags) && { ...options.tags, ...tags };
      const context = collectContext(options.filter, {
        ...(options.app && { app: options.app }),
        ...(merged && { tags: merged }),
      });
      const id = reportId();
      // capture() with nothing to fingerprint is always its own report; with
      // an error it dedups like a caught one, so an effect run twice in
      // React's StrictMode sends one
      const manual = trigger.kind === "manual" && !trigger.error;
      const request =
        trigger.kind === "network"
          ? capture.network.find((entry) => entry.id === trigger.requestId)
          : undefined;
      const fingerprint = manual
        ? id
        : fingerprintOf(trigger, context.url, request);
      if (!gate.admit(fingerprint, trigger.at, !manual)) return;
      const report = buildReport({
        id,
        fingerprint,
        createdAt: now(),
        trigger,
        context,
        bufferSeconds: options.bufferSeconds,
        capture,
        replay: options.replay(trigger.at),
        steps: options.steps(),
        describeSteps: options.describeSteps,
        describeTest: options.describeTest,
      });
      let final: Report | null = report;
      try {
        final = options.beforeSend ? options.beforeSend(report) : report;
      } catch {
        // a beforeSend that throws may have been redacting: send nothing
        final = null;
      }
      // an async beforeSend returns a promise, not a report
      if (!final || "then" in final) {
        gate.refund(fingerprint, true);
        return;
      }
      sender.track(
        fitReport(final, options.maxReportBytes).catch(() => {
          gate.refund(fingerprint);
          return undefined;
        }),
      );
    } catch {
      // a broken report must never surface on the host page
    }
  };

  const onHide = () => {
    if (document.visibilityState === "hidden") sender.unload();
  };
  const onPageHide = () => sender.unload();
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onPageHide);

  return {
    onTrigger,
    flush: () => sender.flush().catch(() => undefined),
    stop: () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    },
  };
};
