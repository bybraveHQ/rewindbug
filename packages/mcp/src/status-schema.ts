import { z } from "zod";
import { CoverageFile } from "./coverage.ts";

// the status tool's output, apart from the code that collects it: the
// schema script loads it in plain Node
export const ReceiverState = z
  .enum(["own", "taken", "down"])
  .describe(
    "own: this folder's receiver listens on the port; taken: another process holds it; down: nothing listens, the MCP server is not running",
  );

export const Status = z.object({
  version: z.string(),
  folder: z.string(),
  reports: z.number(),
  lastReportAt: z.number().optional(),
  port: z.number(),
  receiver: ReceiverState,
  portSource: z
    .enum(["env", "init-script", "default"])
    .describe(
      "Where the port came from: REWINDBUG_PORT, the init-script's endpoint, or 7357",
    ),
  initScript: z.object({
    path: z.string(),
    exists: z.boolean(),
    build: z.string().optional(),
    installed: z.string().optional(),
    hosts: z.array(z.string()).optional(),
    endpointMatches: z.boolean().optional(),
  }),
  coverage: CoverageFile.nullable(),
  screenshots: z
    .string()
    .nullable()
    .describe("The Playwright package the renderer loads, null without one"),
});
export type Status = z.infer<typeof Status>;
