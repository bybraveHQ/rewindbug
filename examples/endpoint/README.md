# rewindbug endpoint example

Two files, Node 22, no dependencies. `server.mjs` receives the reports the [rewindbug](../../README.md) SDK posts and stores them in a folder, in the same layout [`rewindbug-mcp`](../../packages/mcp/README.md) reads; `viewer.html` plays them in the browser. With two variables set, every new bug also becomes a GitHub issue. Copy both files into your project or run the Docker image.

## Run

```bash
node server.mjs
# listening on http://127.0.0.1:7358/report
```

Point the SDK at it:

```ts
import { init } from "rewindbug";

init({ endpoint: "http://127.0.0.1:7358/report" });
```

With Docker, keep the reports in a folder on the host. The image listens on all interfaces, so it needs a token:

```bash
docker build -t rewindbug-endpoint .
export REWINDBUG_TOKEN="$(openssl rand -hex 32)"
mkdir -p .rewindbug
docker run -p 7358:7358 --user "$(id -u):$(id -g)" -v "$PWD/.rewindbug:/data" \
  -e REWINDBUG_TOKEN rewindbug-endpoint
```

`echo $REWINDBUG_TOKEN` shows the token for your app. The folder is created first and the container runs as your user, so it can write there on Linux. The token may hold only letters, digits and `. _ ~ -`; the server does not start with any other character.

The endpoint then is `http://<host>:7358/report/<token>`. Put it into your app from an environment variable, not into git.

## Watch a report

Open `http://127.0.0.1:7358/view` in a browser: the page lists the reports, newest first, and plays the recording of the selected one with its steps, the Playwright test, the error, console, network and page context. The speed can be set to 0.5×, 1× or 2×. A report sent from a Playwright or headless run is marked `automated`. The rrweb player loads from a CDN in the version that recorded the report, so the browser needs internet access; the reports themselves never leave your server. `#<name>` in the URL opens one report directly, the links in GitHub issues use that.

The write token cannot open the viewer: it sits in your app's code, where every visitor can read it. Beyond loopback the viewer is off until you set a separate `REWINDBUG_VIEW_TOKEN`, and is then at `/view/<view token>`; `REWINDBUG_OPEN=1` opens writing only, never reading. With Docker, add `-e REWINDBUG_VIEW_TOKEN="$(openssl rand -hex 32)"` and keep that token to yourself.

## Send bugs to GitHub Issues

```bash
export REWINDBUG_GITHUB_REPO=owner/name
export REWINDBUG_GITHUB_TOKEN=<fine-grained token with Issues: write on that repo>
export REWINDBUG_PUBLIC_URL=https://bugs.example/view/<view token>   # optional: the recording link
node server.mjs
```

Each new bug opens an issue: the error as the title, then the page, time and browser, a link to the recording in the viewer, the reproduction steps, the error with its stack, the last 20 console and network lines, and the Playwright test folded under "Playwright test". Bugs are told apart by the report's `fingerprint`: the same error coming again adds a comment with the time, page and recording to the existing issue instead of opening a new one, even after the issue was closed. The map of fingerprints to issues is `issues.json` in `REWINDBUG_DIR`; delete a fingerprint's entry there to get a fresh issue next time. If the file is not valid JSON, the server logs it and leaves GitHub alone until it is fixed. A report that the SDK sends twice makes one issue or comment.

The SDK gets its answer as soon as the report is on disk; GitHub is called after that, one report at a time, with a 10 second limit. A GitHub error is logged and never refuses a report, and the same report sent again by the SDK tries GitHub again. Reports still waiting for GitHub when the server stops are not sent there; the log says how many. Console lines and request URLs go to the issue as they are in the report, so if your pages log user data, redact it with the SDK's `beforeSend` before it leaves the browser. Set `REWINDBUG_GITHUB_LABELS` to change the label `bug`.

`REWINDBUG_PUBLIC_URL` puts the view token into every issue, so anyone who can read the repository can open your recordings. Leave it unset for a public repository: the issue then names the report file instead.

## Settings

| Variable                  | Default                            | Meaning                                                                                                           |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `7358`                             | `0` picks a free port                                                                                             |
| `HOST`                    | `127.0.0.1`                        | `0.0.0.0` in the Docker image                                                                                     |
| `REWINDBUG_DIR`           | `.rewindbug` in the working folder | reports go to `reports/` inside it                                                                                |
| `REWINDBUG_TOKEN`         | none                               | the path becomes `/report/<token>`; required beyond loopback                                                      |
| `REWINDBUG_OPEN`          | none                               | `1` lets the server listen beyond loopback without a token                                                        |
| `REWINDBUG_VIEW_TOKEN`    | none                               | the viewer moves to `/view/<token>`; required to read reports beyond loopback; must differ from `REWINDBUG_TOKEN` |
| `REWINDBUG_ORIGIN`        | `*`                                | `Access-Control-Allow-Origin`: your app's origin in production                                                    |
| `REWINDBUG_GITHUB_REPO`   | none                               | `owner/name`: open an issue for every new bug                                                                     |
| `REWINDBUG_GITHUB_TOKEN`  | none                               | token with Issues: write; required with `REWINDBUG_GITHUB_REPO`                                                   |
| `REWINDBUG_GITHUB_LABELS` | `bug`                              | labels for new issues, comma-separated                                                                            |
| `REWINDBUG_PUBLIC_URL`    | none                               | the viewer as browsers reach it, view token included, for the recording link in issues                            |

Beyond loopback the server does not start without a token, unless `REWINDBUG_OPEN=1` says that anyone who reaches the port may write reports. On loopback it answers `421` to any `Host` but `127.0.0.1` and `localhost`, so a page from another site cannot reach it through DNS rebinding.

## What it stores

Each report is a pair in `reports/`: `<received>-<id>.json`, the full report with the rrweb recording, and `<received>-<id>.summary.json`, a short summary for listings. The last 100 reports are kept, a report sent again replaces its older copy. The report format: [Report format](../../README.md#report-format). `issues.json` next to `reports/` maps fingerprints to GitHub issues.

To hand the reports to a coding agent, start `rewindbug-mcp` with the same folder in `REWINDBUG_DIR`. Its own receiver is then not needed, but it does no harm.

## Answers

| Status | When                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `200`  | `GET` under the view path: the viewer page, the list `/list`, or a report `/<name>.json`                                |
| `204`  | stored                                                                                                                  |
| `400`  | not JSON, broken gzip, or a field `rewindbug-mcp` needs is off                                                          |
| `404`  | another path, a wrong token, or a report that is not there                                                              |
| `405`  | not `POST` or `OPTIONS` on the report path                                                                              |
| `413`  | over 2 MiB compressed or 32 MiB inflated                                                                                |
| `421`  | foreign `Host` on loopback                                                                                              |
| `500`  | the folder cannot be written                                                                                            |
| `503`  | four reports are already being received; send it again later. A report sent with `sendBeacon` on tab close is lost then |

The SDK keeps a report in its queue on any answer but `2xx` and retries it on `flush()` and on tab close.

This is an example, not a service: no auth beyond the two tokens, no rate limit beyond four reports at a time, no retention beyond 100 reports. Put it behind your own proxy for anything public.
