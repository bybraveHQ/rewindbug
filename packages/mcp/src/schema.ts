import { z } from "zod";
import { TOOLS } from "./tools.ts";

// the same conversion the SDK applies when it lists tools: draft-7, inputs
// as input, outputs as output
export const toolSchemas = (): Record<
  string,
  { input: unknown; output: unknown }
> =>
  Object.fromEntries(
    Object.entries(TOOLS).map(([name, tool]) => [
      name,
      {
        input: z.toJSONSchema(z.object(tool.input), {
          target: "draft-7",
          io: "input",
        }),
        output: z.toJSONSchema(tool.output, {
          target: "draft-7",
          io: "output",
        }),
      },
    ]),
  );
