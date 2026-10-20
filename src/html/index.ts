import type { Report } from "../types.ts";
import { NONCE_BYTES, nonceOf, reportPage } from "../report/page.ts";
import { player } from "../report/player.ts";

export type { Report };

const MAX_TITLE_LENGTH = 200;

// the report page as a string, in Node or a browser: the same offline page a
// Playwright attachment or a download gets, for reports read back from a
// receiver's folder. With several, a list on top picks one, the newest first
export const reportHtml = (
  reports: readonly Report[],
  title?: string,
): string => {
  const [headline = "rewindbug report"] =
    reports.length === 1 ? (reports[0]?.trigger.message.split("\n") ?? []) : [];
  const nonce = nonceOf(
    globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES)),
  );
  return reportPage(
    reports,
    (title ?? headline).slice(0, MAX_TITLE_LENGTH),
    player,
    nonce,
  );
};
