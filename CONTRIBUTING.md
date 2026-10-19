# Contributing

Bug reports, questions and pull requests are welcome. For a vulnerability see [SECURITY.md](SECURITY.md) instead of an issue.

## Setup

Node 22 (see `.nvmrc`) and pnpm (the version is in `package.json`, `corepack enable` picks it up).

```bash
git clone https://github.com/bybraveHQ/rewindbug.git
cd rewindbug
pnpm install
pnpm exec playwright install --with-deps chromium firefox webkit
```

## Layout

| Path                | What                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| `src/capture`       | errors, console, network                                                               |
| `src/replay`        | the rrweb recording, its buffer and masking                                            |
| `src/report`        | building, compressing, sending and rendering a report                                  |
| `src/steps`         | reproduction steps and the generated Playwright test                                   |
| `src/shared`        | the URL filter and DOM helpers the modules share                                       |
| `src/download`      | `rewindbug/download`: reports kept in the page, saved on request                       |
| `src/playwright`    | `rewindbug/playwright`: the test fixture                                               |
| `packages/mcp`      | `rewindbug-mcp`: a local receiver and MCP server                                       |
| `examples/endpoint` | a one-file endpoint on Node with a viewer                                              |
| `demo/`             | the demo page; a service worker plays the endpoint, deployed to GitHub Pages from main |
| `bench/`            | the overhead bench                                                                     |

The modules in `src` import each other only through types.

## Checks

```bash
pnpm lint
pnpm format:check   # pnpm format fixes it
pnpm typecheck
pnpm test           # vitest: jsdom unit tests, *.browser.test.ts in Chromium
pnpm test:endpoint  # node --test for examples/endpoint
pnpm test:e2e       # Playwright on the demo in Chromium, Firefox and WebKit
pnpm build          # tsup, then size-limit against the budgets
```

CI runs all of them on every push and pull request. While working, `pnpm test:watch` reruns unit tests and `pnpm demo` serves the demo on http://127.0.0.1:4789/.

## Pull requests

- One change per pull request, with a test when it adds or fixes behaviour.
- Keep the bundle inside its budgets in `.size-limit.json`. Raising a budget is a separate decision, so say so in the pull request instead of changing the file.
- No new runtime dependency without an issue first: the browser package has one, `@rrweb/record`.
- No new option without a use case. The public API is `init`, `capture`, `flush` and the two extra entries; the README says what every option is for.
- Add a line to `CHANGELOG.md`: the top section is the next release, started by the first change after a release.
- Commit messages follow `type(scope): what changed`, as in `git log`.
