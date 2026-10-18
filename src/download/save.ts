import { reportPage } from "../report/page.ts";
import type { Report } from "../types.ts";

const MAX_TITLE_LENGTH = 200;
// Safari drops a download whose blob URL is revoked right after the click
const REVOKE_MS = 60_000;

const headline = (report: Report): string =>
  report.trigger.message.split("\n")[0] ?? "";

export const fileName = (report: Report): string =>
  `rewindbug-${new Date(report.createdAt).toISOString().replace(/[:.]/g, "-")}.html`;

// one file for any number of reports, named after the newest
export const save = async (reports: readonly Report[]): Promise<void> => {
  const newest = reports.at(-1);
  if (!newest) return;
  const { player } = await import("../report/player.ts");
  const title =
    reports.length > 1
      ? `${reports.length} reports, newest: ${headline(newest)}`
      : headline(newest) || "rewindbug report";
  const html = reportPage(reports, title.slice(0, MAX_TITLE_LENGTH), player);
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName(newest);
  link.hidden = true;
  document.documentElement.append(link);
  // a click that does not bubble: the app's own link handlers never see it
  link.dispatchEvent(new MouseEvent("click"));
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
};
