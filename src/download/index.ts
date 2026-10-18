import { init, type InitOptions } from "../index.ts";
import { MAX_DOWNLOADS, save } from "./save.ts";

export * from "../index.ts";

export type DownloadOptions = Omit<InitOptions, "endpoint">;

// never requested: every report leaves through beforeSend
const ENDPOINT = "http://rewindbug.invalid/report";

let downloads = 0;

// init with no server: each report downloads as a page that plays offline
export const initDownload = (options: DownloadOptions = {}): boolean => {
  const { beforeSend } = options;
  return init({
    ...options,
    endpoint: ENDPOINT,
    beforeSend: (report) => {
      const final = beforeSend ? beforeSend(report) : report;
      // an async beforeSend returns a promise, which init drops too
      if (final && !("then" in final) && downloads < MAX_DOWNLOADS) {
        downloads += 1;
        save(final).catch(() => undefined);
      }
      return null;
    },
  });
};
