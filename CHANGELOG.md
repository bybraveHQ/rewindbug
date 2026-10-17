# Changelog

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
- `/view` plays the recordings with steps, test, console and network; beyond loopback it needs a view token of its own, separate from the write token in the app's code.
- With `REWINDBUG_GITHUB_REPO` and `REWINDBUG_GITHUB_TOKEN`, every new bug becomes a GitHub issue and a repeat a comment on it.

### rewindbug-mcp

- Receives reports on `127.0.0.1` with a token in the path and stores them in `.rewindbug/reports/`.
- MCP tools `last_bug`, `list_bugs` and `get_bug` hand the bug to Claude Code or Cursor without the rrweb events.
