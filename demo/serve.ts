import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_PORT } from "./port.ts";

const ROOT = fileURLToPath(new URL("dist", import.meta.url));
const HOST = "127.0.0.1";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
};

const port = Number(process.env.PORT) || DEMO_PORT;

// static files only, like GitHub Pages: the API lives in the service worker
createServer(async (request, response) => {
  const { pathname } = new URL(request.url ?? "/", `http://${HOST}`);
  const file = normalize(
    join(ROOT, pathname.endsWith("/") ? `${pathname}index.html` : pathname),
  );
  if (!file.startsWith(ROOT + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, HOST, () => {
  process.stdout.write(`demo at http://${HOST}:${port}/\n`);
});
