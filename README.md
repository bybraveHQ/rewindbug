# rewindbug

[![CI](https://github.com/bybraveHQ/rewindbug/actions/workflows/ci.yml/badge.svg)](https://github.com/bybraveHQ/rewindbug/actions/workflows/ci.yml)

Rewind the last seconds before a browser error into a ready bug report: reproduction steps, an rrweb recording, console, network and a Playwright test that repeats the path to the error. An ESM package with one dependency, `@rrweb/record`, and a single-file build for pages without a bundler; no framework, no backend: the report goes to any endpoint you choose.

**Demo:** [break a page and get the bug](https://bybravehq.github.io/rewindbug/). Nothing leaves the page there: a service worker plays the endpoint.

## What a report holds

The page keeps a rolling buffer in memory and sends nothing until a trigger: an uncaught error, a rejected promise, a request that got a 5xx or never reached the server, or your `capture()` call; aborted and timed-out requests are not triggers. Then rewindbug builds one JSON report from the buffer. Without a recording it reaches `bufferSeconds` (30 by default) back. With one it starts at a recording checkpoint: at least `bufferSeconds` back on a page that has run that long, shorter right after load, and with no upper bound on a quiet page, because a checkpoint is taken on the first DOM event after `bufferSeconds`:

- **trigger**: the error with its message and stack, or the failed request;
- **steps**: up to 100 actions of the user, as Markdown (`Click “Pay” (button)`, `Type a value into “Email”`) and as structured data;
- **test**: a Playwright test that opens the page, repeats the steps and asserts the bug is gone. It is a draft built from page data: read it before you run it;
- **replay**: the rrweb recording of the same window;
- **console**: up to 200 `console.log`, `info`, `warn`, `error` and `debug` calls; **network**: up to 200 `fetch` and `XMLHttpRequest` calls with status and timing. When a buffer overflowed inside the window, `limits.truncated` names it;
- **context**: URL, referrer, title, viewport, user agent, language, time zone, your release and tags.

Limits of the steps and the test: they start where the buffer starts, so a login or an open dialog from before it is not restored; a full page load in a multi-page app clears the buffer; clicks inside an iframe, drag, right clicks and keys other than Enter, Escape and Tab are not steps, and a click inside shadow DOM is a step on its host element; a test from `capture()` has no assertion, only a comment where to put it. Stacks are not mapped through source maps.

## Install

```bash
npm install rewindbug
```

```ts
import { init, capture, flush } from "rewindbug";

init({ endpoint: "https://bugs.example.com/report" });

// optional: report something that did not throw
capture(new Error("Checkout total is negative"));

// optional: send what is queued now, for example before a test ends
await flush();
```

Call `init` once and as early as you can: errors before it are not seen, and a second call is ignored together with its options, even after a first call that returned `false`. It returns `false` and does nothing when the browser lacks a required API or the endpoint is not an absolute `http:`/`https:` URL, so check the result. To see it work, call `capture(new Error("test"))` and look for the `POST` to your endpoint in the Network tab. The package exports its types: `Report`, `Step`, `NetworkEntry` and the rest. Importing the package has no side effects, so the import is safe in SSR code; `init` only works in the browser.

rewindbug wraps `fetch`, `XMLHttpRequest`, `console.*`, `history.pushState` and `replaceState`, and listens to `error` and `unhandledrejection`. Other SDKs that wrap the same functions keep working; the one initialized last sees the calls first. An error caught by a React error boundary or a framework error handler is not uncaught: pass it to `capture(error)` there.

Without a bundler, import the single-file build, rrweb included, about 35 kB gzip:

```html
<script type="module">
  import { init } from "https://cdn.jsdelivr.net/npm/rewindbug@0.1/dist/rewindbug.browser.js";

  init({ endpoint: "https://bugs.example.com/report" });
</script>
```

Pin an exact version in production: the script sees the whole page. With a Content Security Policy, allow the CDN in `script-src`. With a bundler the same file is `rewindbug/browser`, but plain `rewindbug` is better there: it shares `@rrweb/record` with anything else that uses it.

## Options

| Option                | Default                       | What it is for                                                                                                                                                                                                                                                                   |
| --------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`            | required                      | where reports are posted                                                                                                                                                                                                                                                         |
| `bufferSeconds`       | `30`                          | how far back a report reaches, see [What a report holds](#what-a-report-holds)                                                                                                                                                                                                   |
| `replay`              | `true`                        | `false` keeps steps, console and network but records no DOM                                                                                                                                                                                                                      |
| `maskInputs`          | `true`                        | `false` shows typed values, for test environments only                                                                                                                                                                                                                           |
| `maskText`            | `""`                          | CSS selector whose text is masked in the recording and the steps. An invalid selector turns the recording off                                                                                                                                                                    |
| `bodyAllowlist`       | `[]`                          | request and response bodies kept only for these URLs: a string is an absolute URL and matches the request's `origin + path` or a path below it (`https://api.example.com/v1` covers `/v1/cart`, not `/v10`), a `RegExp` is tested on the full URL. See [Privacy](#privacy) first |
| `urlFilter`           | masks secret query parameters | `(url) => string` for the URLs in the report. It replaces the default rule entirely, including the removal of `user:pass@` and of `#…=…` fragments                                                                                                                               |
| `networkTrigger`      | status ≥ 500 or network error | `(entry) => boolean`: which requests count as a bug; `entry.error` is `"network"`, `"abort"` or `"timeout"`, the fields are in [Report format](#report-format). It replaces the default: keep `entry.status >= 500 \|\| entry.error === "network"` in it if you still want those |
| `consoleErrorTrigger` | `false`                       | `true` when `console.error` in your app always means a bug                                                                                                                                                                                                                       |
| `maxReportBytes`      | `524288`                      | target size of a compressed report: over it bodies go first, then the recording. A report still over it after that is sent anyway                                                                                                                                                |
| `app`, `tags`         | none                          | `app: { release, environment }` and `tags: { key: "value" }`, copied into the report                                                                                                                                                                                             |

A request that never reaches the server, for example one stopped by an ad blocker or by going offline, is a network error and a trigger by default.

## Where reports go

The SDK posts each report with `fetch` and `credentials: "omit"`. When the tab is hidden or closed, queued reports of 60 KiB or less that are not already being sent go with `sendBeacon`. If the tab is closed, larger reports, reports still being compressed and requests still in flight are lost; a hidden tab keeps them queued. Any `2xx` answer removes a report from the queue; anything else keeps it for the next `flush()` or tab hide. A report handed to `sendBeacon` leaves the queue whether it arrives or not. Requests to your own endpoint are not recorded in reports. The queue lives in page memory: a reload drops it.

- **To a coding agent:** [`rewindbug-mcp`](packages/mcp/README.md) receives reports on localhost and hands the last bug to Claude Code or Cursor over MCP. It is not on npm yet: build it from this repo.
- **To a folder on a server:** [`examples/endpoint`](examples/endpoint/README.md), one Node file with a Docker image. It writes the folder layout `rewindbug-mcp` reads.
- **To your own backend:**
  - the body is gzip-compressed JSON sent as `text/plain`, without `Content-Encoding`: detect gzip by its first bytes `1f 8b`. The fields are in [Report format](#report-format);
  - on another origin, answer with `Access-Control-Allow-Origin`: without it the browser hides the answer, and the report stays queued and comes again;
  - a report can arrive twice in other cases too: store it by its `id`;
  - no `Authorization` header can be sent: put a token in the path if you need one, knowing it is visible in your client code;
  - allow bodies a bit over `maxReportBytes`, and add the endpoint to `connect-src` if your page has a Content Security Policy.

## Report format

Every report is one JSON object. Times are Unix milliseconds. The TypeScript types ship with the package: `import type { Report } from "rewindbug"`.

| Field           | What it holds                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | `0`                                                                                                                                                                                                                                    |
| `id`            | UUID v4 of the report; store by it, a report can arrive twice                                                                                                                                                                          |
| `fingerprint`   | short hash of the trigger, the same for the same error on the same page path                                                                                                                                                           |
| `createdAt`     | when the report was built                                                                                                                                                                                                              |
| `sdk`           | `{ name: "rewindbug", version, rrwebVersion }`                                                                                                                                                                                         |
| `trigger`       | `{ kind, at, message, error?, requestId? }`: `kind` is `error`, `unhandledrejection`, `console.error`, `network` or `manual`; `error` is `{ name, message, stack? }`; `requestId` points into `network`                                |
| `context`       | `{ url, referrer?, title, userAgent, language, timezone, viewport: { width, height, dpr }, app?, tags? }`                                                                                                                              |
| `range`         | `{ start, end, startUrl }`: the window the report covers and the address the test starts from                                                                                                                                          |
| `steps`         | `{ t, kind, target?, value?, masked?, checked?, key?, x?, y?, url?, from?, requestIds? }[]`; `kind` is `navigate`, `click`, `fill`, `check`, `select`, `press` or `scroll`; `target` is `{ testId?, role?, name?, css, unique, nth? }` |
| `stepsMarkdown` | the steps as a numbered Markdown list ending with the error                                                                                                                                                                            |
| `test`          | the Playwright test as source text                                                                                                                                                                                                     |
| `console`       | `{ t, level, message }[]`                                                                                                                                                                                                              |
| `network`       | `{ id, t, type, method, url, state, status?, durationMs?, error?, contentType?, requestBody?, responseBody? }[]`; `type` is `fetch` or `xhr`, `state` is `pending`, `done` or `failed`, `error` is `network`, `abort` or `timeout`     |
| `replay`        | `{ format: "rrweb", events }` to play with [`@rrweb/replay`](https://www.npmjs.com/package/@rrweb/replay), or `null`                                                                                                                   |
| `limits`        | `{ truncated, mutationStorm?, replayState? }`: what was cut (`body`, `console`, `network`, `steps`, `replay`) and why there is no recording                                                                                            |

The schema is version `0` and may still change between minor versions of the package.

## Privacy

| Data                                        | Default                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| typed values in inputs, textareas, selects  | masked in the recording, the steps and the test (`maskInputs`)                                                                                    |
| page text, button and link names, `title`   | **kept**: the steps need them. Mask parts of the page with `maskText`                                                                             |
| console messages, error messages and stacks | **kept as is**: `console.log(user)` puts the user into the report. Only URLs inside them pass `urlFilter`. There is no option to drop the console |
| request and response bodies                 | not collected unless the URL is in `bodyAllowlist`                                                                                                |
| bodies of allowlisted URLs                  | **kept as is, unmasked**: allowlist only endpoints without secrets and personal data, not a whole API origin with `/login` in it                  |
| query parameters named like secrets         | value replaced with `*` by the default filter (below)                                                                                             |
| login and password in URLs (`user:pass@`)   | removed by the default filter                                                                                                                     |
| `#…` fragments containing `=`               | removed by the default filter                                                                                                                     |
| cookies, request headers, `localStorage`    | never collected                                                                                                                                   |

The default filter masks a query parameter when its whole name is one of `token`, `key`, `secret`, `pass`, `password`, `auth`, `session`, `code`, `sig`, `signature`, `jwt`, `otp`, optionally after a prefix that ends in `_` or `-`: `api_key` and `x-auth` are masked, `apiKey`, `accessToken` and `authorization` are not. Cover those with your own `urlFilter`.

Which bodies are kept for allowlisted URLs: a request body passed as a string or `URLSearchParams` of at most 10 000 characters (not `FormData` or a `Request` object); a `fetch` response of type JSON, `application/x-www-form-urlencoded` or text with a `Content-Length` of at most 10 000, a larger or chunked one is left out; an `XMLHttpRequest` text response of the same types cut to its first 10 000 characters.

Turning things off:

- no DOM recording at all: `replay: false`;
- a block of the page left out of the recording: the class `rb-block` on its element;
- your own rules for URLs: `urlFilter`.

Known gaps in this version:

- secrets inside the URL path (`/reset/<token>`) are not cut;
- `href` and `src` attributes inside the recorded DOM do not pass `urlFilter`;
- text typed into `contenteditable` elements is visible in the recording unless they are under `maskText`;
- `sendBeacon` when the tab is hidden or closed sends the endpoint's cookies: a beacon cannot omit them, `fetch` does;
- everything in a report came from the page, including text an attacker could have put there. Treat it as data, and read the generated test before you run it.

## Cost

Measured on four synthetic pages (a 10 000-row table, a canvas animation, a 60-field form, an SPA screen) in Chromium with the CPU slowed 4×, median of five runs.

| What                        | Measured                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bundle, core without rrweb  | 12.2 kB gzip (`size-limit`, budget 13 kB, checked in CI)                                                                                                                                                  |
| bundle with `@rrweb/record` | about 35 kB gzip: `dist/rewindbug.browser.js` (`size-limit` reports 34.05 kB), budget 40 kB, checked in CI                                                                                                |
| rewindbug on top of rrweb   | no measurable INP, TBT or heap on the canvas, form and SPA pages; the table page is over the element limit and records nothing                                                                            |
| rrweb recording itself      | about 16 ms of INP at 4× slowdown on an interaction that re-renders much of the DOM, so about 4–5 ms on a regular CPU; 1–3 MB of heap                                                                     |
| full DOM snapshot           | at the start of recording and every `bufferSeconds`, blocking the main thread for a time that grows with the DOM: 1.1 s for 90 000 nodes at 4× slowdown; not measured just below the 25 000-element limit |
| a report                    | 1–55 KiB compressed on those pages, most of it the recording (the largest is the SPA screen with a 200-item list); built and posted 40–70 ms after the trigger, without a long task over 50 ms            |

Recording starts after the page `load` event, in idle time, so an error before that comes without a recording. The snapshot cost is why recording does not start, or stops, when the page has more than 25 000 elements, and stops on a burst of more than 10 000 DOM mutations in a second; it does not resume until the page reloads, and a navigation inside a single-page app does not restart it. Why a report has no recording is in `limits.replayState`: `not-started`, `dom-too-large`, `stopped` (after a mutation burst or more than 20 000 events in the buffer, then `limits.mutationStorm` is `true`; or an invalid `maskText`; or an rrweb error), `too-large` (cut to fit `maxReportBytes`) or `off` (`replay: false`).

One page load sends at most 10 reports, `capture()` included. The same error is reported once a minute; `capture()` is never deduplicated.

## Browser support

| Engine                                                                                        | Minimum engine version |
| --------------------------------------------------------------------------------------------- | ---------------------- |
| Chromium: Chrome, Edge, Android WebView; Opera and Samsung Internet number their own versions | 94                     |
| Gecko: Firefox                                                                                | 113                    |
| WebKit: Safari, every browser on iOS                                                          | 16.4                   |

The minimums come from compatibility data and are not tested; CI runs the latest Chromium, Firefox and WebKit. On an engine that parses the bundle but lacks `CompressionStream` or another required API, `init` returns `false` silently. Below the minimum the bundle may fail to parse. If such clients matter to you, load the package with a dynamic `import()` inside `try`, in a chunk of its own.

## Status

Version 0.x. The report schema is `v0` and may still change between minor versions; `schemaVersion` in every report says which one you got.

## License

MIT
