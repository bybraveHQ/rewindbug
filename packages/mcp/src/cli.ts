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
import { parseInitScriptArgs, writeInitScript } from "./init-script.ts";
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

// `rewindbug-mcp init-script --host …`: the file for the agent's browser,
// on the token and port this server will use; then exit
const initScript = async (argv: string[]): Promise<void> => {
  const dir = resolve(process.env.REWINDBUG_DIR || ".rewindbug");
  const port = portOf(process.env.REWINDBUG_PORT);
  // a random port changes on every start: the file would point nowhere
  if (port === 0)
    throw new Error("REWINDBUG_PORT=0 cannot be baked into an init-script");
  const { path, hosts } = await writeInitScript(parseInitScriptArgs(argv), {
    dir,
    port,
  });
  // stdout is free here: no MCP session in this mode. Hosts are counted,
  // not listed
  console.log(
    `rewindbug-mcp: init-script for ${hosts} host(s), port ${port}: ${path}`,
  );
};

const main = async (): Promise<void> => {
  if (process.argv[2] === "init-script")
    return initScript(process.argv.slice(3));
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
