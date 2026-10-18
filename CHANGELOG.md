# Changelog

## 0.3.0 — 2026-10-18

### rewindbug

- `rewindbug/download`: reports with no server. `initDownload` takes the options of `init` except `endpoint`, and each report downloads as one HTML page with the recording, the steps, the test, the console, the network and the JSON; the page carries the rrweb player and opens offline. The player loads with the first report, not with the page. At most 10 files a page load. The CDN build is `dist/download.browser.js`.

## 0.2.1 — 2026-10-18

### rewindbug

- Elements inside `rb-block` no longer count toward the 25 000-element limit and the mutation burst limit: rrweb does not record them. A page with a huge table keeps its recording when the table has the class `rb-block`.

## 0.2.0 — 2026-10-18

### rewindbug

- `rewindbug/playwright`: a `test` for your own Playwright suite. A failed test gets the report of its failure and of each page error before it, attached as an HTML page with the recording and as JSON. The page carries the rrweb player, so it opens offline and loads nothing. No network and no endpoint: reports reach the test runner directly, so a strict Content Security Policy does not get in the way. Works from ES module and CommonJS projects, `@playwright/test` 1.40 or newer.
- The recording masks secret URL parameters in every stylesheet change: `replace()` and `replaceSync()`, `setProperty()`, adopted stylesheets and `!important` style values went into the report unmasked before.
- `defaultUrlFilter` fails closed: a URL the browser cannot parse, which is exactly the kind an error message quotes, has its secret parameters and `user:password@` masked by pattern instead of passing as is.

### examples/endpoint

- At most `REWINDBUG_GITHUB_MAX_PER_HOUR` GitHub issues and comments an hour, 20 by default: the write token is public, and reports with made-up fingerprints could otherwise open issues without end.

## 0.1.3 — 2026-10-18

### rewindbug

- Next.js `redirect()` and `notFound()` signals (`NEXT_REDIRECT`, `NEXT_NOT_FOUND`, `NEXT_HTTP_ERROR_FALLBACK`) are no longer reported as errors.
- Fingerprints treat long letter-and-digit path segments (cuid, ObjectId, ULID, nanoid) as ids, so the same error on different records is one report.
- Steps skip React 19 `useId` ids (`_r_1_`, `«r1»`) and the library ids built on them (Base UI, Radix, Headless UI).

## 0.1.2 — 2026-10-18

### rewindbug

- README on npm: the demo GIF. No code changes.

## 0.1.1 — 2026-10-18

### rewindbug

- README on npm: npm version and license badges. No code changes.

### rewindbug-mcp

- README on npm: badges, how the server relates to rewindbug and why it is a separate package, support links. No code changes.

## 0.1.0 — 2026-10-17

First working release. `0.0.1` was a name placeholder.

### rewindbug

- Catches uncaught errors, rejected promises, `console.error` and failed requests, and keeps the last seconds of the session in an rrweb buffer.
- On an error, builds a report with reproduction steps in Markdown, a Playwright test, the recording, console, network and page context, and posts it gzip-compressed to your endpoint.
- Private by default: inputs are masked, passwords always stay masked, hidden inputs are not recorded, request bodies are kept only for URLs in `bodyAllowlist`.
- Options for sampling (`sampleRate`), editing or dropping a report (`beforeSend`), tags, custom triggers and URL filters, and a `debug` mode that says why `init` did not start.
- One-file build with rrweb inside for pages without a bundler: `rewindbug/browser`.

### examples/endpoint

- One Node file receives and stores reports in the layout `rewindbug-mcp` reads; a Docker image.
- `/view` plays the recordings with steps, test, console and network. Reading takes a view token of its own, sent in a header: the server makes one on loopback, and beyond loopback it is required. On loopback only pages served from loopback may post reports.
- With `REWINDBUG_GITHUB_REPO` and `REWINDBUG_GITHUB_TOKEN`, every new bug becomes a GitHub issue and a repeat a comment on it.

### rewindbug-mcp

- Receives reports on `127.0.0.1` with a token in the path and stores them in `.rewindbug/reports/`.
- MCP tools `last_bug`, `list_bugs` and `get_bug` hand the bug to Claude Code or Cursor without the rrweb events.
