import { capture, init, type InitOptions } from "../index.ts";
import type { Report } from "../types.ts";
import { save } from "./save.ts";

export * from "../index.ts";

export type DownloadOptions = Omit<InitOptions, "endpoint"> & {
  hotkey?: boolean;
};

// never requested: every report leaves through beforeSend
const ENDPOINT = "http://rewindbug.invalid/report";
// a page that keeps breaking in new ways must not hold every report
export const MAX_KEPT = 10;
const HOTKEY_CODE = "KeyR";
const LIST_MESSAGE_LENGTH = 80;

const kept: Report[] = [];
let started = false;

// every report of this page load in one file, or report n of list() alone;
// with none yet, the moment of the call is captured first. Nothing
// downloads on its own
export const download = async (n?: number): Promise<boolean> => {
  if (!started) return false;
  if (n !== undefined && !(Number.isInteger(n) && n >= 1 && n <= kept.length))
    return false;
  if (n === undefined && !kept.length) capture();
  const reports = n === undefined ? kept.slice() : kept.slice(n - 1, n);
  if (!reports.length) return false;
  await save(reports);
  return true;
};

// the reports a tester can take, numbered for download(n)
export const list = (): void => {
  // a table in the console is what this call is for
  console.table(
    kept.map((report, index) => ({
      n: index + 1,
      time: new Date(report.createdAt).toTimeString().slice(0, 8),
      kind: report.trigger.kind,
      message: report.trigger.message
        .split("\n")[0]
        ?.slice(0, LIST_MESSAGE_LENGTH),
      page: report.context.url,
    })),
  );
};

// Alt+Shift+R by the key's place, not its character: on a Mac Option
// changes the character
const onKeydown = (event: KeyboardEvent) => {
  if (
    event.code !== HOTKEY_CODE ||
    !event.altKey ||
    !event.shiftKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return;
  event.preventDefault();
  download().catch(() => undefined);
};

// init with no server: reports stay in the page until the tester takes
// them, with the keys or with rewindbug.list() and rewindbug.download(n)
// in the console
export const initDownload = (options: DownloadOptions = {}): boolean => {
  const { beforeSend, hotkey = true, ...rest } = options;
  started = init({
    ...rest,
    endpoint: ENDPOINT,
    beforeSend: (report) => {
      const final = beforeSend ? beforeSend(report) : report;
      // an async beforeSend returns a promise, which init drops too
      if (final && !("then" in final)) {
        kept.push(final);
        if (kept.length > MAX_KEPT) kept.shift();
      }
      return null;
    },
  });
  if (!started) return false;
  if (hotkey) document.addEventListener("keydown", onKeydown);
  (window as { rewindbug?: unknown }).rewindbug = { list, download };
  return true;
};
