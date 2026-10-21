import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fixture } from "./fixture.ts";
import { createCoverage, readCoverage, type Coverage } from "./coverage.ts";
import {
  endpointOf,
  MAX_BODY_BYTES,
  MAX_COMPRESSED_BYTES,
  readOrCreateToken,
  startReceiver,
  type Receiver,
} from "./receiver.ts";
import { ensureDirs, listSummaries, reportsDir } from "./store.ts";

let root: string;
let token: string;
let receiver: Receiver;
let port: number;
let coverage: Coverage;

type Reply = { status: number; headers: Record<string, unknown> };

const send = (options: {
  path?: string;
  method?: string;
  host?: string;
  body?: Buffer | string;
}): Promise<Reply> =>
  new Promise((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: options.path ?? `/${token}`,
        method: options.method ?? "POST",
        headers: { host: options.host ?? `127.0.0.1:${port}` },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          done({ status: res.statusCode ?? 0, headers: res.headers }),
        );
      },
    );
    req.on("error", fail);
    req.end(options.body);
  });

const json = (patch: object = {}) => JSON.stringify({ ...fixture, ...patch });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rewindbug-receiver-"));
  await ensureDirs(root);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  token = await readOrCreateToken(root);
  coverage = createCoverage(root);
  receiver = await startReceiver({ port: 0, dir: root, token, coverage });
  port = receiver.port ?? 0;
});

afterEach(async () => {
  await receiver.close();
  await coverage.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("token", () => {
  test("is created once with 0600 and reused", async () => {
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect((await stat(join(root, "token"))).mode & 0o777).toBe(0o600);
    expect(await readOrCreateToken(root)).toBe(token);
  });

  test("is recreated when the file holds garbage", async () => {
    await writeFile(join(root, "token"), "");
    const fresh = await readOrCreateToken(root);
    expect(fresh).toMatch(/^[0-9a-f]{32}$/);
    expect(await readFile(join(root, "token"), "utf8")).toBe(fresh);
  });

  test("endpoint is the loopback address with the token as path", () => {
    expect(endpointOf(7357, token)).toBe(`http://127.0.0.1:7357/${token}`);
  });
});

describe("receiver", () => {
  test("stores a gzip report and a raw one as pairs", async () => {
    const gzip = await send({ body: gzipSync(json()) });
    expect(gzip.status).toBe(204);
    expect(gzip.headers["access-control-allow-origin"]).toBe("*");
    const raw = await send({
      body: json({ id: "11111111-2222-4333-8444-555555555555" }),
    });
    expect(raw.status).toBe(204);
    expect(await readdir(reportsDir(root))).toHaveLength(4);
    const stored = (await listSummaries(root)).find((s) => s.id === fixture.id);
    expect(JSON.parse(await readFile(stored?.path ?? "", "utf8"))).toEqual(
      fixture,
    );
  });

  test("answers 404 to any other path", async () => {
    for (const path of [
      "/",
      "/x",
      `/${token}/`,
      `/${token}?a=1`,
      `//${token}`,
      `/a/../${token}`,
      `/${token.toUpperCase()}`,
    ]) {
      expect((await send({ path, body: json() })).status, path).toBe(404);
    }
    expect(await readdir(reportsDir(root))).toHaveLength(0);
  });

  test("answers 421 to a foreign Host before looking at the path", async () => {
    for (const host of ["evil.test", `evil.test:${port}`, "127.0.0.1:1"])
      expect((await send({ host, body: json() })).status, host).toBe(421);
    expect(
      (await send({ host: `localhost:${port}`, body: json() })).status,
    ).toBe(204);
  });

  test("answers OPTIONS with CORS and other methods with 405", async () => {
    const options = await send({ method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers["access-control-allow-methods"]).toBe("POST");
    expect(options.headers["access-control-allow-private-network"]).toBe(
      "true",
    );
    expect((await send({ method: "GET" })).status).toBe(405);
  });

  test("rejects a broken body with 400", async () => {
    const bodies: (Buffer | string)[] = [
      "",
      "{ not json",
      Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01]),
      json({ schemaVersion: 1 }),
      json({ createdAt: Date.now() + 60 * 60_000 }),
    ];
    for (const body of bodies) expect((await send({ body })).status).toBe(400);
  });

  test("answers 413 above the compressed and the inflated limit", async () => {
    const tooLong = Buffer.alloc(MAX_COMPRESSED_BYTES + 1, 0x20);
    expect((await send({ body: tooLong })).status).toBe(413);
    // highly compressible: small on the wire, huge inflated
    const bomb = gzipSync(Buffer.alloc(MAX_BODY_BYTES + 1, 0x20));
    expect(bomb.length).toBeLessThan(MAX_COMPRESSED_BYTES);
    expect((await send({ body: bomb })).status).toBe(413);
  });

  test("answers 413 to a chunked body without Content-Length", async () => {
    const status = await new Promise<number>((done, fail) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: `/${token}`,
          method: "POST",
          headers: { host: `127.0.0.1:${port}` },
        },
        (res) => {
          res.resume();
          done(res.statusCode ?? 0);
        },
      );
      req.on("error", fail);
      const piece = Buffer.alloc(256 * 1024, 0x20);
      for (let sent = 0; sent <= MAX_COMPRESSED_BYTES; sent += piece.length)
        req.write(piece);
      req.end();
    });
    expect(status).toBe(413);
  });

  test("two instances racing for a new token get the same one", async () => {
    await rm(join(root, "token"));
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => readOrCreateToken(root)),
    );
    expect(new Set(tokens).size).toBe(1);
    expect((await readdir(root)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a second receiver on a taken port only reads", async () => {
    const second = await startReceiver({ port, dir: root, token });
    expect(second.port).toBeNull();
    await second.close();
  });
});

