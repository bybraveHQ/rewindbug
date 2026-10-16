import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { link, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { log } from "./log.ts";
import { saveReport, validateReport } from "./store.ts";

export const DEFAULT_PORT = 7357;
export const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const HOST = "127.0.0.1";
const TOKEN = /^[0-9a-f]{32}$/;
const TOKEN_BYTES = 16;
const GZIP_MAGIC = [0x1f, 0x8b];
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST",
  "access-control-allow-headers": "content-type",
  "access-control-allow-private-network": "true",
};

export type Receiver = { port: number | null; close: () => Promise<void> };

const code = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | null)?.code;

export const readOrCreateToken = async (root: string): Promise<string> => {
  const path = join(resolve(root), "token");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const token = (await readFile(path, "utf8")).trim();
      if (TOKEN.test(token)) return token;
      await rm(path, { force: true });
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
    }
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    // written aside and linked in place: nobody ever reads a half-written
    // token, and link fails if another instance got there first
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, token, { flag: "wx", mode: 0o600 });
    try {
      await link(tmp, path);
      return token;
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    } finally {
      await rm(tmp, { force: true });
    }
  }
  throw new Error(`cannot read or create the token at ${path}`);
};

export const endpointOf = (port: number, token: string): string =>
  `http://${HOST}:${port}/${token}`;

const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

class HttpError extends Error {
  constructor(readonly status: number) {
    super(String(status));
  }
}

const inflate = (raw: Buffer): Promise<Buffer> =>
  new Promise((done, fail) => {
    const gunzip = createGunzip();
    const parts: Buffer[] = [];
    let size = 0;
    gunzip.on("data", (part: Buffer) => {
      size += part.length;
      if (size > MAX_BODY_BYTES) {
        gunzip.destroy();
        fail(new HttpError(413));
        return;
      }
      parts.push(part);
    });
    gunzip.on("error", () => fail(new HttpError(400)));
    gunzip.on("end", () => done(Buffer.concat(parts)));
    gunzip.end(raw);
  });

// the compressed size is capped on the wire, the inflated size while
// inflating: a small gzip bomb stops at MAX_BODY_BYTES. An oversized body is
// still read to the end, without keeping it: closing the socket mid-upload
// makes the client see a reset instead of 413; requestTimeout bounds it
const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = Number(request.headers["content-length"]) > MAX_COMPRESSED_BYTES;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_COMPRESSED_BYTES) over = true;
      if (!over) chunks.push(chunk);
    });
    request.on("error", () => fail(new HttpError(400)));
    request.on("end", () => {
      if (over) return fail(new HttpError(413));
      const raw = Buffer.concat(chunks);
      if (raw.length === 0) return fail(new HttpError(400));
      const gzip = raw[0] === GZIP_MAGIC[0] && raw[1] === GZIP_MAGIC[1];
      done(gzip ? inflate(raw) : raw);
    });
  });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400);
  }
};

export const startReceiver = async (options: {
  port: number;
  dir: string;
  token: string;
}): Promise<Receiver> => {
  const expected = digest(`/${options.token}`);
  let hosts = new Set<string>();

  const respond = (response: ServerResponse, status: number) => {
    if (!response.headersSent) response.writeHead(status, CORS).end();
  };

  const receive = async (request: IncomingMessage): Promise<number> => {
    const text = (await readBody(request)).toString("utf8");
    const receivedAt = Date.now();
    const report = validateReport(parseJson(text), receivedAt);
    if (typeof report === "string") throw new HttpError(400);
    try {
      await saveReport(options.dir, report, text, receivedAt);
    } catch (error) {
      log(`cannot save a report: ${(error as Error).message}`);
      return 500;
    }
    return 204;
  };

  // order: Host, path, method, body; the raw url is compared as is,
  // nothing is parsed or normalized
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (!hosts.has(request.headers.host ?? "")) return respond(response, 421);
    if (!timingSafeEqual(digest(request.url ?? ""), expected)) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "OPTIONS") return respond(response, 204);
    if (request.method !== "POST") return respond(response, 405);
    try {
      respond(response, await receive(request));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.status === 413) response.setHeader("connection", "close");
      respond(response, error.status);
    }
  };

  const server = createServer(
    { requestTimeout: REQUEST_TIMEOUT_MS },
    (request, response) => {
      handle(request, response).catch((error: unknown) => {
        log(`request failed: ${(error as Error).message}`);
        respond(response, 500);
      });
    },
  );

  const listening = await new Promise<boolean>((done, fail) => {
    const onError = (error: Error) => {
      if (code(error) === "EADDRINUSE") done(false);
      else fail(error);
    };
    server.once("error", onError);
    server.listen(options.port, HOST, () => {
      server.off("error", onError);
      done(true);
    });
  });
  server.on("error", (error) => log(`receiver error: ${error.message}`));
  if (!listening) {
    log(
      `port ${options.port} is taken by another process; this instance only reads ${resolve(options.dir)} and receives nothing. Set REWINDBUG_PORT for this project`,
    );
    return { port: null, close: async () => undefined };
  }
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : options.port;
  hosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
  return {
    port,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
};
