# rewindbug-mcp

[![CI](https://github.com/bybraveHQ/rewindbug/actions/workflows/ci.yml/badge.svg)](https://github.com/bybraveHQ/rewindbug/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/rewindbug-mcp)](https://www.npmjs.com/package/rewindbug-mcp)
[![license](https://img.shields.io/npm/l/rewindbug-mcp)](https://github.com/bybraveHQ/rewindbug/blob/main/LICENSE)

MCP server for [rewindbug](https://github.com/bybraveHQ/rewindbug#readme). It receives bug reports on localhost and hands the last bug to your coding agent in Claude Code or Cursor: trigger, reproduction steps, console, network and a Playwright test, without the heavy rrweb recording.

Your app sends a report on an error, the server stores it, and you ask the agent "look at the last bug".

It is a separate package of the [rewindbug project](https://github.com/bybraveHQ/rewindbug), with its source in [`packages/mcp`](https://github.com/bybraveHQ/rewindbug/tree/main/packages/mcp). The SDK runs in the browser and stays small, with rrweb as its only dependency. This server runs in Node next to your editor and needs the MCP SDK. Kept apart, the browser bundle never carries server code, and you install this one only if you use a coding agent.

## Run

It needs Node 22 or newer. Add it to Claude Code:

```bash
claude mcp add rewindbug --env REWINDBUG_DIR=/absolute/path/to/your-app/.rewindbug -- npx -y rewindbug-mcp
```

Or to Cursor, in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "rewindbug": {
      "command": "npx",
      "args": ["-y", "rewindbug-mcp"],
      "env": { "REWINDBUG_DIR": "/absolute/path/to/your-app/.rewindbug" }
    }
  }
}
```

From a clone of the repo, build it with `pnpm install && pnpm --filter rewindbug-mcp build` and run `node packages/mcp/dist/cli.js` in place of `npx -y rewindbug-mcp`.

Always set `REWINDBUG_DIR`: clients start MCP servers in a working folder of their own choosing. Add `.rewindbug/` to your app's `.gitignore`.

## Point the app at it

On start the server prints the endpoint to stderr, and `last_bug` returns it while there are no reports:

```text
rewindbug-mcp: receiving reports at http://127.0.0.1:7357/<token>
```

The token in the path is what lets only your app write reports: without it any open tab could send a fake bug to your agent. Keep the endpoint out of git: put it in a local env file and read it at build time, so builds without it skip `init`:

```ts
import { init } from "rewindbug";

// Vite; webpack and Next.js read process.env.NEXT_PUBLIC_REWINDBUG_ENDPOINT or similar
const endpoint = import.meta.env.VITE_REWINDBUG_ENDPOINT;
if (endpoint) init({ endpoint });
```

A page without a bundler imports the single-file build `dist/rewindbug.browser.js` from a CDN in a plain `<script type="module">`, see the [main README](https://github.com/bybraveHQ/rewindbug#install).

The token lives in `.rewindbug/token`. Delete the file and restart the server to get a new one.

## The agent's browser

The agent can browse your stand with [Playwright MCP](https://github.com/microsoft/playwright-mcp) and get its page errors as bugs, with no change to the app. Write an init-script once: it carries the browser build of rewindbug, starts it only on the hosts you name, before the page's own scripts, and sends to this server.

```bash
npm i -D rewindbug rewindbug-mcp
REWINDBUG_DIR=$PWD/.rewindbug REWINDBUG_PORT=7357 npx rewindbug-mcp init-script --host stand.example.dev --host admin.example.dev
```

It writes `.rewindbug/init-script.js` with the same token and port the server uses, or `--out <file>`. `--host` takes a bare host name, `localhost` included; a URL with a login or a path is refused. `--mask-param <name>` masks one more query parameter in report URLs, such as `x-vercel-protection-bypass`. Run it again after you update `rewindbug` or change hosts. Then give Playwright MCP the file, in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "rewindbug": {
      "command": "npx",
      "args": ["-y", "rewindbug-mcp"],
      "env": {
        "REWINDBUG_DIR": "/absolute/path/to/project/.rewindbug",
        "REWINDBUG_PORT": "7357"
      }
    },
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--grant-permissions=local-network-access",
        "--init-script=/absolute/path/to/project/.rewindbug/init-script.js"
      ]
    }
  }
}
```

`--grant-permissions=local-network-access` matters: Chrome lets a public page reach `127.0.0.1` only with the Local Network Access permission, and without it the report is dropped with no error. The file holds the token: keep it out of git together with `.rewindbug/`.

## Tools

| Tool        | Returns                                                           |
| ----------- | ----------------------------------------------------------------- |
| `last_bug`  | the newest report, or the endpoint and folder while there is none |
| `list_bugs` | summaries, newest first; `limit` 1 to 100, 20 by default          |
| `get_bug`   | one report by `id` from `list_bugs`                               |
| `status`    | whether reports can reach this server, see below                  |

A bug has no rrweb events: `report.replay.events` is only their count. The full report with the recording is in the file at `path`. Long bodies and lists are cut to keep the answer under 200 KiB, `trimmed` says what was cut. JSON Schema of every input and output: [`schema/tools.schema.json`](https://github.com/bybraveHQ/rewindbug/blob/main/packages/mcp/schema/tools.schema.json).

Everything in a report comes from a web page. The agent gets it marked as data, not instructions. Read `report.test` before running it.

### Is it working?

An empty folder means either no errors or no rewindbug at all. Each page where rewindbug started sends one beacon to `<endpoint>/started` (rewindbug 0.6.0+), and the server counts them per host in `.rewindbug/coverage.json`. `last_bug` on an empty folder then says "rewindbug started on 12 page(s) of 1 host(s) …: no error happened there" or "rewindbug has not started on any page".

`status`, as a tool or as a command without an MCP session, answers the rest at once:

```bash
REWINDBUG_DIR=$PWD/.rewindbug npx rewindbug-mcp status
```

- the folder, the number of reports and when the last one came;
- the receiver port: held by this folder's server, taken by another process, or free because the server is not running;
- the init-script: its hosts, the rewindbug version built into it against the one in `node_modules`, and whether its endpoint is this server's port and token;
- coverage per host: pages, the last one and its path, the SDK version;
- whether Playwright for pictures is found.

The page paths in coverage come from pages: the agent gets them as data. Delete `coverage.json` to count from zero; it keeps at most 50 hosts.

### A picture of the error

With [Playwright](https://playwright.dev) in the project, each report also gets a PNG of the screen at the moment of the error: the server plays the recording back to the trigger in a headless Chromium and saves `<received>-<id>.png` next to the report. `last_bug` and `get_bug` attach it as an image the agent can look at, with its path in `bug.screenshot`; `list_bugs` says `screenshot: true`.

```bash
npm i -D playwright && npx playwright install chromium
```

The page gets its `204` first, the picture follows in the background, one report at a time, in about a second. A tool call about a report that came a moment ago waits up to 3 seconds for it. Without Playwright or its Chromium the server logs one line and reports come without a picture.

The picture holds what the recording holds, with the same masks. To draw the page, the server itself fetches the page's styles, fonts and images by `GET`, without cookies, from the address it checked, and follows no redirect; the browser itself is cut off from the network, so even preconnect hints in the page go nowhere; it never runs the page's scripts and sends no data requests. No private or loopback address is reached, except the stand's own origin when the stand runs on this machine, such as `http://localhost:4244`. Each request has 5 seconds, six run at a time, one picture asks for at most 100 resources and 20 MiB. Chromium runs with its sandbox on. A stand behind a login or deployment protection answers those requests with `401`: the picture then has the layout and text without the stand's styles. A report file over 8 MiB is not drawn; one picture takes at most 10 seconds.

## Settings

| Variable         | Default                            | Meaning                                                 |
| ---------------- | ---------------------------------- | ------------------------------------------------------- |
| `REWINDBUG_DIR`  | `.rewindbug` in the working folder | where `reports/`, `token` and `coverage.json` live      |
| `REWINDBUG_PORT` | `7357`                             | receiver port on `127.0.0.1`; give each project its own |

The folder keeps the last 100 reports. Clean it by hand whenever you like.

## Known limits

- **Second instance.** When the port is taken, the server only reads its folder and says so. Reports from another project go to the instance that owns the port. Use a separate `REWINDBUG_PORT` per project.
- **Failed deliveries stay queued.** The SDK keeps a report in its queue on any non-2xx answer and retries on `flush()` and on tab close. A wrong token, a report over the limits or a clock more than 5 minutes ahead keeps it there until the endpoint is fixed.
- **Console noise on tab close.** A report sent with `sendBeacon` on tab close is delivered. The browser still logs that the `*` CORS answer was rejected for a request with credentials.
- **Local Network Access.** Chrome asks before a public or `https://` page reaches `127.0.0.1`; an automated browser has no one to ask and drops the request. Grant `local-network-access`: Playwright `permissions: ["local-network-access"]`, Playwright MCP `--grant-permissions=local-network-access`. Safari may block it as mixed content.
- **Custom request headers.** The receiver accepts only `content-type` in CORS. A header added to every request, such as a deployment protection bypass in Playwright `extraHTTPHeaders`, also goes with the report and the preflight fails. Scope the header to your stand with `context.route` or trade it for the stand's cookie once.
- **Pictures of protected stands.** The renderer loads a stand's styles without its cookies, so a stand behind a login draws without them. A recording has no pixels of a `<canvas>` or a `<video>`.
- **Containers.** Port forwarding from a devcontainer or WSL changes the `Host` header and the server answers `421`. Run the server in the same environment as the browser.
- **Token in the agent's context.** `last_bug` returns the endpoint with the token while the folder is empty. A crafted report could make the agent repeat it. The token only guards writes to a folder on your machine: delete `.rewindbug/token` and restart to rotate it.

## Support

If this package saves you time, you can support maintenance:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-buy%20me%20a%20coffee-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/bybrave)
[![Bitcoin](https://img.shields.io/badge/Bitcoin-BTC-F7931A?logo=bitcoin&logoColor=white)](#support)

Bitcoin (BTC): `bc1q37557q5jpeaxqydzwvf3jgj7zhnfpn2td3q40q`

## License

MIT
