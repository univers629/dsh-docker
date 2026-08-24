# dsh-docker

A local Docker build and persistent runtime for DeepSeek Harness.

[![Linux](https://img.shields.io/badge/Linux-supported-FCC624?style=flat-square&logo=linux&logoColor=black)](https://www.kernel.org/)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

[简体中文](README.md) · [English](README.en.md)

## Installation and configuration

The installer asks what to do, which in-container user to run, how access is protected, where the reverse proxy runs, which hosts are trusted, and where the host port is bound. It writes `.env` automatically. Built-in Basic Auth stores only a bcrypt hash in `data/auth/htpasswd`.

Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker/main/install.sh | bash
```

This project currently maintains the Linux Docker deployment only. The container defaults to in-container `root`, with `node` available as an explicit choice. Container root does not grant host root, a Docker socket, or privileged-container capabilities.

Unattended installation example:

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker/main/install.sh | bash -s -- install --user --access local --non-interactive
```

Run `bash install.sh --help` inside the downloaded project directory for all options.

## Daily management

After the first install, manage the same container directly:

```text
Linux: ./dsh.sh [start|update|stop|restart|logs|status|shell|remove]
```

`start` builds the Debian 13 image only when the container does not exist; later starts reuse the same container. `stop`, `restart`, and `apt install` performed by an in-container agent keep the container writable layer. `remove`/`down` deletes that layer, while `/data` and `/workspace` bind mounts remain. The `update` action is an in-container DSH source update, not a project or image rebuild.

## Public access and authentication

DSH does not provide native login authentication. The installer binds port 3080 to `127.0.0.1` by default. Public access must use HTTPS and an authenticated entry point; do not use `0.0.0.0`, `::`, or another wildcard bind.

The installer provides three access modes:

1. `local`: local browser or SSH tunnel only.
2. `trusted-proxy`: Cloudflare Access, dPanel, host Nginx, a private VPN, or another outer entry point authenticates requests. The installer can record trusted hosts and an external Docker network.
3. `basic`: the container Nginx authenticates against a bcrypt password file. It does not provide MFA, and public deployments still require HTTPS at the outer proxy.

Cloudflare Access/OIDC with MFA is stronger than Basic Auth alone. The proxy performance difference between Caddy, Nginx, and the container Nginx is negligible for this workload.

Host Nginx example (replace the certificate paths and add authentication required by the selected mode):

```nginx
server {
    listen 443 ssl;
    server_name dsh.example.com;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
```

For a Docker-based panel, select Docker container/panel in the installer, enter the panel network name (usually `dpanel-local`), and use `http://dsh:3080` as the upstream. Host proxies and SSH tunnels use `http://127.0.0.1:3080`.

## Architecture and persistence

```mermaid
flowchart LR
    Client["Browser / SSH tunnel / authenticated proxy"] -->|private 3080| Proxy["Container Nginx"]
    Proxy -->|loopback 3081| DSH["DSH web service"]
    DSH --> Sessions["/data/dsh<br/>sessions, settings, credentials, profiles"]
    DSH --> Home["/data/home<br/>user toolchains and SSH"]
    DSH --> MCP["/data/mcp<br/>MCP services and data"]
    DSH --> Agents["/data/agents<br/>shared subagent state"]
    DSH --> Workspace["/workspace<br/>project workspace"]
    Sessions -.-> H1["./data/dsh"]
    Home -.-> H2["./data/home"]
    MCP -.-> H3["./data/mcp"]
    Agents -.-> H4["./data/agents"]
    Workspace -.-> H5["./workspace"]
```

Persistent paths:

These directories are bind-mounted. The Debian system itself, including `/usr`, `/etc`, and `/var`, stays in the container writable layer; no overlay mounts shadow system directories. Packages and configuration installed with `apt` therefore survive stop, start, and restart of the same container.

| Container path | Host path | Contents |
| --- | --- | --- |
| `/data/dsh` | `data/dsh` | Sessions, settings, credentials, profiles, and the built-in plugin |
| `/data/home` | `data/home` | User home, SSH, npm/uv toolchains, and caches |
| `/data/mcp` | `data/mcp` | Custom MCP source, environments, and data |
| `/data/agents` | `data/agents` | Shared subagent state |
| `/workspace` | `workspace` | Agent workspace |
| `/usr`, `/etc`, `/var` | Container writable layer (not separately mounted) | Debian system, agent-installed apt packages, configuration, and apt cache; `/bin`, `/sbin`, and `/lib` follow `/usr` under Debian usr-merge |

Removing the container with `docker rm` or `docker compose down` removes the system writable layer; the next `start` creates a fresh Debian 13 system. `/data`, `/workspace`, and the image are not automatically deleted.

## Project-specific behavior

<details>
<summary>Built-in controls, permissions, and stability notes</summary>

### Built-in control plugin

The image includes `dsh-docker-control` and restores it when the web profile is empty on first boot. The settings page shows the DSH version and provides an Update DSH button. The update runs inside the container, reapplies the current patch set, builds into a temporary directory, and atomically swaps the app; failures leave the old version running. No SSH session is required. The page also provides Restart DSH and a WebUI editor for `/data/dsh/settings.yaml`. The editor validates YAML and protects against concurrent overwrites.

### WebUI and reverse-proxy stability

The editor uses an isolated portal and a fixed-height scroll region to prevent settings-page flicker, textarea height jumps, and blank pages. A WebSocket keepalive patch reduces UI stalls caused by idle proxy disconnects.

For public domains, the container Nginx presents traffic to DSH as internal loopback only after built-in Basic Auth or a trusted outer authentication layer has accepted it. `DSH_TRUSTED_HOSTS` validates browser authority; it is not login authentication and does not enable remote plugin settings writes. Those permissions remain explicit settings owned by each plugin.

### Permission boundary

The Linux installer defaults to container `root`; pass `--user` to select `node`. The entrypoint corrects mounted-directory ownership and protects credential and SSH private-key permissions. Container root does not enable privileged mode, mount the Docker socket, or grant administrator access on the host.

### Plugins and toolchains

The sandbox permits the `/data` writes required for plugins, session management, and MCP deployments. Apt packages use standard Debian paths persisted in the container writable layer. Python and Node user toolchains live under `/data/home/.local` and `/data/home/.npm-global`. At startup, the container renders the deployed `container-environment` skill from the `DSH_SYSTEM_*`, `DSH_RUN_AS_ROOT`, and permission variables.

</details>

## License

[MIT License](LICENSE)
