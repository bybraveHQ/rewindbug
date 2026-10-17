# rewindbug endpoint example

One file, Node 22, no dependencies. It receives the reports the [rewindbug](../../README.md) SDK posts and stores them in a folder, in the same layout [`rewindbug-mcp`](../../packages/mcp/README.md) reads. Copy `server.mjs` into your project or run the Docker image.

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
docker run -p 7358:7358 -v "$PWD/.rewindbug:/data" -e REWINDBUG_TOKEN=<long random string> rewindbug-endpoint
```

The endpoint then is `http://<host>:7358/report/<token>`. Put it into your app from an environment variable, not into git.

## Settings

| Variable           | Default                            | Meaning                                                        |
| ------------------ | ---------------------------------- | -------------------------------------------------------------- |
| `PORT`             | `7358`                             | `0` picks a free port                                          |
| `HOST`             | `127.0.0.1`                        | `0.0.0.0` in the Docker image                                  |
| `REWINDBUG_DIR`    | `.rewindbug` in the working folder | reports go to `reports/` inside it                             |
| `REWINDBUG_TOKEN`  | none                               | the path becomes `/report/<token>`; required beyond loopback   |
| `REWINDBUG_OPEN`   | none                               | `1` lets the server listen beyond loopback without a token     |
| `REWINDBUG_ORIGIN` | `*`                                | `Access-Control-Allow-Origin`: your app's origin in production |

Beyond loopback the server does not start without a token, unless `REWINDBUG_OPEN=1` says that anyone who reaches the port may write reports. On loopback it answers `421` to any `Host` but `127.0.0.1` and `localhost`, so a page from another site cannot reach it through DNS rebinding.

## What it stores

Each report is a pair in `reports/`: `<received>-<id>.json`, the full report with the rrweb recording, and `<received>-<id>.summary.json`, a short summary for listings. The last 100 reports are kept, a report sent again replaces its older copy. The report format: [Report format](../../README.md#report-format).

To hand the reports to a coding agent, start `rewindbug-mcp` with the same folder in `REWINDBUG_DIR`. Its own receiver is then not needed, but it does no harm.

## Answers

| Status | When                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `204`  | stored                                                                                                                  |
| `400`  | not JSON, broken gzip, or a field `rewindbug-mcp` needs is off                                                          |
| `404`  | another path, or a wrong token                                                                                          |
| `405`  | not `POST` or `OPTIONS`                                                                                                 |
| `413`  | over 2 MiB compressed or 32 MiB inflated                                                                                |
| `421`  | foreign `Host` on loopback                                                                                              |
| `500`  | the folder cannot be written                                                                                            |
| `503`  | four reports are already being received; send it again later. A report sent with `sendBeacon` on tab close is lost then |

The SDK keeps a report in its queue on any answer but `2xx` and retries it on `flush()` and on tab close.

This is an example, not a service: no auth beyond the token, no rate limit beyond four reports at a time, no retention beyond 100 reports. Put it behind your own proxy for anything public.
