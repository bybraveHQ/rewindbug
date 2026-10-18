import type { Report } from "../types.ts";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

// the report carries recorded page markup: no "<" may close the data script
export const embedJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c");

export type Player = { script: string; style: string };

// one report as a page of its own, a test attachment or a download: the
// report, the rrweb player and its styles are all inline, so the file opens
// offline and fetches nothing; every report field goes in through textContent
export const reportPage = (
  report: Report,
  title: string,
  player: Player,
): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light dark; --line: #8884; --muted: #888; --error: #d33; }
      body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; padding: 24px 16px; max-width: 1100px; }
      h1 { font-size: 20px; margin: 0 0 12px; word-break: break-word; }
      h2 { font-size: 16px; margin: 24px 0 8px; }
      .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
      select, button { font: inherit; padding: 4px 8px; }
      .stage { border: 1px solid var(--line); overflow: hidden; }
      .stage > div { transform-origin: 0 0; }
      pre { border: 1px solid var(--line); padding: 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0; }
      .muted { color: var(--muted); }
      .error { color: var(--error); white-space: pre-wrap; word-break: break-word; }
      [hidden] { display: none !important; }
    </style>
    <style>${player.style}</style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <p id="headline" class="error"></p>
    <div class="row">
      <label>Speed
        <select id="speed">
          <option value="0.5">0.5×</option>
          <option value="1" selected>1×</option>
          <option value="2">2×</option>
        </select></label>
      <button id="again" type="button">From start</button>
    </div>
    <div id="stage" class="stage"></div>
    <p id="no-replay" class="muted" hidden></p>
    <h2>Steps</h2>
    <pre id="steps"></pre>
    <h2>Playwright test</h2>
    <pre id="test"></pre>
    <h2>Error</h2>
    <pre id="stack"></pre>
    <h2>Console</h2>
    <pre id="console"></pre>
    <h2>Network</h2>
    <pre id="network"></pre>
    <h2>Context</h2>
    <pre id="context"></pre>
    <script id="report" type="application/json">${embedJson(report)}</script>
    <!-- @rrweb/replay, MIT, https://github.com/rrweb-io/rrweb -->
    <script>${player.script}</script>
    <script>
      const report = JSON.parse(document.getElementById("report").textContent);
      const byId = (id) => document.getElementById(id);
      const text = (id, value) => (byId(id).textContent = value);
      const lines = (items) => (items.length ? items.join("\\n") : "none");
      const pathOf = (url) => {
        try {
          const u = new URL(url);
          return u.pathname + u.search;
        } catch {
          return url;
        }
      };
      const c = report.context ?? {};
      const limits = report.limits ?? {};
      const sdk = report.sdk ?? {};
      text("headline", report.trigger.kind + ": " + report.trigger.message);
      text("steps", report.stepsMarkdown || "none");
      text("test", report.test);
      text("stack", report.trigger.error?.stack ?? report.trigger.message);
      text("console", lines(report.console.map((e) => e.level + ": " + e.message)));
      text(
        "network",
        lines(
          report.network.map((e) =>
            [
              e.method + " " + pathOf(e.url) + " " + (e.status ?? e.error ?? "pending") +
                (e.durationMs === undefined ? "" : " (" + e.durationMs + " ms)"),
              e.requestBody === undefined ? "" : "  sent: " + e.requestBody,
              e.responseBody === undefined ? "" : "  received: " + e.responseBody,
            ]
              .filter(Boolean)
              .join("\\n"),
          ),
        ),
      );
      text(
        "context",
        lines([
          "url: " + c.url,
          "title: " + c.title,
          "when: " + new Date(report.createdAt).toISOString(),
          ...(c.viewport ? ["viewport: " + c.viewport.width + "×" + c.viewport.height + " @" + c.viewport.dpr] : []),
          "browser: " + c.userAgent,
          ...Object.entries(c.tags ?? {}).map(([k, v]) => "tag " + k + ": " + v),
          ...(limits.truncated?.length ? ["truncated: " + limits.truncated.join(", ")] : []),
          "sdk: rewindbug " + sdk.version + ", rrweb " + sdk.rrwebVersion,
        ]),
      );
      const events = report.replay?.events ?? [];
      if (!events.length) {
        byId("stage").hidden = true;
        byId("no-replay").hidden = false;
        text("no-replay", "No recording: " + (limits.replayState ?? "off"));
      } else {
        const { Replayer } = window.rrwebReplay;
        const stage = byId("stage");
        let player;
        const play = () => {
          player?.destroy();
          const box = document.createElement("div");
          stage.replaceChildren(box);
          player = new Replayer(events, {
            root: box,
            mouseTail: false,
            showWarning: false,
            speed: Number(byId("speed").value),
          });
          player.on("resize", ({ width, height }) => {
            const scale = Math.min(1, stage.clientWidth / width);
            box.style.transform = "scale(" + scale + ")";
            stage.style.height = Math.ceil(height * scale) + "px";
          });
          player.play();
        };
        byId("speed").onchange = () => player?.setConfig({ speed: Number(byId("speed").value) });
        byId("again").onclick = () => player?.play(0);
        play();
      }
    </script>
  </body>
</html>
`;
