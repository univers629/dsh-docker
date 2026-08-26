# dsh-docker

Run DeepSeek Harness in Docker: a prebuilt Debian 13 environment where the agent can keep installing toolchains with apt and develop long term, with model API keys stored outside the container.

[![Linux](https://img.shields.io/badge/Linux-supported-FCC624?style=flat-square&logo=linux&logoColor=black)](https://www.kernel.org/)
[![Windows](https://img.shields.io/badge/Windows-supported-0078D4?style=flat-square&logo=windows&logoColor=white)](https://www.microsoft.com/windows)
[![Debian 13](https://img.shields.io/badge/Debian-13-A81D33?style=flat-square&logo=debian&logoColor=white)](https://www.debian.org/releases/trixie/)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

[简体中文](README.md) · [English](README.en.md) · [Security model](docs/security.en.md)

## Features

- **One-line install**: Linux and Windows share the same interactive menu and write the configuration to `.env`.
- **Persistent toolchains**: software the agent installs with apt stays in the container writable layer; start, stop, restart, and DSH updates never recreate the container.
- **Keys stay out of the container**: real API keys live only in a host file and a separate broker container, while DSH is configured with a placeholder key.
- **Unprivileged runtime**: DSH and the agent run as `dsh` (1000:1000) with `cap_drop: ALL` plus seven ordinary capabilities, and apt still works.
- **Optional egress allow list**: outbound traffic can be forced through a domain allow-list forward proxy.
- **Multi-arch prebuilt image**: `ghcr.io/univers629/dsh-docker:latest` covers `linux/amd64` and `linux/arm64`, falling back to a local build when the pull fails.

> Update DSH inside the container (the "DSH environment" settings page, or `./dsh.sh update`). Recreating the container or chasing image updates is unnecessary.

## Installation

1 vCPU / 2 GB of RAM / 10 GB of disk is enough to start; plan on 2 vCPU / 4 GB / 20 GB if the agent will keep installing toolchains inside the container.

Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker/main/install.sh | bash
```

Windows PowerShell (requires Docker Desktop in Linux containers mode):

```powershell
irm https://raw.githubusercontent.com/univers629/dsh-docker/main/install.ps1 | iex
```

The installer asks what to do, where the image comes from, how access is protected, where the reverse proxy runs, which domain and port binding to use, which model-key-broker upstreams and quotas to configure, and which outbound mode to use, then writes `.env`. Model keys can be left empty and added later with menu item 9 or `./install.sh model-key`, which does not recreate the container. The container root password is stored only as a sha512crypt hash in `data/secret/root.hash` and the Basic Auth password only as a bcrypt hash in `data/auth/htpasswd`; neither is written to `.env`. Nothing in this flow uses a privileged container, mounts a Docker socket, or grants host root.

| Menu item | What it does |
| --- | --- |
| 1 Fresh install | Becomes "reconfigure and recreate the container (mounted data kept)" when the project directory already exists |
| 2 Update DSH inside the container | Installs the new version from npm in the running container, reapplies the patch set, and restarts only the DSH process |
| 3 Start / 4 Stop / 5 Restart | Acts on the existing container only, keeping apt-installed toolchains |
| 6 Logs / 7 Status | Forwarded to `./dsh.sh logs` and `status` |
| 8 Delete | Removes the container, images, mounts, networks, build cache, and project directory after a `DELETE` confirmation |
| 9 Add model API keys | Writes the keys and starts the broker container for an existing deployment without recreating `dsh` |

Only item 1 asks for the image source; the others act on the existing container.

Unattended installation:

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker/main/install.sh | bash -s -- install --access local --image-source prebuilt --non-interactive
```

A password on the command line ends up in shell history and in `ps`; prefer an environment variable:

```bash
DSH_ROOT_PASSWORD='at-least-12-characters' bash install.sh install --access local --non-interactive
```

Run `bash install.sh --help` for the full option list; on Windows use `powershell -ExecutionPolicy Bypass -File .\install.ps1`.

## Daily management

```text
Linux:   ./dsh.sh  [start|update|stop|restart|logs [service]|status|shell|root-shell|verify|keys|egress|remove]
Windows: .\dsh.bat [start|update|stop|restart|logs [service]|status|shell|root-shell|verify|keys|egress|remove]
```

- `start` prepares the image only when the container does not exist and reuses it afterwards; `stop`, `restart`, and in-container `apt install` all keep the writable layer.
- `update` only reinstalls the DSH npm package inside the container; it is not a project or image update. `remove` deletes the writable layer while bind mounts remain.
- `shell` enters the unprivileged `dsh` account; `root-shell` is a host-side administration channel that cannot be reached from inside the container.
- `verify` runs 22 hardening checks inside the container; `keys` and `egress` print the status of the key broker and the egress proxy.
- The healthcheck probes both the Nginx entry and DSH's own port, so a DSH crash loop shows the container as `unhealthy`.

To remove the project completely, run menu item 8 from the project directory or `./install.sh delete` (Windows: `powershell -ExecutionPolicy Bypass -File .\install.ps1 -DshAction delete`). Deletion targets this project's container, images, mounts, networks, and directory by exact name; it never uses substring matching and never removes external shared networks.

## Public access and authentication

DSH provides no login authentication of its own, and the installer binds port 3080 to `127.0.0.1` by default. Public access must go through HTTPS and an authenticated entry point; do not use wildcard binds such as `0.0.0.0` or `::`. Three access modes are available:

1. `local`: local browser or SSH tunnel only.
2. `trusted-proxy`: Cloudflare Access, a Docker panel, host Nginx, a VPN, or another outer entry point authenticates requests; trusted hosts and an external Docker network can be recorded.
3. `basic`: the container Nginx authenticates against a bcrypt password file. It has no MFA, and public deployments still need HTTPS at the outer proxy.

Host Nginx example:

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

When a Docker panel proxies the traffic, give the installer the external network the proxy container runs on and use `http://dsh:3080` upstream; a host proxy or SSH tunnel uses `http://127.0.0.1:3080`. The external network must already exist, or the installer can create it after confirmation.

## Architecture

```mermaid
flowchart LR
    client["Browser / authenticated reverse proxy"]

    subgraph hostfs["Host files (the only place credentials live)"]
        keys["data/broker/keys.json 0600<br/>real model API keys"]
        hashes["data/secret/root.hash<br/>data/auth/htpasswd<br/>hashes only"]
        mounts["data/ · workspace/<br/>sessions, home, projects"]
    end

    subgraph dsh["dsh container — cap_drop ALL + 7 capabilities · no-new-privileges"]
        nginx["Nginx entry<br/>optional Basic Auth"]
        agent["DSH and agent sessions<br/>dsh 1000:1000"]
        helper["privileged helper as root<br/>apt allow list · password gate"]
    end

    broker["dsh-key-broker container<br/>read_only · no published port"]
    egress["dsh-egress container<br/>domain allow-list proxy"]
    upstream["model upstream API"]
    internet["internet"]

    client -->|3080| nginx --> agent
    agent -->|placeholder key| broker -->|real key injected| upstream
    agent -->|allowlist mode| egress --> internet
    agent -.->|unix socket| helper
    keys -.->|read-only mount| broker
    hashes -.->|read-only mount| helper
    mounts -.->|bind mount| agent
```

Real keys move only between the host file and the `dsh-key-broker` container. The two containers share nothing but HTTP, so the key literal does not exist inside the `dsh` container.

Persistent directories:

| Container path | Host path | Contents |
| --- | --- | --- |
| `/data/dsh` | `data/dsh` | Sessions, settings, credentials, profile, built-in plugins |
| `/data/home` | `data/home` | Home directory, SSH, npm/uv toolchains and caches |
| `/data/mcp` | `data/mcp` | Custom MCP sources, virtualenvs, data |
| `/data/agents` | `data/agents` | Shared sub-agent state |
| `/workspace` | `workspace` | Agent workspace |
| `/usr`, `/etc`, `/var` | Container writable layer | Debian system and apt-installed software; lost only when the container is deleted |

The Debian system directories stay in the container writable layer with no overlay on top, so apt-installed software and system configuration survive stopping and starting the same container.

## Security model

Layered controls, most to least effective: **trusted input > keys outside the container > egress allow list > escape hardening**.

| Layer | Implementation | Risk covered |
| --- | --- | --- |
| Keys outside | A separate `dsh-key-broker` container injects the key, strips client credentials, and enforces a path allow list, rate limit, and daily quota | Key exfiltration through prompt injection or arbitrary command execution |
| Egress control | In `allowlist` mode the container only joins an internal network and reaches the internet through a domain allow-list proxy with DNS result validation | Data sent to arbitrary destinations, bypassing the key broker |
| Runtime identity | DSH, agent sessions, and Nginx workers run as 1000:1000; only PID 1, the Nginx master, and the privileged helper are root | Processes running directly as root in the container |
| Capability set | `cap_drop: ALL` plus only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETGID`, `SETUID`, `KILL`; `no-new-privileges` kept on; seccomp and AppArmor left enabled | `CAP_SYS_ADMIN` mount escapes, cgroup `release_agent`, kernel module loading, cross-process ptrace |
| Isolation surface | No privileged mode, no Docker socket, no shared host PID/network/IPC namespace, and `pids_limit` set | Docker API escape, host process visibility, fork bombs |
| Escalation gate | apt goes through allow-listed wrappers; any other privileged command requires the container root password, with incremental delay and lockout on failure | Escalation from `dsh` to root inside the container |
| Boot-chain integrity | Entry script, Supervisor, privileged helper, and wrappers are root-write-only; packages the runtime depends on cannot be removed | Breaking the boot chain from inside the container |
| Escape blast radius | Host user namespace remap is supported, with `install.sh --userns-preflight` for detection and ownership alignment | A kernel or runtime escape landing as host root |

Known limits:

- The container shares the host kernel, so kernel and runtime vulnerabilities cannot be blocked by in-container hardening; keep the host kernel and Docker updated.
- Passwordless apt is the default, which means the container root identity is reachable from inside the container. `DSH_PRIVILEGED_APT=password` tightens it.
- The key broker only keeps the key literal out of the container; it protects neither the quota nor the data, so quotas and the egress allow list bound the damage.
- The egress allow list matches domains and performs no TLS interception, so every path under an allowed domain is reachable.
- The first line of defense is still not feeding untrusted content to the agent; every layer above only reduces the impact of a successful injection.

The threat model, per-layer configuration, the broker `keys.json` schema, egress details, and the trade-offs of user namespace remap and rootless Docker are documented in [docs/security.en.md](docs/security.en.md).

## Model API keys

Real keys are written only to `data/broker/keys.json` (0600) on the host and mounted read-only into `dsh-key-broker`, never into the DSH container. In DSH's model settings, set base_url to `http://dsh-key-broker:8080/u/<upstream>/v1` and the api key to any placeholder string.

- At install time: the wizard reads each upstream key without echoing it, or use `--model-keys-file` with a 0600 `keys.json`.
- Afterwards: `./install.sh model-key` (Windows: `.\install.ps1 -DshAction model-key`) adds the broker container without recreating `dsh`.
- Status: `./dsh.sh keys` prints upstreams, quotas, today's usage, and allow/deny counters, never the keys.
- Keys cannot be moved into the WebUI: the WebUI runs inside the DSH container, so a key entered there is stored in the container where the agent can read the file directly. Entering keys in the WebUI still works when the broker is skipped, at the cost of this protection.

## Outbound modes

`DSH_EGRESS_MODE` in `.env` selects how the container reaches the network:

- `open` (default): the container connects directly, which is simpler but lets a compromised agent send data anywhere.
- `allowlist`: the container joins a gateway-less internal network and must use the `dsh-egress` forward proxy, which allows 15 built-in domains covering Debian, npm, PyPI, GitHub, and GHCR. `DSH_EGRESS_ALLOWED_HOSTS` replaces that list wholesale.

## Publishing the image

[.github/workflows/publish-image.yml](.github/workflows/publish-image.yml) builds each architecture on a native amd64 or arm64 runner and merges them into one multi-arch manifest. It triggers three ways: a daily check at 03:17 UTC that builds when the `latest` dist-tag of `@deepseek-ai/dsh` has no image tag yet, a manual dispatch with an explicit version or dist-tag, and a `v*` tag push. Every publish tags `latest`, `dsh-<DSH version>`, and `<date>-<commit>`. When an upstream change invalidates a patch anchor the build fails instead of publishing an unpatched image. New GHCR packages are private by default; switch the package to public once after the first publish, otherwise an anonymous pull returns `denied`.

## License

[MIT License](LICENSE)
