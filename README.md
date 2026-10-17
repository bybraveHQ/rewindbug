# rewindbug

[![CI](https://github.com/bybraveHQ/rewindbug/actions/workflows/ci.yml/badge.svg)](https://github.com/bybraveHQ/rewindbug/actions/workflows/ci.yml)

When a page breaks in a user's browser, rewindbug turns the last seconds before the error into a bug you can act on: the steps the user took, a Playwright test that repeats them, an rrweb recording of the page, the console and the network. It posts the report to an endpoint of your choice or hands it to your coding agent over MCP (Model Context Protocol). No backend of its own, no widget, nothing for the user to fill in.

**Demo:** [break a page and get the bug](https://bybravehq.github.io/rewindbug/). Nothing leaves the page there: a service worker plays the endpoint.

## What you get

A click on "Apply coupon" in the demo throws. The report from a run of the demo on a local server holds the steps:

```text
1. Click “Checkout” (button)
2. The page goes to http://127.0.0.1:4789/?screen=checkout
3. Type a value into “Name”
4. Click “Apply coupon” (button)

Error: Cannot read properties of undefined (reading 'percent')
```

and the test, unedited:

<!-- prettier-ignore -->
```ts
import { test, expect } from "@playwright/test";

test("Cannot read properties of undefined (reading 'percent')", async ({ page, baseURL }) => {
  // baseURL from the config, else the report's origin; log in via storageState
  const at = (path: string) => new URL(path, baseURL ?? "http://127.0.0.1:4789").href;
  // masked: put your test data here
  const input = {
    "Name": "test",
  };
  const errors: Error[] = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.goto(at("/"));
  await page.getByRole("button", { name: "Checkout", exact: true }).click();
  // the page navigates to http://127.0.0.1:4789/?screen=checkout
  await page.waitForURL((url) => url.pathname === "/" && url.searchParams.get("screen") === "checkout");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(input["Name"]);
  await page.getByRole("button", { name: "Apply coupon", exact: true }).click();
  expect(errors).toEqual([]);
});
```

The test fails on the same error. Fix the code and it passes: keep it as a regression test. The report also carries the recording, the console, the requests with their status and the page context.

## How it works

1. **You install it once:** `init({ endpoint })` in your app, and a place for reports to land: [`rewindbug-mcp`](packages/mcp/README.md) on your machine while you develop, [`examples/endpoint`](examples/endpoint/README.md) on a server for the team, or your own backend.
2. **Your users do nothing.** The page keeps the last seconds in memory. When an error happens, rewindbug builds the report and posts it.
3. **You open the report:** a file in a `reports/` folder, a record in your own backend, or "what is the last bug?" to Claude Code or Cursor.
4. **You run the test,** fix the code, and keep the test.

## What a report holds

The page keeps a rolling buffer in memory and sends nothing until a trigger: an uncaught error, a rejected promise, a request that got a 5xx or never reached your site's server, or your `capture()` call (and `console.error` with `consoleErrorTrigger`); aborted and timed-out requests are not triggers, and neither are the browser's `Script error.` for a cross-origin script and its `ResizeObserver loop` warning. Then rewindbug builds one JSON report from the buffer. Without a recording it reaches `bufferSeconds` (30 by default) back. With one it starts at a recording checkpoint: at least `bufferSeconds` back on a page that has run that long, shorter right after load, and with no upper bound on a quiet page, because a checkpoint is taken on the first DOM event after `bufferSeconds`:

- **trigger**: the error with its message and stack, or the failed request;
- **steps**: up to 100 actions of the user, as Markdown (`Click “Pay” (button)`, `Type a value into “Email”`) and as structured data;
- **test**: a Playwright test that opens the page, repeats the steps and asserts the bug is gone. It starts at the report's path under your `baseURL` (the report's origin when there is none), waits for the navigations the page made, and puts masked values into one `input` object at the top with values each field type accepts (`user@example.com` for an email, `1` for a number, `process.env.TEST_PASSWORD ?? "password"` for a password). A bug that depends on what the user typed needs your values there. It is a draft built from page data: read it before you run it;
- **replay**: the rrweb recording of the same window;
- **console**: up to 200 `console.log`, `info`, `warn`, `error` and `debug` calls; **network**: up to 200 `fetch` and `XMLHttpRequest` calls with status and timing. When a buffer overflowed inside the window, `limits.truncated` names it;
- **context**: URL, referrer, title, viewport, user agent, language, time zone, your release and tags.

Limits of the steps and the test: they start where the buffer starts, so a login or an open dialog from before it is not restored; a full page load in a multi-page app clears the buffer; clicks inside an iframe, drag, right clicks and keys other than Enter, Escape and Tab are not steps, typing and clicks inside an open shadow root are steps on the element itself, inside a closed one on its host; a test from `capture(error)` checks that the error is no longer logged when the page logged it before the call, and otherwise has only a comment where to put the assertion; the test waits before its check as long as the error took after the last step. Stacks are not mapped through source maps.

## Install

### An app with a bundler

```bash
npm install rewindbug
```

The package is ESM only.

```ts
import { init } from "rewindbug";

// your own route; for a first try see "With a coding agent" below
init({ endpoint: "/api/bugs" });
```

Two calls for later, where your code needs them:

```ts
import { capture, flush } from "rewindbug";

// report something that did not throw, with tags for this one report
capture(new Error("Checkout total is negative"), {
  tags: { orderId: "48213" },
});

// send what is queued now, for example before a test ends
void flush();
```

Call `init` once and as early as you can, in code that runs in the browser: errors before it are not seen, and a second call is ignored together with its options, even after a first call that returned `false`. It returns `false` and does nothing when the browser lacks a required API, the endpoint is not an `http:`/`https:` URL (a relative one such as `/api/bugs` is resolved against the page) or the page load falls outside `sampleRate`, or setup fails; `debug: true` prints the reason with `console.warn`. To see it work, call `capture(new Error("test"))`, for example in a click handler, and look for the `POST` to your endpoint in the Network tab. Importing the package has no side effects, so the import is safe in SSR code. The package exports its types (`Report`, `Step`, `NetworkEntry` and the rest) and the default rules `defaultUrlFilter` and `defaultNetworkTrigger`.

rewindbug sees uncaught errors and rejected promises. An error your framework catches never reaches it: pass it to `capture`.

| Framework            | Where to call `capture(error)`                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| React                | an error boundary's `componentDidCatch`, or `onError` of `react-error-boundary`                                                    |
| Next.js (App Router) | `useEffect(() => capture(error), [error])` in `app/error.tsx`; `init` in `instrumentation-client.ts` (15.3+) or a client component |
| Vue                  | `app.config.errorHandler = (error) => { console.error(error); capture(error); }`                                                   |
| Angular              | `handleError(error) { console.error(error); capture(error); }` in your `ErrorHandler`                                              |

Log the error before `capture`, as in the Vue and Angular lines: their handlers replace the framework's own logging, and the test rewindbug generates for such a report fails while that error is logged. React logs a caught error itself.

Your own end-to-end tests load the page too, and every failing run would send a report, the regression tests rewindbug generates included. Playwright, Selenium and other WebDriver tools set `navigator.webdriver`, so skip `init` there:

```ts
if (!navigator.webdriver) init({ endpoint: "/api/bugs" });
```

Use an environment variable of your build instead if the test run should be told apart in another way.

### A page without a bundler

Import the single-file build, rrweb included, about 35 kB gzip:

```html
<script type="module">
  import { init } from "https://cdn.jsdelivr.net/npm/rewindbug@0.1/dist/rewindbug.browser.js";

  init({ endpoint: "https://bugs.example.com/report" });
</script>
```

For a first try, run [`examples/endpoint`](examples/endpoint/README.md) from a clone of this repo and use `http://127.0.0.1:7358/report`. `@0.1` is for a first try: pin an exact version such as `@0.1.0` in production, the script sees the whole page. With a Content Security Policy, allow the CDN in `script-src`. With a bundler the same file is `rewindbug/browser`, but plain `rewindbug` is better there: it shares `@rrweb/record` with anything else that uses it.

### With a coding agent

`rewindbug-mcp` needs Node 22 or newer. Install `rewindbug` as in [An app with a bundler](#an-app-with-a-bundler), then register [`rewindbug-mcp`](packages/mcp/README.md) with your agent; the Cursor config is in its README:

```bash
claude mcp add rewindbug --env REWINDBUG_DIR=/absolute/path/to/your-app/.rewindbug -- npx -y rewindbug-mcp
```

Start a new agent session after adding it. The agent starts the server itself. Ask it "what is the last bug?": with no reports yet it answers with the endpoint, a localhost URL with a token. Keep it out of git: put it into the local, uncommitted env file your bundler reads, as `VITE_REWINDBUG_ENDPOINT=http://127.0.0.1:7357/<token>` in Vite, restart the dev server, and start rewindbug with it:

```ts
import { init } from "rewindbug";

// Vite; in Next.js: process.env.NEXT_PUBLIC_REWINDBUG_ENDPOINT
const endpoint = import.meta.env.VITE_REWINDBUG_ENDPOINT;
if (endpoint) init({ endpoint });
```

Add `.rewindbug/` to your app's `.gitignore`: it holds the token and the reports.

From then on the same question gets the newest bug: the steps, the trigger, the console, the network and the test, without the recording.

### Next to Sentry

Both run on one page. rewindbug wraps `fetch`, `XMLHttpRequest`, `console.log`, `info`, `warn`, `error` and `debug`, `history.pushState` and `replaceState`, and listens to `error` and `unhandledrejection`; other SDKs that wrap the same functions keep working, and the one initialized last sees the calls first. Sentry Session Replay and rewindbug each run rrweb: keep one recording, with `replay: false` here or without the Replay integration there. To find a report next to its Sentry event, tag it with the event id:

```tsx
<Sentry.ErrorBoundary
  onError={(error, _stack, eventId) =>
    capture(error, { tags: { sentry: eventId } })
  }
>
  <App />
</Sentry.ErrorBoundary>
```

## Options

| Option                | Default                                       | What it is for                                                                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`            | required                                      | where reports are posted                                                                                                                                                                                                                                                         |
| `bufferSeconds`       | `30`                                          | how far back a report reaches, at least `5`, see [What a report holds](#what-a-report-holds)                                                                                                                                                                                     |
| `replay`              | `true`                                        | `false` keeps steps, console and network but records no DOM                                                                                                                                                                                                                      |
| `maskInputs`          | `true`                                        | `false` shows typed values except passwords, for test environments only. To show one field, such as a coupon or a search box, mark it or a parent with `data-rb-unmask`: a password and a field under `maskSelector` stay masked                                                 |
| `maskSelector`        | `""`                                          | CSS selector whose text is masked in the recording and the steps. An invalid selector turns the recording off                                                                                                                                                                    |
| `bodyAllowlist`       | `[]`                                          | request and response bodies kept only for these URLs: a string is an absolute URL and matches the request's `origin + path` or a path below it (`https://api.example.com/v1` covers `/v1/cart`, not `/v10`), a `RegExp` is tested on the full URL. See [Privacy](#privacy) first |
| `urlFilter`           | masks secret query parameters                 | `(url, defaultFilter) => string` for the URLs in the report. Call `defaultFilter(url)` inside to keep its removal of `user:pass@`, secret parameters and `#…=…` fragments; return something else and it no longer applies                                                        |
| `networkTrigger`      | status ≥ 500, or a network error on your site | `(entry, defaultTrigger) => boolean`: which requests count as a bug; `entry.error` is `"network"`, `"abort"` or `"timeout"`, the fields are in [Report format](#report-format). `defaultTrigger(entry) \|\| entry.status === 409` adds to the default                            |
| `consoleErrorTrigger` | `false`                                       | `true` when `console.error` in your app always means a bug                                                                                                                                                                                                                       |
| `maxReportBytes`      | `524288`                                      | target size of a compressed report: over it bodies go first, then the recording. A report still over it after that is sent anyway                                                                                                                                                |
| `sampleRate`          | `1`                                           | share of page loads that start at all, `0.1` for one in ten. The choice is made once in `init`: a page load outside it records nothing and costs nothing                                                                                                                         |
| `beforeSend`          | none                                          | `(report) => report \| null`, called before compression: change the report, or return `null` to drop it. It must be synchronous: a returned promise drops the report, and so does a `beforeSend` that throws                                                                     |
| `debug`               | `false`                                       | `true` prints why `init` did not start                                                                                                                                                                                                                                           |
| `app`, `tags`         | none                                          | `app: { release, environment }` and `tags: { key: "value" }`, copied into the report; `capture(error, { tags })` adds tags to one report                                                                                                                                         |

A request that never gets a response is a network error. By default it is a trigger only when the request goes to the page's own site: the page host, its parent domain and that domain's subdomains (`app.shop.com` covers `shop.com` and `api.shop.com`; an IP address covers itself only). The parent is the host without its first label, so on `app.example.co.uk` it is `example.co.uk`, but on `example.co.uk` itself it is `co.uk`; pass your own `networkTrigger` there. A third-party script stopped by an ad blocker is not a bug of your page. A 5xx answer is a trigger from any host.

## Where reports go

The SDK posts each report with `fetch` and `credentials: "omit"`. When the tab is hidden or closed, queued reports of 60 KiB or less that are not already being sent go with `sendBeacon`. If the tab is closed, larger reports, reports still being compressed and requests still in flight are lost; a hidden tab keeps them queued. Any `2xx` answer removes a report from the queue; anything else keeps it for the next `flush()` or tab hide. A report handed to `sendBeacon` leaves the queue whether it arrives or not. Requests to your own endpoint are not recorded in reports. The queue lives in page memory: a reload drops it.

- **To a coding agent:** [`rewindbug-mcp`](packages/mcp/README.md) receives reports on localhost and hands the last bug to Claude Code or Cursor over MCP. Register it as shown in [With a coding agent](#with-a-coding-agent).
- **To a folder on a server:** [`examples/endpoint`](examples/endpoint/README.md), two files on Node with a Docker image. It writes the folder layout `rewindbug-mcp` reads, plays the recordings in the browser behind a token of its own and, with a repo and a token set, opens a GitHub issue for every new bug with the steps and the test.
- **To your own backend:**
  - the body is gzip-compressed JSON sent as `text/plain`, without `Content-Encoding`: detect gzip by its first bytes `1f 8b`. The fields are in [Report format](#report-format);
  - on another origin, answer with `Access-Control-Allow-Origin`: without it the browser hides the answer, and the report stays queued and comes again;
  - a report can arrive twice in other cases too: store it by its `id`;
  - no `Authorization` header can be sent: put a token in the path if you need one, knowing it is visible in your client code;
  - allow bodies a bit over `maxReportBytes`, and add the endpoint to `connect-src` if your page has a Content Security Policy.

## Report format

Every report is one JSON object. Times are Unix milliseconds. The TypeScript types ship with the package: `import type { Report } from "rewindbug"`.

| Field           | What it holds                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | `0`                                                                                                                                                                                                                                                           |
| `id`            | UUID v4 of the report; store by it, a report can arrive twice                                                                                                                                                                                                 |
| `fingerprint`   | short hash of the trigger: the same for the same error on the same page path, or the same failing request; a `capture()` gets a unique one                                                                                                                    |
| `createdAt`     | when the report was built                                                                                                                                                                                                                                     |
| `sdk`           | `{ name: "rewindbug", version, rrwebVersion }`                                                                                                                                                                                                                |
| `trigger`       | `{ kind, at, message, error?, requestId? }`: `kind` is `error`, `unhandledrejection`, `console.error`, `network` or `manual`; `error` is `{ name, message, stack? }`; `requestId` points into `network`                                                       |
| `context`       | `{ url, referrer?, title, userAgent, language, timezone, viewport: { width, height, dpr }, app?, tags? }`                                                                                                                                                     |
| `range`         | `{ start, end, startUrl }`: the window the report covers and the address the test starts from                                                                                                                                                                 |
| `steps`         | `{ t, kind, target?, value?, masked?, inputType?, checked?, key?, x?, y?, url?, from?, popstate?, requestIds? }[]`; `kind` is `navigate`, `click`, `fill`, `check`, `select`, `press` or `scroll`; `target` is `{ testId?, role?, name?, css, unique, nth? }` |
| `stepsMarkdown` | the steps as a numbered Markdown list ending with the error                                                                                                                                                                                                   |
| `test`          | the Playwright test as source text                                                                                                                                                                                                                            |
| `console`       | `{ t, level, message }[]`                                                                                                                                                                                                                                     |
| `network`       | `{ id, t, type, method, url, state, status?, durationMs?, error?, contentType?, requestBody?, responseBody? }[]`; `type` is `fetch` or `xhr`, `state` is `pending`, `done` or `failed`, `error` is `network`, `abort` or `timeout`                            |
| `replay`        | `{ format: "rrweb", events }` to play with [`@rrweb/replay`](https://www.npmjs.com/package/@rrweb/replay), or `null`                                                                                                                                          |
| `limits`        | `{ truncated, mutationStorm?, replayState? }`: what was cut (`body`, `console`, `network`, `steps`, `replay`) and why there is no recording                                                                                                                   |

The schema is version `0` and may still change between minor versions of the package.

## Privacy

| Data                                                                                            | Default                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typed values in inputs, textareas, selects                                                      | masked in the recording, the steps and the test (`maskInputs`), except fields under `data-rb-unmask`; passwords always, see below                                                                                                            |
| hidden inputs (`type="hidden"`) and `<meta>` tags whose name contains `csrf`, `xsrf` or `token` | never recorded: CSRF and session tokens live there                                                                                                                                                                                           |
| page text, button and link names, `title`                                                       | **kept**: the steps need them. Mask parts of the page with `maskSelector`                                                                                                                                                                    |
| console messages, error messages and stacks                                                     | **kept as is**: `console.log(user)` puts the user into the report. Only `http(s)` and `ws(s)` URLs inside them pass `urlFilter`. Redact or drop them in `beforeSend`: the console is in `report.console` and again in `report.replay.events` |
| request and response bodies                                                                     | not collected unless the URL is in `bodyAllowlist`                                                                                                                                                                                           |
| bodies of allowlisted URLs                                                                      | **kept as is, unmasked**: allowlist only endpoints without secrets and personal data, not a whole API origin with `/login` in it                                                                                                             |
| query parameters named like secrets                                                             | value replaced with `*` by the default filter (below)                                                                                                                                                                                        |
| other query parameters, ids and classes in selectors                                            | **kept**                                                                                                                                                                                                                                     |
| attributes in the recording (`data-*`, `aria-label`, `placeholder`, `alt`)                      | **kept**: `maskSelector` masks text only; `rb-block` leaves a whole block out of the recording                                                                                                                                               |
| login and password in URLs (`user:pass@`)                                                       | removed by the default filter                                                                                                                                                                                                                |
| `#…` fragments containing `=`                                                                   | removed by the default filter                                                                                                                                                                                                                |
| cookies, request headers, `localStorage`                                                        | never collected                                                                                                                                                                                                                              |

A field counts as a password when it is or was `type="password"` when it got focus, when rrweb saw a "show password" toggle change it, or when its `autocomplete`, `name` or `id` contains `pass` or `pwd`. Such a field stays masked even with `maskInputs: false` or under `data-rb-unmask`, and its mask in the recording is always eight asterisks, so the length of the password is not kept either. A field that matches none of these is recorded as typed under `data-rb-unmask` or with `maskInputs: false`, so give a custom password field one of them.

The default filter masks a query parameter when its whole name is one of `token`, `key`, `secret`, `pass`, `password`, `auth`, `session`, `code`, `sig`, `signature`, `jwt`, `otp`, optionally after a prefix that ends in `_` or `-`: `api_key` and `x-auth` are masked, `apiKey`, `accessToken` and `authorization` are not. Cover those with your own `urlFilter`.

Which bodies are kept for allowlisted URLs: a request body passed as a string or `URLSearchParams` of at most 10 000 characters (not `FormData` or a `Request` object); a `fetch` response of type JSON, `application/x-www-form-urlencoded` or text with a `Content-Length` of at most 10 000, a larger or chunked one is left out; an `XMLHttpRequest` text response of the same types cut to its first 10 000 characters.

Turning things off:

- no DOM recording at all: `replay: false`;
- a block of the page left out of the recording: the class `rb-block` on its element. Steps keep clicks inside it with a CSS selector, ids and classes included, but no text, names or values;
- your own rules for URLs: `urlFilter`;
- anything else, report by report: `beforeSend`.

Known gaps in this version:

- secrets inside the URL path (`/reset/<token>`) are not cut;
- `href` and `src` attributes inside the recorded DOM do not pass `urlFilter`;
- text typed into `contenteditable` elements is visible in the recording unless they are under `maskSelector`;
- `sendBeacon` when the tab is hidden or closed sends the endpoint's cookies: a beacon cannot omit them, `fetch` does;
- everything in a report came from the page, including text an attacker could have put there. Treat it as data, and read the generated test before you run it.

## Cost

Measured with `pnpm bench` in a clone of this repo (`pnpm bench -- --report` for the report row): four synthetic pages (a 10 000-row table, a canvas animation, a 60-field form, an SPA screen) in Chromium with the CPU slowed 4×, median of five runs.

| What                        | Measured                                                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bundle, core without rrweb  | 14.0 kB gzip (`size-limit`, budget 15 kB, checked in CI)                                                                                                                                           |
| bundle with `@rrweb/record` | about 35 kB gzip: `dist/rewindbug.browser.js` (`size-limit` reports 35.3 kB), budget 40 kB, checked in CI                                                                                          |
| rewindbug on top of rrweb   | no measurable INP or TBT and under 0.2 MB of heap on the canvas, form and SPA pages; the table page is over the element limit and records nothing                                                  |
| rrweb recording itself      | about 16 ms of INP at 4× slowdown on an interaction that re-renders much of the DOM, so about 4–5 ms on a regular CPU; 1–3 MB of heap                                                              |
| full DOM snapshot           | at the start of recording and every `bufferSeconds`, blocking the main thread for a time that grows with the DOM; `pnpm bench` does not measure it near the 25 000-element limit                   |
| a report                    | 1–55 KiB compressed on the bench pages, most of it the recording (the largest is the SPA screen with a 200-item list); built and posted 40–65 ms after the trigger, without a long task over 50 ms |

Recording starts after the page `load` event, in idle time, so an error before that comes without a recording. The snapshot cost is why recording does not start, or stops, when the page has more than 25 000 elements, and stops on a burst of more than 10 000 DOM mutations in a second; it does not resume until the page reloads, and a navigation inside a single-page app does not restart it. Why a report has no recording is in `limits.replayState`: `not-started`, `dom-too-large`, `stopped` (after a mutation burst or more than 20 000 events in the buffer, then `limits.mutationStorm` is `true`; or an invalid `maskSelector`; or an rrweb error), `too-large` (cut to fit `maxReportBytes`) or `off` (`replay: false`).

One page load sends at most 10 reports, `capture()` included. The same error is reported once a minute; `capture()` is never deduplicated.

## Browser support

| Engine                                                                                        | Minimum engine version |
| --------------------------------------------------------------------------------------------- | ---------------------- |
| Chromium: Chrome, Edge, Android WebView; Opera and Samsung Internet number their own versions | 94                     |
| Gecko: Firefox                                                                                | 113                    |
| WebKit: Safari, every browser on iOS                                                          | 16.4                   |

The minimums come from compatibility data. Before the 0.1.0 release the browser build was run by hand on Firefox 113 and WebKit 16.4, and on Chromium 97, the oldest build Playwright ships for Apple silicon: it started, recorded and sent reports with steps and a test. CI runs the latest Chromium, Firefox and WebKit. On an engine that parses the bundle but lacks `CompressionStream` or another required API, `init` returns `false` silently. Below the minimum the bundle may fail to parse. If such clients matter to you, load the package with a dynamic `import()` inside `try`, in a chunk of its own.

## Status

Version 0.x. The report schema is `v0` and may still change between minor versions; `schemaVersion` in every report says which one you got.

## Support

If this package saves you time, you can support maintenance:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-buy%20me%20a%20coffee-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/bybrave)
[![Bitcoin](https://img.shields.io/badge/Bitcoin-BTC-F7931A?logo=bitcoin&logoColor=white)](#support)

Bitcoin (BTC): `bc1q37557q5jpeaxqydzwvf3jgj7zhnfpn2td3q40q`

## License

MIT
