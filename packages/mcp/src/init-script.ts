import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HOSTNAME } from "./coverage.ts";
import { endpointOf, readOrCreateToken } from "./receiver.ts";

// the agent's browser loads this file before every page's own scripts:
// rewindbug starts on the named hosts only and sends to this receiver
const BUILD = join("node_modules", "rewindbug", "dist", "rewindbug.global.js");
const PARAM = /^[\w.-]+$/;

export type InitScriptOptions = {
  hosts: string[];
  maskParams: string[];
  out?: string;
};

// a host, not a URL: the command line stays in shell history and agent
// transcripts, so a login, a query or a path is refused before it is stored
export const validHost = (value: string): boolean => {
  const host = value.trim().toLowerCase();
  return HOSTNAME.test(host) && (host.includes(".") || host === "localhost");
};

export const parseInitScriptArgs = (argv: string[]): InitScriptOptions => {
  const options: InitScriptOptions = { hosts: [], maskParams: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--"))
        throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--host") {
      const host = value();
      // the value is not echoed: it may be a URL with a password in it
      if (!validHost(host))
        throw new Error(
          "--host takes a bare host name such as stand.example.dev or localhost",
        );
      options.hosts.push(host.trim().toLowerCase());
    } else if (flag === "--mask-param") {
      const name = value();
      if (!PARAM.test(name))
        throw new Error("--mask-param takes a query parameter name");
      options.maskParams.push(name);
    } else if (flag === "--out") options.out = value();
    else
      throw new Error(
        `unknown argument for init-script: ${flag.startsWith("--") ? flag : "(a value)"}`,
      );
  }
  if (!options.hosts.length)
    throw new Error("init-script needs at least one --host");
  return options;
};

// the build next to the project: the nearest node_modules/rewindbug up from
// the folder the command runs in
export const findBuild = (from: string): string => {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const path = join(dir, BUILD);
    if (existsSync(path)) return path;
    if (dirname(dir) === dir)
      throw new Error(
        `no ${BUILD} up from ${resolve(from)}: install rewindbug in the project first`,
      );
  }
};

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const initScriptSource = ({
  build,
  hosts,
  endpoint,
  maskParams,
}: {
  build: string;
  hosts: string[];
  endpoint: string;
  maskParams: string[];
}): string => {
  const mask = maskParams.length
    ? `([?&;](?:${maskParams.map(escapeRegExp).join("|")})=)[^&#;?]*`
    : "";
  const urlFilter = mask
    ? `urlFilter: (url, filter) => filter(url).replace(new RegExp(${JSON.stringify(mask)}, "gi"), "$1*"),`
    : "";
  return `(() => {
  // the project's pages only: other sites in the same browser send nothing
  const HOSTS = ${JSON.stringify(hosts)};
  if (window !== window.top || window.__rewindbug || !HOSTS.includes(location.hostname)) return;
  window.__rewindbug = true;
  ${build}
  rewindbug.init({
    endpoint: ${JSON.stringify(endpoint)},
    ${urlFilter}
  });
})();
`;
};

export const writeInitScript = async (
  options: InitScriptOptions,
  {
    dir,
    port,
    cwd = process.cwd(),
  }: { dir: string; port: number; cwd?: string },
): Promise<{ path: string; hosts: number }> => {
  const build = await readFile(findBuild(cwd), "utf8");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // the receiver reads the same token file: one token for both
  const token = await readOrCreateToken(dir);
  const path = resolve(options.out ?? join(dir, "init-script.js"));
  await mkdir(dirname(path), { recursive: true });
  const hosts = [...new Set(options.hosts)];
  await writeFile(
    path,
    initScriptSource({
      build,
      hosts,
      endpoint: endpointOf(port, token),
      maskParams: options.maskParams,
    }),
    { mode: 0o600 },
  );
  return { path, hosts: hosts.length };
};
