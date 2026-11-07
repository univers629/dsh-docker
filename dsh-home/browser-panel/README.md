# dsh-browser-panel

Sidebar tab that renders a Chromium window running inside the container. One RFB
connection carries the picture and the mouse, wheel, drag and keyboard events, so
input does not travel over a separate command channel.

## Pieces

- `lib/index.js` — host half. Owns the Xvfb → openbox → x11vnc → websockify →
  chromium lifecycle and the `/dsh-browser-panel/*` routes.
- `lib/cdp.js` — minimal Chrome DevTools Protocol client (HTTP discovery plus a
  JSON WebSocket), used for navigation, history, reload, text insertion and
  screenshots. No dependencies: Node 24 ships `fetch` and `WebSocket`.
- `client/client.js` — client half. Registers one tab type on the official
  `sidebarRightTabs` registry and fills the `sidebar.right.pane.tab` and
  `sidebar.right.pane.tab.title` seats. No third-party sidebar plugin needed.
- `bin/install-browser-panel.mjs` (repository root) seeds this directory into
  `/data/dsh/browser-panel-plugin`, copies it into the web profile's
  `node_modules`, enables the bundle and registers it as a `file:` dependency —
  without that last step pnpm prunes the directory on the next plugin install.

## Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/dsh-browser-panel/status` | GET | State, ports, pid, log tail |
| `/dsh-browser-panel/{start,stop,restart}` | POST | Process lifecycle |
| `/dsh-browser-panel/{back,forward,reload}` | POST | History and reload over CDP |
| `/dsh-browser-panel/navigate` | POST | `{url}`, scheme-less input gets `https`, local hosts `http` |
| `/dsh-browser-panel/url` | GET | Current `location.href` |
| `/dsh-browser-panel/insert-text` | POST | `{text}` via `Input.insertText` |
| `/dsh-browser-panel/screenshot` | GET | PNG of the current viewport |
| `/dsh-browser-panel/vnc/` | GET/WS | noVNC page and RFB-over-WebSocket, proxied to `5800` |

Mutating routes require the `x-dsh-browser-panel: 1` header and a loopback
request whose `Host` was rewritten by the container's nginx; anything else is
`403`. A browser that is not running answers `409`.

## Paths

| Piece | Where |
| --- | --- |
| noVNC page + WebSocket | `websockify --web /usr/share/novnc`, `127.0.0.1:5800` → `127.0.0.1:5900`, proxied by nginx at `/dsh-browser-panel/vnc/` |
| RFB | `x11vnc` on `127.0.0.1:5900` |
| CDP | chromium `--remote-debugging-port=9222`, loopback only |
| X display | `Xvfb :99`, `DSH_BROWSER_WIDTH`×`DSH_BROWSER_HEIGHT` |
| Browser profile | `/data/dsh/browser-panel/chromium` (bind-mounted, survives rebuilds) |

## Known limits

- Chinese IME input does not reach X; the toolbar's paste button inserts the
  clipboard through CDP instead, which bypasses the IME entirely.
- The tab scales the desktop to the sidebar width. Widen the sidebar for a
  readable page.
- Chromium runs without its sandbox (`--no-sandbox`): the container already
  drops capabilities and runs as uid 1000.
