import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES_PORT } from "./port.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BUNDLE = fileURLToPath(
  new URL("../../dist/rewindbug.browser.js", import.meta.url),
);
const HOST = "127.0.0.1";
const PAGE = /^\/[a-z-]+\.html$/;

const port = Number(process.env.PORT) || FIXTURES_PORT;
// reports by the run id in the page's query: tests in parallel browsers
// read only their own
const reports = new Map<string, unknown[]>();

const body = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return gunzipSync(Buffer.concat(chunks)).toString("utf8");
};

// fixture pages, the browser build, and reports kept in memory per run
createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}`);
  const { pathname } = url;
  const run = url.searchParams.get("run") ?? "";
  if (pathname === "/report" && request.method === "POST") {
    try {
      const report: unknown = JSON.parse(await body(request));
      reports.set(run, [...(reports.get(run) ?? []), report]);
      response.writeHead(204).end();
    } catch {
      response.writeHead(400).end();
    }
    return;
  }
  if (pathname === "/reports") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reports.get(run) ?? []));
    return;
  }
  const file =
    pathname === "/rewindbug.browser.js"
      ? BUNDLE
      : PAGE.test(pathname)
        ? join(HERE, pathname)
        : null;
  try {
    if (!file) throw new Error("not a fixture");
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": file.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "text/html; charset=utf-8",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, HOST, () => {
  process.stdout.write(`fixtures at http://${HOST}:${port}/\n`);
});