describe("started signal", () => {
  const signal = (patch: object = {}) =>
    JSON.stringify({
      host: "stand.example.dev",
      path: "/login",
      sdk: "0.6.0",
      ...patch,
    });

  test("counts pages per host in coverage.json", async () => {
    const path = `/${token}/started`;
    expect((await send({ path, body: signal() })).status).toBe(204);
    expect(
      (await send({ path, body: signal({ path: "/orders/1" }) })).status,
    ).toBe(204);
    expect(
      (await send({ path, body: signal({ host: "localhost" }) })).status,
    ).toBe(204);
    await coverage.flush();
    const file = await readCoverage(root);
    expect(file?.hosts["stand.example.dev"]).toMatchObject({
      pages: 2,
      lastPath: "/orders/1",
      sdk: "0.6.0",
    });
    expect(file?.hosts.localhost?.pages).toBe(1);
    expect((await stat(join(root, "coverage.json"))).mode & 0o777).toBe(0o600);
    expect(await listSummaries(root)).toEqual([]);
  });

  test("answers the preflight and rejects a bad signal with 400", async () => {
    const path = `/${token}/started`;
    expect((await send({ path, method: "OPTIONS" })).status).toBe(204);
    for (const body of [
      "not json",
      signal({ host: "user:pw@stand.example.dev" }),
      signal({ path: "/a b" }),
      signal({ path: "login" }),
      signal({ sdk: "x".repeat(33) }),
    ])
      expect((await send({ path, body })).status).toBe(400);
    expect(
      (await send({ path, body: signal({ path: `/${"a".repeat(4096)}` }) }))
        .status,
    ).toBe(413);
    await coverage.flush();
    expect(await readCoverage(root)).toBeUndefined();
  });

  test("a receiver without coverage answers 404 on the started path", async () => {
    await receiver.close();
    receiver = await startReceiver({ port: 0, dir: root, token });
    port = receiver.port ?? 0;
    expect(
      (await send({ path: `/${token}/started`, body: signal() })).status,
    ).toBe(404);
  });
});
