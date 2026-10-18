import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GENERATED = join(ROOT, "e2e/.generated");
const CLI = join(ROOT, "node_modules/@playwright/test/cli.js");
export const RUN_TIMEOUT_MS = 30_000;
const run = promisify(execFile);

// the generated test runs as is in a Playwright of its own: it must reach
// the same bug, so it fails while the bug is there
export const runGenerated = async <T = undefined>(
  source: string,
  baseURL?: string,
  // read runs before the run's folder goes: attachments live there
  options: { reporter?: string; read?: (stdout: string) => Promise<T> } = {},
) => {
  const dir = join(GENERATED, randomUUID());
  await mkdir(dir, { recursive: true });
  const use = baseURL ? `, use: { baseURL: ${JSON.stringify(baseURL)} }` : "";
  try {
    await writeFile(join(dir, "bug.spec.ts"), source);
    await writeFile(
      join(dir, "playwright.config.ts"),
      `export default { testDir: ".", outputDir: "results", reporter: ${JSON.stringify(options.reporter ?? "line")}, workers: 1${use} };\n`,
    );
    const result = await run(
      process.execPath,
      [CLI, "test", "--config", join(dir, "playwright.config.ts")],
      {
        cwd: dir,
        timeout: RUN_TIMEOUT_MS,
        env: { ...process.env, FORCE_COLOR: "0", CI: "" },
      },
    ).then(
      (done) => ({
        status: 0 as number | null,
        output: done.stdout + done.stderr,
        stdout: done.stdout,
      }),
      (error: unknown) => {
        const failed = error as {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        return {
          status: failed.code ?? null,
          output: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
          stdout: failed.stdout ?? "",
        };
      },
    );
    const read = options.read ? await options.read(result.stdout) : undefined;
    return { ...result, read };
  } finally {
    // the nested run may still be writing its results when it exits
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
};

// workers of other projects may still be inside: only an empty root goes
export const removeGeneratedRoot = () =>
  rmdir(GENERATED).catch(() => undefined);
