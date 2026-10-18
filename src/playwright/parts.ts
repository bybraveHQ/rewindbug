import type { TestInfo } from "@playwright/test";
import type { Report } from "../types.ts";

export type RewindbugOptions = {
  // "failed": reports go to failed tests only; "always": page errors are
  // attached to passing tests too
  attach?: "failed" | "always";
  bufferSeconds?: number;
  maskInputs?: boolean;
  maskSelector?: string;
  consoleErrorTrigger?: boolean;
};

export const BINDING = "__rewindbugReport";
// never requested: every report leaves the page through the binding
const ENDPOINT = "http://rewindbug.invalid/report";
export const FAILURE_NAME = "PlaywrightTestFailure";
// eslint-disable-next-line no-control-regex -- ANSI colors in Playwright errors
const ANSI = /\u001b\[[0-9;]*m/g;

// the page side: the iife build, init in the top frame, reports handed to
// Node instead of the network
export const initScript = (
  source: string,
  options: RewindbugOptions,
): string => {
  const init = {
    endpoint: ENDPOINT,
    ...(options.bufferSeconds !== undefined && {
      bufferSeconds: options.bufferSeconds,
    }),
    ...(options.maskInputs !== undefined && { maskInputs: options.maskInputs }),
    ...(options.maskSelector !== undefined && {
      maskSelector: options.maskSelector,
    }),
    ...(options.consoleErrorTrigger !== undefined && {
      consoleErrorTrigger: options.consoleErrorTrigger,
    }),
  };
  return `(() => {
  if (window !== window.top || window.__rewindbug) return;
  const send = window.${BINDING};
  if (typeof send !== "function") return;
  ${source}
  const pending = new Set();
  rewindbug.init({
    ...${JSON.stringify(init)},
    beforeSend: (report) => {
      const done = Promise.resolve(send(report)).catch(() => undefined);
      pending.add(done);
      done.then(() => pending.delete(done));
      return null;
    },
  });
  window.__rewindbug = {
    capture: rewindbug.capture,
    settled: () => Promise.all([...pending]),
  };
})();`;
};

export const failureOf = (
  info: Pick<TestInfo, "error">,
): { name: string; message: string; stack?: string } => {
  // Playwright messages start with "Error: ", the report adds the name itself
  const message = (info.error?.message ?? "test failed")
    .replace(ANSI, "")
    .replace(/^Error: /, "");
  const stack = info.error?.stack?.replace(ANSI, "");
  return { name: FAILURE_NAME, message, ...(stack && { stack }) };
};

// the binding is callable by any script on the page under test: only what
// our own build sends is kept
export const looksLikeReport = (value: unknown): value is Report => {
  if (typeof value !== "object" || value === null) return false;
  const { fingerprint, trigger, sdk } = value as Partial<Report>;
  return (
    typeof fingerprint === "string" &&
    typeof trigger === "object" &&
    trigger !== null &&
    typeof trigger.message === "string" &&
    sdk?.name === "rewindbug"
  );
};

// the same error caught twice (a page error and the failure it caused) is
// attached once
export const uniqueReports = (reports: Report[]): Report[] => {
  const seen = new Set<string>();
  return reports.filter((report) => {
    if (seen.has(report.fingerprint)) return false;
    seen.add(report.fingerprint);
    return true;
  });
};
