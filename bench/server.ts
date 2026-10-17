import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PAGES = join(ROOT, "bench/pages");
const DIST = join(ROOT, "bench/dist");
const API_ITEM_COUNT = 200;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
};

const items = (page: string) =>
  Array.from({ length: API_ITEM_COUNT }, (_, i) => ({
    title: `Page ${page} item ${i}`,
    body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
  }));

const safeJoin = (base: string, path: string) => {
  const full = normalize(join(base, path));
  return full.startsWith(base) ? full : null;
};

export const startServer = (): Promise<{ server: Server; origin: string }> =>
  new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/items") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(items(url.searchParams.get("page") ?? "1")));
        return;
      }
      if (url.pathname === "/__sink") {
        res.writeHead(204).end();
        return;
      }
      if (url.pathname === "/__variant.js") {
        res.writeHead(200, { "content-type": TYPES[".js"] }).end("");
        return;
      }
      const file = url.pathname.startsWith("/dist/")
        ? safeJoin(DIST, url.pathname.slice("/dist/".length))
        : safeJoin(PAGES, url.pathname);
      if (!file) {
        res.writeHead(403).end();
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
