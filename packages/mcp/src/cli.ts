#!/usr/bin/env node
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from "./log.ts";
import {
  DEFAULT_PORT,
  endpointOf,
  readOrCreateToken,
  startReceiver,
} from "./receiver.ts";
import { createMcpServer } from "./server.ts";
import { cleanOrphans, ensureDirs } from "./store.ts";

const MAX_PORT = 65_535;

const portOf = (raw: string | undefined): number => {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  // digits only: Number() would also take "0x1F90" or "1e3"
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port > MAX_PORT)
    throw new Error(`REWINDBUG_PORT must be an integer 0-${MAX_PORT}: ${raw}`);
  return port;
};

const main = async (): Promise<void> => {
  const dir = resolve(process.env.REWINDBUG_DIR || ".rewindbug");
  const port = portOf(process.env.REWINDBUG_PORT);
  await ensureDirs(dir);
  await cleanOrphans(dir);
  const token = await readOrCreateToken(dir);
  const receiver = await startReceiver({ port, dir, token });
  const endpoint = endpointOf(receiver.port ?? port, token);
  if (receiver.port !== null) log(`receiving reports at ${endpoint}`);
  log(`reports folder ${dir}`);

  const server = createMcpServer({
    dir,
    endpoint,
    portTaken: receiver.port === null,
  });
  let closing = false;
  // the client may go away without a protocol close: an open port must not
  // outlive it
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await receiver.close();
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  server.server.onclose = () => void shutdown();
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await server.connect(new StdioServerTransport());
};

main().catch((error: unknown) => {
  log(`cannot start: ${(error as Error).message}`);
  process.exit(1);
});
