# DSH Docker

A local build and Docker runtime for DeepSeek Harness. The image is built from upstream source instead of using a prebuilt DSH image.

## Install

Linux / macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker-dev/main/install.sh | bash
```

Run DSH as UID 0 inside the Linux container:

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker-dev/main/install.sh | bash -s -- --root
```

Restore the default `node` mode:

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker-dev/main/install.sh | bash -s -- --user
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/univers629/dsh-docker-dev/main/install.ps1 | iex
```

The installer updates an existing Git checkout, writes the selected mode, and force-recreates `dsh`. It stops when tracked local source changes are present.

## Persistent paths

| Container path | Host path on Linux | Purpose |
| --- | --- | --- |
| `/data/dsh` | `data/dsh` | Sessions, settings, plugins, credentials |
| `/data/home` | `data/home` | User home, Python/Node tools, caches |
| `/data/mcp` | `data/mcp` | MCP services and data |
| `/data/agents` | `data/agents` | Shared subagent state |
| `/workspace` | `workspace` | Project workspace |

Linux also enables `docker-compose.system.yml`. Debian packages keep their normal container paths while `/usr/bin`, `/usr/lib`, `/usr/share`, `/usr/sbin`, `/etc`, `/var/lib`, and `/var/cache` are stored under matching directories in `data/system/`. `/usr/local` stays in the image so DSH runtime files update with the image. Windows keeps the system layer in the image.

Back up `data/`, `data/system/`, and `workspace/` for a Linux installation.

## Daily management

Linux / macOS:

```bash
./dsh.sh start
./dsh.sh update
./dsh.sh restart
./dsh.sh logs
./dsh.sh status
./dsh.sh stop
```

Windows:

```powershell
.\dsh.bat start
.\dsh.bat update
.\dsh.bat logs
```

The Web UI listens on `127.0.0.1:3080` by default. Put public traffic behind an authenticated reverse proxy; do not set `DSH_BIND_HOST` to `0.0.0.0`. For dpanel, join DSH to the same Docker network and proxy to `http://dsh:3080`.

## Plugins and tools

The image includes `dsh-docker-control`; its settings page can schedule a DSH restart. Plugin data is stored under `/data/dsh/profiles`. Install Python user tools with `uv tool install` or `pip install --user`, and Node user tools with `npm install -g`; these locations are under `/data/home`.

Use `uvx` or `npx` for standard MCP servers. Put custom MCP projects under `data/mcp/<name>/`.

## Development and tests

```bash
node tests/run-mode-smoke.mjs
node tests/docker-control-client-smoke.mjs
node tests/profile-plugin-patches-smoke.mjs
```

License: MIT.
