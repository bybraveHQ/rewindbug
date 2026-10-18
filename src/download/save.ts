import { reportPage } from "../report/page.ts";
import type { Report } from "../types.ts";

// a page that keeps breaking in new ways must not flood the downloads folder
export const MAX_DOWNLOADS = 10;
const MAX_TITLE_LENGTH = 200;
// Safari drops a download whose blob URL is revoked right after the click
const REVOKE_MS = 60_000;

export const fileName = (report: Report): string =>
  `rewindbug-${new Date(report.createdAt).toISOString().replace(/[:.]/g, "-")}.html`;

export const save = async (report: Report): Promise<void> => {
  const { player } = await import("../report/player.ts");
  const [headline = ""] = report.trigger.message.split("\n");
  const html = reportPage(
    report,
    headline.slice(0, MAX_TITLE_LENGTH) || "rewindbug report",
    player,
  );
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName(report);
  link.hidden = true;
  document.documentElement.append(link);
  // a click that does not bubble: the app's own link handlers never see it
  link.dispatchEvent(new MouseEvent("click"));
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
};
