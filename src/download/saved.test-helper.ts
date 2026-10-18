import { vi } from "vitest";

const POLL_MS = 10;
const WAIT_MS = 3000;

export type Saved = { name: string; html: Promise<string> };

// downloads are caught at the link click: the test sees each file's name
// and page, and the browser saves nothing
export const catchDownloads = (): Saved[] => {
  const saved: Saved[] = [];
  const blobs = new Map<string, Blob>();
  const realCreate = URL.createObjectURL.bind(URL);
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = realCreate(blob);
    if (blob instanceof Blob) blobs.set(url, blob);
    return url;
  });
  vi.spyOn(HTMLAnchorElement.prototype, "dispatchEvent").mockImplementation(
    function (this: HTMLAnchorElement) {
      const blob = blobs.get(this.href);
      if (blob) saved.push({ name: this.download, html: blob.text() });
      return true;
    },
  );
  return saved;
};

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const until = async (check: () => boolean) => {
  const deadline = performance.now() + WAIT_MS;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out");
    await sleep(POLL_MS);
  }
};

export const hotkey = () =>
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      code: "KeyR",
      key: "®",
      altKey: true,
      shiftKey: true,
      cancelable: true,
    }),
  );
