import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { toolSchemas } from "../src/schema.ts";

const target = new URL("../schema/tools.schema.json", import.meta.url);
const text = await format(JSON.stringify(toolSchemas()), { parser: "json" });
await writeFile(target, text);
process.stdout.write(`wrote ${target.pathname}\n`);
