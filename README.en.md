# dsh-docker

A local Docker build and persistent runtime for DeepSeek Harness, with a prebuilt Debian 13 environment where the Agent can keep installing software and developing.

[![Linux](https://img.shields.io/badge/Linux-supported-FCC624?style=flat-square&logo=linux&logoColor=black)](https://www.kernel.org/)
[![Windows](https://img.shields.io/badge/Windows-supported-0078D4?style=flat-square&logo=windows&logoColor=white)](https://www.microsoft.com/windows)
[![Debian 13](https://img.shields.io/badge/Debian-13-A81D33?style=flat-square&logo=debian&logoColor=white)](https://www.debian.org/releases/trixie/)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

[简体中文](README.md) · [English](README.en.md)

> Update DSH inside the container (the "DSH environment" settings page, or `./dsh.sh update`). Recreating the container or chasing image updates is unnecessary and discards the toolchains the agent installed with apt.

## Installation and configuration

1 vCPU / 2 GB of RAM and 10 GB of disk are enough to start; plan on 2 vCPU / 4 GB and 20 GB if the agent will keep installing toolchains inside the container. The default source is the multi-arch prebuilt image `ghcr.io/univers629/dsh-docker:latest` (covering `linux/amd64` and `linux/arm64`); when the pull fails the installer falls back to building from the `Dockerfile` in this checkout and records the real source in `.env` as `DSH_IMAGE` and `DSH_IMAGE_SOURCE`. Unattended runs use `--image-source prebuilt|build` and `--image REF`; the Windows equivalents are `-ImageSource` and `-Image`.

The installer asks what to do, where the image comes from, how access is protected, where the reverse proxy runs, which hosts are trusted, where the host port is bound, which model-key-broker upstreams and quotas to configure, and which outbound mode to use. It writes `.env` automatically. Built-in Basic Auth stores only a bcrypt hash in `data/auth/htpasswd`. DSH and the Agent run as the unprivileged container account `dsh` (1000:1000), and apt still works: wrapper scripts hand the request to a root privileged helper that executes only an allow list. The installer also asks for a container root password used for privileged work outside that allow list; it is stored only as a sha512crypt hash in `data/secret/root.hash` and never in `.env`. Unattended runs use `--root-password VALUE` (or the `DSH_ROOT_PASSWORD` environment variable), or `--no-root-password` to deliberately skip it; the Windows equivalents are `-RootPassword` and `-NoRootPassword`. None of this grants host root, a Docker socket, or privileged-container capabilities.

Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker/main/install.sh | bash
```

Windows PowerShell (requires Docker Desktop in Linux containers mode):

```powershell
irm https://raw.githubusercontent.com/univers629/dsh-docker/main/install.ps1 | iex
```

The Linux and Windows installers fetch the project, prepare the Debian 13 image (pulling the prebuilt one by default), and start the same container runtime. The Windows installer starts the Docker Desktop Linux Engine when necessary.

Both one-line commands open the same interactive menu:

| Option | What it does |
| --- | --- |
| 1 Fresh install | Becomes "reconfigure and recreate the container (mounted data kept)" when the project directory exists; asks for the image source, access protection, proxy location, domain, port binding, model key broker, and outbound mode |
| 2 Update DSH inside the container | Installs the new version from npm in the running container, reapplies the patch set, and restarts only the DSH process |
| 3 Start / 4 Stop / 5 Restart | Acts on the existing container only; nothing is recreated and apt-installed toolchains are kept |
| 6 Logs / 7 Status | Forwarded to `./dsh.sh logs` and `status` |
| 8 Delete | Fully removes the container, images, mounts, networks, build cache, and project directory after a `DELETE` confirmation |

Only option 1 asks for the Debian 13 image source (prebuilt or local build); options 2 through 8 act on the existing container.

Unattended installation example:

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker/main/install.sh | bash -s -- install --access local --image-source prebuilt --root-password 'at-least-12-characters' --non-interactive
```

A password on the command line ends up in shell history; prefer the environment variable:

```bash
DSH_ROOT_PASSWORD='at-least-12-characters' bash install.sh install --access local --non-interactive
```

Run `bash install.sh --help` inside the downloaded project directory for Linux options. On Windows, run `powershell -ExecutionPolicy Bypass -File .\install.ps1` directly.

### Publishing the image

[.github/workflows/publish-image.yml](.github/workflows/publish-image.yml) builds each architecture on a native GitHub amd64 or arm64 runner and merges them into one multi-arch manifest. It publishes in three ways:

- **Following upstream automatically**: a daily check at 03:17 UTC reads the `latest` dist-tag of `@deepseek-ai/dsh` on npm and builds only when that version has no image tag yet, so several upstream releases on the same day still produce at most one image.
- **Manual dispatch**: run the workflow from the Actions page with an npm version or dist-tag (`latest` by default). Use it to republish immediately after changing project files or patches.
- **Tag push**: push a `v*` tag.

Every publish tags `latest`, `dsh-<DSH version>`, and `<date>-<commit>`, so the package page shows which DSH is inside the image. When an upstream change invalidates an artifact patch anchor the build fails instead of publishing an unpatched image. Standard runners are not billed for public repositories, and storage plus egress for public GHCR packages are not billed either. New GHCR packages are private by default: after the first publish, switch the package to public once (repository -> Packages -> Package settings -> Change visibility), otherwise an anonymous pull on a server returns `denied`.

## Daily management

After the first install, manage the same container directly:

```text
Linux: ./dsh.sh [start|update|stop|restart|logs [service]|status|shell|root-shell|verify|keys|egress|remove]
Windows: .\dsh.bat [start|update|stop|restart|logs [service]|status|shell|root-shell|verify|keys|egress|remove]
```

`shell` enters the account DSH actually runs as (the unprivileged `dsh` user). `root-shell` is the host-administrator channel: `docker exec` attaches as container root, which is not reachable from inside the container. `verify` runs `verify-dsh-hardening` in the container: 22 checks covering the run UID, capability set, `no-new-privileges`, the privileged-helper socket, root-only write access to the boot chain (`boot-chain-immutable`), UID separation between the Supervisor / Nginx master / privileged helper and `dsh` (`signal-isolation`), whether the apt removal guard is actually in force (`apt-removal-guard`), root-password state, and the `/proc`, `/sys`, and cgroup mounts, exiting non-zero when any check fails.

`start` prepares the Debian 13 image only when the container does not exist, pulling or building it according to the source recorded in `.env`; later starts reuse the same container. `stop`, `restart`, and `apt install` performed by an in-container agent keep the container writable layer. `remove`/`down` deletes that layer, while `/data` and `/workspace` bind mounts remain. The `update` action reinstalls the DSH npm package inside the container and swaps `/app/dsh`; it is not a project or image rebuild. The container healthcheck probes both the Nginx entry and DSH's own port, so a DSH crash loop shows as `unhealthy` in `docker ps` instead of being hidden behind a healthy gateway.

To completely clear this project before a fresh install on a server, run the installer from the project directory and choose `delete` (menu item 8), or run:

```bash
./install.sh delete
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DshAction delete
```

Deletion precisely removes the `dsh` container, the DSH images (`dsh:*` plus the prebuilt reference recorded in `.env`), project mounts and networks, the global Docker build cache, and the project directory after a `DELETE` confirmation. It does not use a substring `name=dsh` filter and does not remove external shared networks such as `dpanel-local`. It works from inside the project directory or from its parent: the installer copies itself to a temporary file first, so the running script and the current directory never block the removal.

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

For a Docker-based panel, select Docker container/panel in the installer, enter the network the proxy container is attached to (`dpanel-local` for dPanel), and use `http://dsh:3080` as the upstream. Host proxies and SSH tunnels use `http://127.0.0.1:3080`.

External networks must already exist because Compose never creates them. If the proxy panel is not deployed yet, enter a new name such as `dsh-proxy` and the installer offers to create it; attach the proxy later with `docker network connect dsh-proxy <proxy-container>`. `dsh-private` is the network DSH manages itself and cannot be used as an external network.

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

## Model key defence chain

The threat model is blunt: the Agent inside the container runs with `danger-full-access` and can execute arbitrary commands, so any model API key stored in that container is readable. Prompt injection does not have to "trick" it into revealing the key; a single `cat` is enough. Running unprivileged, dropping capabilities, and allow-listing apt all defend against escalation and escape, not against reading a file the account is already allowed to read, so none of them help here.

The only effective answer is to move the key out of the container. With `DSH_MODEL_BROKER=on` in `.env`, the installer overlays `docker-compose.keys.yml` and runs one extra container, `dsh-key-broker`:

- The real keys exist only in `data/broker/keys.json` on the host (mode 0600; `data/` is already in `.gitignore`) and in that container's memory. The file is mounted read-only at the broker's `/etc/dsh-broker` and is **never mounted into the DSH container**; the two containers share only HTTP, no volume.
- On the DSH side, the model base_url becomes `http://dsh-key-broker:8080/u/<upstream-name>/v1` and the api key is any placeholder string. The real key does not exist as a string inside the container, so searching the filesystem and the environment finds nothing.

What the broker actually enforces:

- Every credential the client sends (`authorization`, `api-key`, `x-api-key`, `x-goog-api-key`, `cookie`, and friends) is stripped before the real key is injected, so forging or overriding auth headers inside the container is pointless.
- The upstream host is fixed by `baseUrl` in `keys.json`. A client picks only which upstream and which allowed path, never the host. `baseUrl` must be https, must not embed credentials, and must not point at loopback, private, or link-local addresses.
- Path prefix allow list: by default only the common OpenAI/Anthropic/Gemini-compatible endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/models`, and so on). Account management and file-upload style APIs are out of reach. Paths are normalised before the check, so traversal tricks such as `%2e%2e` return 400.
- Only GET and POST are forwarded; anything else is 405.
- A per-minute rate limit plus a UTC daily budget (`requestsPerMinute` / `dailyRequestBudget`) return 429 when exceeded, and more in-flight requests than `DSH_BROKER_MAX_CONCURRENT` return 503.
- On upstream responses with status ≥400, key literals in the body are replaced with `***redacted***`, because some providers echo the received key back in error messages.
- The audit log records metadata only (timestamp, upstream name, path, decision, status, bytes, duration). Request bodies, query strings, and header values are never written.
- Probes: `/healthz` returns 204 and `/status` returns JSON (upstream names, upstream hosts, budgets, and today's usage; no keys).
- The container itself: non-root (UID 1000), `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem, and no published host port.

Configuration: for a human install, run the wizard and type each upstream key at the prompt (nothing is echoed). For automation, point `--model-keys-file` at a 0600 `keys.json`; `--model-key NAME=KEY` exists only as a fallback for pipelines that cannot be interactive, because a key on the command line ends up in `ps`. Upstream addresses come from `--model-base-url NAME=URL` (deepseek, openai, and anthropic have built-in defaults), and `--no-model-broker` disables the broker and clears `data/broker/keys.json`. Real keys only ever land in `data/broker/keys.json`; `.env` holds nothing but the switch and the address. You can also edit that file directly, because the broker reloads its configuration every 5 seconds without a restart. The structure looks like this (the keys in the example are fake):

```json
{
  "version": 1,
  "upstreams": [
    {
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com",
      "key": "sk-0000000000000000000000000000000000000000",
      "requestsPerMinute": 60,
      "dailyRequestBudget": 5000
    },
    {
      "name": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "key": "sk-ant-api03-0000000000000000000000000000000000000000",
      "headerName": "x-api-key",
      "headerTemplate": "{key}",
      "extraHeaders": { "anthropic-version": "2023-06-01" },
      "requestsPerMinute": 30,
      "dailyRequestBudget": 2000
    }
  ]
}
```

`requestsPerMinute` and `dailyRequestBudget` mean **unlimited** when omitted or set to `0`: installing the broker does not bring quota protection by itself, and leaving those fields out means the deployment defends the key literal only. Since "it does not protect your quota" is the most important boundary of this design, set both explicitly — `requestsPerMinute: 60` is a reasonable starting point, and `dailyRequestBudget` should follow your actual usage, set tight first and raised after you hit 429. `maxRequestBytes` defaults to 8 MiB.
In the DSH model settings, use `http://dsh-key-broker:8080/u/deepseek/v1` as the base_url and any placeholder string as the api key (the installer summary suggests `dsh-broker-placeholder`). `headerName` and `headerTemplate` default to `authorization` and `Bearer {key}`; only upstreams that use a different auth header, such as Anthropic, need them.

Operations: `./dsh.sh keys` prints the broker's `/status` (upstreams, budgets, today's usage, allowed and denied counts) and never prints a key.

**State the boundary plainly**: the broker protects the **key literal** from leaving the host. The key is never copied into the container and cannot be reused elsewhere. It does **not protect your quota and does not protect your data**: an injected Agent can still spend your budget through it and can still send container data upstream as a prompt. The broker also performs **no client authentication**, so anything that can reach `dsh-internal` can use it (see the honest limits section). Only two mitigations exist: `requestsPerMinute` / `dailyRequestBudget` cap the damage, and the outbound allow list keeps data from reaching destinations you never approved.

Measured verification (temporary `dsh:verify` stack in a separate compose project): the DSH container sent `GET http://dsh-key-broker:8080/u/deepseek/v1/models` with a placeholder key; the broker stripped the placeholder header, injected the real key, and forwarded to `https://api.deepseek.com`, which answered 401 because the verification key was fake, proving the injection path works. At the same time, a full-text search for the real key literal in the DSH container across `/etc`, `/data`, `/app`, `/usr/local`, `/root`, and `/workspace` returned 0 hits, as did a scan of every process environment, the response body, and the broker audit log.

## Two outbound modes

`DSH_EGRESS_MODE` in `.env` decides how the container reaches the network.

**open (default)**: the container connects to the internet like any other Docker container. Convenient, but an injected Agent can POST data anywhere and can bypass the key broker to talk to a model provider directly.

**allowlist**: the installer overlays `docker-compose.isolated.yml`, and all outbound traffic must pass through the separate `dsh-egress` forward proxy (listening on 3128), which allows traffic by domain allow list. The topology:

```text
host 3080 ──► dsh-ingress ──► dsh-app:3080          Nginx layer-4 forward; the only container publishing a port
                      dsh ──► dsh-egress ──► internet   domain allow list, HTTP on 80/443, CONNECT on 443 only
                      dsh ──► dsh-key-broker ──► model upstream   real key injected here
```

In this mode the dsh container is attached only to `dsh-internal` (`internal: true`, no default gateway), so a direct connection to the internet is not "denied" — there is simply no route.

The upstream must be written as `dsh-app:3080` rather than `dsh:3080`: `dsh-ingress` holds the network alias `dsh` on `dsh-private` so that reverse proxies configured with `http://dsh:3080` (DPanel and similar) need no change, and Docker's embedded DNS also counts the querying container's **own** aliases in the answer. In practice, ingress resolving `dsh` resolves to itself and fails to connect to itself (`connect() to <self>:3080 failed (99)`). `docker-compose.isolated.yml` therefore gives the dsh service a dedicated `dsh-app` alias on `dsh-internal`, which is the only name that unambiguously points at DSH itself.

The built-in allow list contains exactly 15 domains: `deb.debian.org`, `security.debian.org`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `github-releases.githubusercontent.com`, `pkg-containers.githubusercontent.com`, `ghcr.io`, `astral.sh`, and `nodejs.org`.

The proxy rejects every shape that would bypass the domain check: IP literals (including `127.0.0.1`, `169.254.169.254`, 10/8, 172.16/12, 192.168/16, `::1`, `fd00::/8`), `localhost` and the `.internal`, `.local`, `.localdomain`, and `.localhost` suffixes, integer or hexadecimal address forms (`2130706433`, `0x7f000001`), URLs with embedded credentials (`user:pass@host`), non-http(s) schemes, and CONNECT to any port other than 443. Hop-by-hop headers are stripped on forward, and the proxy does not perform TLS interception, so the certificate chain inside the container is unchanged.

Allowing a new domain: set `DSH_EGRESS_ALLOWED_HOSTS` in `.env` on the host (comma-separated, `*.example.com` style leftmost wildcards supported, which do not match bare `example.com`) and restart the stack; the installer can also set both up front with `--egress open|allowlist` and `--egress-allow HOSTS`. Note that this **replaces** the built-in list, so re-list every domain you still need. The allow list cannot be changed from inside the container, and that is deliberate: the Agent must not be able to open its own door.

DNS rebinding protection: the allow list matches domains, and a domain can resolve into a private network. So before the connection is actually made, the resolved addresses are checked and only public unicast addresses are accepted; resolving to loopback, private, link-local (including the cloud metadata address `169.254.169.254`), CGNAT, or IPv4-mapped private ranges returns 403. This layer can be turned off with `DSH_EGRESS_ALLOW_PRIVATE_UPSTREAM=1`, which is only appropriate when the allow list genuinely contains an internal mirror on the same network. **Turning it off means giving up this protection**: one attacker-controlled allow-listed domain is then enough to turn the proxy into a tool for reaching the host and the internal network.

Why the entry point is layer-4: `dsh-ingress` uses the Nginx `stream` module for plain TCP forwarding. It does not parse HTTP, does not rewrite Host, and does not add `X-Forwarded-*`. That is intentional — Basic Auth and the same-origin/credential boundary remain the job of the Nginx inside the dsh container, so their semantics are unchanged. Its `proxy_pass` uses a variable, so every new connection goes through Docker's embedded DNS and follows the dsh container to its new IP after a restart.

Package managers inside the container: in isolated mode `bin/entrypoint.sh` writes `/etc/apt/apt.conf.d/00-dsh-proxy`, `/etc/pip.conf`, the npm globalconfig, and `git config --system http.proxy`, and sets `NODE_USE_ENV_PROXY=1` (Node 24's `--use-env-proxy`; undici/fetch ignore proxy environment variables by default). Those files are required because environment-variable support in these tools is incomplete, and apt in particular runs through the privileged helper with a scrubbed environment. Only files carrying the `dsh-docker managed` marker are written or reclaimed; configuration you wrote yourself is kept and reported. Switching back to open mode deletes them so apt does not keep dialling a proxy that no longer exists.

Operations: `./dsh.sh egress` prints the proxy's `/status` (allow-list size, allowed ports, whether the resolved-address guard is on, active connections, allowed and denied counts).

All three sidecar containers run under the same hardening:

| Container | Run identity | Hardening | Host port | Mounts | Role |
| --- | --- | --- | --- | --- | --- |
| `dsh` | PID 1 is root; DSH, Agent sessions, and Nginx workers are 1000:1000 | `cap_drop: ALL` plus 7 capabilities, `no-new-privileges`, writable system layer | publishes 3080 in open mode; publishes nothing in isolated mode | `/data`, `/workspace`, and the other bind mounts | DSH itself and the Agent |
| `dsh-key-broker` | 1000:1000 | `cap_drop: ALL`, `no-new-privileges`, `read_only` root filesystem plus a 16 MB `/tmp` tmpfs | none | `data/broker` read-only | model key injection, rate limit, and budget |
| `dsh-egress` | 1000:1000 | same as above | none | none | outbound domain allow-list forward proxy |
| `dsh-ingress` | 1000:1000 | same as above | publishes 3080 in isolated mode (still bound to `127.0.0.1` by default) | none | layer-4 forward to `dsh-app:3080`, and holds the `dsh` name on `dsh-private` |

## User namespace remap

The previous layers narrow what can be done inside the container. The most valuable remaining layer separates container root from host root: with user namespace remap enabled on the host, UID 0 in the container is just an unprivileged subuid on the host, so if a kernel or runtime vulnerability really does produce an escape, the identity that lands on the host is that ordinary user rather than root.

Current state on this machine (measured, Docker 29.7.2):

- `docker info` reports SecurityOptions `["name=seccomp,profile=builtin","name=cgroupns"]` with **no `name=userns`** — it is not enabled, and the Docker Desktop / WSL2 backend does not support enabling it.
- `/proc/self/uid_map` inside the container is the identity mapping `0 0 4294967295`, so `bin/entrypoint.sh` reports `DSH_USERNS_REMAP` as `false`. That detection was also checked against a real remap mapping such as `0 165536 65536`, where it correctly reports `true`.

How to enable it (Linux host, edit `/etc/docker/daemon.json`):

```json
{
  "userns-remap": "default"
}
```

Then run `sudo systemctl restart docker`.

Count the cost:

- This is a **daemon-level** switch that affects every container on the host, not only DSH. Existing containers must be recreated and their ownership realigned.
- Bind-mount ownership has to be realigned: UID 1000 in the container maps into the host's `dockremap` subuid range (commonly `165536 + 1000 = 166536`), and without that the container cannot write `/data`. After enabling remap the container can no longer change those owners either, and `bin/entrypoint.sh` prints the `chown` commands to run on the host when it detects that situation.
- `install.sh --userns-preflight` (Linux) runs the preflight: it detects whether remap is active, reads the host subuid range, computes the offset, and aligns bind-mount ownership. It **never edits `/etc/docker/daemon.json` for you** — that is host-level configuration you must decide on and restart Docker for yourself.
- **Docker Desktop / WSL2 do not support it**: on this machine `docker run --userns` only accepts `host`. So this layer is meaningful only on a Linux VPS.

What this stage delivers is **support, a preflight, and documentation**, not "enabled on this machine".

### Alternative: rootless Docker

If you are willing to pay more, Linux offers a path that is stronger than `userns-remap`: rootless Docker, where the whole daemon runs as an ordinary user. Not only are container processes mapped, the daemon itself is not root either, so an attacker starts one level lower.

The cost is also higher, which is why this is an alternative and not a recommended default:

- Ports below 1024 cannot be bound directly; you either lower `net.ipv4.ip_unprivileged_port_start` or put a host-side forward in front. DSH uses 3080, so this matters little for DSH itself, but it affects an 80/443 reverse proxy on the same host.
- Networking goes through userspace implementations such as RootlessKit and slirp4netns, with trade-offs in throughput and source-IP preservation; some storage and network drivers are unavailable or need a newer kernel.
- cgroup resource limits require cgroup v2 with systemd delegation to work fully; otherwise constraints such as `pids_limit` may not take effect.

## Honest limits

- **Shared kernel**: the container shares the host kernel, so kernel and runtime vulnerabilities of the Dirty Pipe or runC class cannot be stopped by anything inside the container. The only answer is keeping the host kernel and Docker updated; userns-remap reduces the impact of an escape but does not remove it.
- **Passwordless apt**: `DSH_PRIVILEGED_APT=nopasswd` is the default, which means the container can become container root through the allow-listed helper. That is the trade-off between "the Agent can install software" and "no escalation inside the container"; tighten it with `DSH_PRIVILEGED_APT=password` and accept a human typing the password for every install.
- **The removal guard is an allow list of package names**: it covers only the packages the boot chain actually depends on (the Nginx set, `openssl`, `ca-certificates`, `passwd`, `adduser`, `mawk`, `util-linux`). Removing a package outside that list can still break a feature — a language runtime, a debugging tool, something you installed yourself — it just cannot stop the container from starting. Cascading bypasses are caught by the pre-execution `apt -s` simulation, and a simulation still differs in principle from the execution that follows it.
- **The broker protects neither quota nor data**: it only guarantees that the key literal never enters the container. An injected Agent can still spend your budget and send data upstream; rate limits and budgets only lower the ceiling.
- **The broker performs no client authentication**: anything that can reach the `dsh-internal` network — in practice the dsh container itself — can use it. This is deliberate: any broker credential placed in the DSH container would be readable with one `cat`, so adding one would buy nothing. Its guarantee is therefore strictly "the real key literal never enters the DSH container", with `requestsPerMinute` / `dailyRequestBudget` covering quota and the outbound allow list covering data exfiltration.
- **The outbound allow list decides by domain only**: resolved-address validation is in place, but the proxy does not intercept TLS, so any path inside an allowed domain is reachable. Once `github.com` is allowed, the endpoints that upload content to it are allowed too.
- **The real first line of defence is still "do not feed untrusted content to the Agent"**. Every layer above only limits how much damage an injection that already happened can do.

Priority order, from most to least effective: **trusted input > keys outside the container > outbound allow list > escape hardening**. The first two decide whether an incident happens and how expensive it is, the third decides where data can flow, and the last one only matters after the first three have failed.

## Project-specific behavior

<details>
<summary>Built-in controls, permissions, and stability notes</summary>

### Built-in control plugin

The image includes `dsh-docker-control` and restores it when the web profile is empty on first boot. It adds a DSH environment page to the settings left nav, beside General, Models, Plugins, and Agent presets. The page shows the installed and latest DSH versions and provides Check for updates, Update now, and a Desktop UI / Phone UI layout selector. Opening settings never reaches the network; only the check button queries the npm registry for the latest version. The phone layout makes the settings panel full screen, turns its left nav into a horizontally scrollable top tab strip, and turns the home sidebar into a drawer: closed it gives the whole width to the conversation and a floating button in the top-left corner opens it, open it floats over the conversation instead of squeezing it. The first visit picks a layout from the browser user agent. The update installs the target version from npm inside the container, reapplies the current patch set to the published artifacts, and atomically swaps the app; failures leave the old version running. No SSH session is required. Updates and Restart DSH replace only the DSH child managed by the Supervisor; neither action restarts the Debian container or Nginx. The settings header also provides a WebUI editor for `/data/dsh/settings.yaml`. The editor validates YAML and protects against concurrent overwrites.

In-container Agents should install, update, and remove plugins through `manage-dsh-plugin`. It creates a same-volume temporary profile under `/data/dsh/profiles`, permits the build scripts required by pnpm packages, validates configuration plus runtime resolution and import, then atomically replaces the live profile. Normal completion immediately removes the temporary profile and pnpm Git-build directories created by that transaction; the next DSH start or plugin operation recovers and cleans transactions or backups left by power loss or forced termination. The content-addressable pnpm store under `/data/home` is an intentional persistent download cache and can be reclaimed explicitly with `pnpm store prune`.

### WebUI and reverse-proxy stability

The editor uses an isolated portal and a fixed-height scroll region to prevent settings-page flicker, textarea height jumps, and blank pages. A WebSocket keepalive patch reduces UI stalls caused by idle proxy disconnects.

For public domains, the container Nginx presents traffic to DSH as internal loopback only after built-in Basic Auth or a trusted outer authentication layer has accepted it. `DSH_TRUSTED_HOSTS` validates browser authority; it is not login authentication and does not enable remote plugin settings writes. Those permissions remain explicit settings owned by each plugin.

### Permission boundary

DSH, Agent sessions, and the Nginx workers run as the unprivileged `dsh` account (1000:1000); only PID 1, the Nginx master, and the privileged helper stay root. The entrypoint still protects credential and SSH private-key permissions and aligns `/data` and `/workspace` ownership with the run account.

The container uses `cap_drop: ALL` and adds back only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETGID`, `SETUID`, and `KILL`, which is what dropping privileges and running dpkg need. Nothing in that set can load kernel modules, ptrace other processes, mount filesystems, or reach raw devices. `no-new-privileges:true` stays on, so the image deliberately ships no setuid sudo.

The only escalation path inside the container is the privileged helper on `/run/dsh-priv/helper.sock` (0660 root:dsh):

- `apt`, `apt-get`, `apt-mark`, and `update-dsh` are wrappers. They are passwordless by default but accept only fixed subcommands and package-shaped arguments; `apt-cache` is a read-only query command that works directly as `dsh`, so the image deliberately leaves it unwrapped and it never takes the privileged helper's serial lock (an explicit `dsh-root apt-cache` call is still bound by the same allow list); `-o`/`-c`/`-t`, local paths, `.deb` files, wildcards, and `apt-get source` are rejected with exit code 126. `sudo` is the same wrapper, so `sudo -i` does not produce a root shell.
- Removal guard: `remove`/`purge`/`autoremove`/`autopurge` may not uninstall the packages this container's boot chain depends on. This does not defend against escalation; it defends against tearing down the house you live in. `apt-get purge -y nginx` deletes the reverse proxy from the container writable layer, the running nginx process stays alive on the deleted inode, the container keeps reporting healthy, and you only find out at the next restart that it never comes back. The damage lives in the writable layer, so `docker restart` cannot repair it — only `docker compose up -d --force-recreate` can. The guard has two layers:
  - **Explicit refusal by name**: the protected packages are `nginx`, `nginx-common`, `nginx-core`, `nginx-light`, `nginx-full`, `nginx-extras`, `libnginx-mod-stream`, `ca-certificates`, `openssl`, `passwd`, `adduser`, `mawk`, and `util-linux`. A `:arch` qualifier or an `=version` pin does not get around it.
  - **An `apt -s` simulation before execution**: the `Remv`/`Purg` lines of the simulated plan are parsed to catch the bypass of naming an unprotected package and letting apt take the runtime out as a cascade — for example `apt-get purge -y iproute2` (whose plan contains `Purg nginx`), or `apt-mark auto nginx` followed by `apt-get autoremove -y --purge`. A hit rejects the whole request atomically with exit code 126; nothing is partially executed.
  - Removal only: installing, reinstalling, and querying those packages is unaffected, and packages you installed yourself can still be removed freely.
- `apt-mark` now goes through the same wrapper. The image previously symlinked only `apt-get`, so `apt-mark` ran the real binary as UID 1000 and failed with `mkstemp (13: Permission denied)` and rc=100 while writing `/var/lib/apt/extended_states`. With the symlink in place, `apt-mark hold`/`unhold`/`auto`/`manual` work through the helper.
- Any other privileged command goes through `dsh-root run <command>` and requires the container root password.
- Brute-force resistance: 5 failures inside a 900-second window trigger a lockout starting at 300 seconds and doubling up to 3600 seconds, and each failure adds delay to the next attempt (1 second base, +500 ms per failure, capped at 8 seconds). While locked, even the correct password is refused; apt keeps working.
- The password hash lives in `/root/dsh-secret` (0700 root:root, mounted read-only) and `/etc/shadow`. The `dsh` account can read neither, so the hash cannot be cracked offline from inside the container.

Against the publicly documented container escapes: no privileged mode, no Docker socket, no shared host PID/network/IPC/user namespace, no unconfined seccomp or AppArmor, no `SYS_ADMIN`/`SYS_MODULE`/`SYS_PTRACE`/`DAC_READ_SEARCH`, and a `pids_limit` is set. Container root still grants no administrator access on the host.

One boundary stated plainly: passwordless apt means an Agent inside the container can still install software and change the container writable layer. The real trust boundary is the container itself, not the `dsh` account. That boundary has narrowed, though: the nine boot-chain paths (entrypoint, Supervisor, privileged helper, the wrappers, and so on) are root-only writable and the runtime dependencies cannot be uninstalled, so what remains in the writable layer is "install things and change configuration it was already allowed to change", no longer "tear the container down". Do not read that as absolute safety: `upgrade`/`dist-upgrade` can still pull in breaking changes, removing a package you installed yourself still loses it, and `autoremove` still drops dependencies that genuinely became orphans. `--no-root-password` disables `dsh-root run`, leaving no in-container path to an arbitrary root command at all. Everything this layer still cannot stop is collected in the honest limits section above.

### Plugins and toolchains

The sandbox permits the `/data` writes required for plugins, session management, and MCP deployments. Apt packages use standard Debian paths persisted in the container writable layer. Python and Node user toolchains live under `/data/home/.local` and `/data/home/.npm-global`. At startup, the container renders the deployed `container-environment` skill from the detected system, architecture, and permission variables.

</details>

## License

[MIT License](LICENSE)
