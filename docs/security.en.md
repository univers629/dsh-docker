# Security model

This document expands the "Security model" section of the [README](../README.en.md): the threat model, how each layer is implemented, and where each layer stops.

## Threat model

The agent inside the container runs with `danger-full-access` and can execute arbitrary commands. The design therefore assumes that **every file and environment variable inside the container is readable by the agent**. In-container hardening aims to limit escalation and escape, not to stop the agent from reading what it already has permission to read.

That yields the priority order **trusted input > keys outside the container > egress allow list > escape hardening**. The first two decide whether an incident happens and how expensive it is, the third decides where data can flow, and the last only matters after the first three have failed.

## Runtime identity and capabilities

- DSH, agent sessions, and Nginx workers run as the unprivileged account `dsh` (1000:1000). Only PID 1, the Nginx master, and the privileged helper stay root.
- The container uses `cap_drop: ALL` and adds back only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETGID`, `SETUID`, and `KILL`. Dropping privileges at startup and running dpkg need these; none of them can load kernel modules, ptrace other processes, mount filesystems, or reach raw devices.
- `no-new-privileges: true` stays on, and the image does not install a real setuid sudo.
- No privileged mode, no Docker socket, no shared host PID/network/IPC/user namespace, seccomp and AppArmor left enabled, no `SYS_ADMIN`/`SYS_MODULE`/`SYS_PTRACE`/`DAC_READ_SEARCH`, and `pids_limit` set.
- The entry script protects credential and SSH key permissions and aligns ownership of `/data` and `/workspace` with the runtime account.

Mapped to published escape techniques: `unshare`-based mount escapes and cgroup `release_agent` writes both require `CAP_SYS_ADMIN`, which is not granted; Docker socket escapes require a socket that is not mounted. Kernel and container-runtime vulnerabilities (Dirty Pipe, the runC CVE series) cannot be removed by in-container hardening — they are mitigated by updating the host kernel and Docker, and by user namespace remap, which reduces the blast radius of a successful escape.

## Escalation gate

The only escalation path inside the container is the privileged helper on `/run/dsh-priv/helper.sock` (0660 root:dsh).

- `apt`, `apt-get`, `apt-mark`, and `update-dsh` are wrapper scripts. They are passwordless by default and accept only fixed subcommands and package-name-shaped arguments; `-o`/`-c`/`-t`, local paths, `.deb` files, glob patterns, and `apt-get source` are rejected with exit code 126. `sudo` points at the same wrapper, so `sudo -i` cannot produce a shell.
- `apt-cache` is a read-only command that the `dsh` account runs directly, so it does not take the helper's serialization lock.
- Any other privileged command goes through `dsh-root run <command>` and requires the container root password. `--no-root-password` disables that channel, leaving no path to arbitrary root commands inside the container.
- Brute-force protection: five failures inside the same 900-second window trigger a lockout starting at 300 seconds and doubling up to 3600 seconds. Each failure also delays the next attempt (starting at 1 second, +500 ms per failure, capped at 8 seconds). During a lockout even the correct password is rejected; apt is unaffected.
- The password hash lives in `/root/dsh-secret` (0700 root:root, mounted read-only) and `/etc/shadow`, neither readable by the `dsh` account, so the hash cannot be extracted for offline cracking.

## Boot-chain integrity and removal guard

The nine boot-chain paths (entry script, Supervisor, privileged helper, wrapper scripts, and so on) are root-write-only. The removal guard does not exist to prevent escalation but to prevent the container from dismantling its own runtime: `apt-get purge -y nginx` deletes the reverse proxy from the writable layer while the running process survives on the deleted inode and the healthcheck still passes, so the damage only surfaces at the next restart. Because it happens in the writable layer, `docker restart` cannot recover it; the container has to be recreated.

Two layers of protection:

- **Named packages are refused**: `nginx`, `nginx-common`, `nginx-core`, `nginx-light`, `nginx-full`, `nginx-extras`, `libnginx-mod-stream`, `ca-certificates`, `openssl`, `passwd`, `adduser`, `mawk`, `util-linux`. Forms with an `:arch` qualifier or an `=version` pin are caught as well.
- **A dry run first**: the guard parses `Remv`/`Purg` lines from `apt -s` output to catch the bypass of naming an unprotected package and letting apt cascade into the runtime, for example `apt-get purge -y iproute2`, or `apt-mark auto nginx` followed by `apt-get autoremove -y --purge`. A match rejects the whole request atomically with exit code 126.

Only removal is restricted: installing, reinstalling, and querying these packages is unaffected, and other packages can be removed freely. The list covers only boot-chain dependencies, so removing packages outside it can still break functionality — it just cannot stop the container from starting. `upgrade`/`dist-upgrade` can still introduce breaking changes, and `autoremove` still drops genuinely orphaned dependencies.

## Self-check

`./dsh.sh verify` runs `verify-dsh-hardening` inside the container: 24 checks covering the run UID, capability set, `no-new-privileges`, the privileged-helper socket, root-only write access to the boot chain (`boot-chain-immutable`), UID separation between the Supervisor / Nginx master / privileged helper and `dsh` (`signal-isolation`), whether the apt removal guard is in force (`apt-removal-guard`), root-password state, and the `/proc`, `/sys`, and cgroup mounts. Any failing check exits non-zero.

## Model key broker

When `DSH_MODEL_BROKER=on` in `.env`, the installer overlays `docker-compose.keys.yml` and runs the separate `dsh-key-broker` container.

- Real keys exist only in `data/broker/keys.json` on the host (0600; `data/` is in `.gitignore`) and in that container's memory. The file is mounted read-only at `/etc/dsh-broker` in the broker and is never mounted into the DSH container; the two containers share nothing but HTTP.
- DSH is configured with base_url `http://dsh-key-broker:8080/u/<upstream>` and any placeholder api key, so the real key literal does not exist inside the container. The version segment (`/v1`, `/v1beta`) belongs to the upstream address in `keys.json`; client SDKs only append relative paths, so writing it on both sides produces `/v1/v1/responses`. The installer writes this configuration for you — see "Model settings written into DSH" below.
- The broker strips every credential the client sends (`authorization`, `api-key`, `x-api-key`, `x-goog-api-key`, `cookie`, and so on) before injecting the real key, so forging or overriding auth headers inside the container has no effect.
- The upstream host is fixed by `baseUrl` in `keys.json`; the client can only choose an upstream name and an allowed path. `baseUrl` must be https, must not embed credentials, and must not point at loopback, private, or link-local addresses.
- Path prefix allow list: only common OpenAI / Anthropic / Gemini compatible endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/models`, and similar) are allowed; account management and file upload endpoints are not. Paths are normalized before the decision, and traversal forms such as `%2e%2e` return 400.
- Only GET and POST are allowed; other methods return 405.
- A per-minute rate limit plus a UTC daily quota (`requestsPerMinute` / `dailyRequestBudget`) returns 429 when exceeded, and in-flight requests above `DSH_BROKER_MAX_CONCURRENT` return 503.
- When an upstream returns status ≥400, the key literal in the response body is replaced with `***redacted***`, because some upstreams echo the received key in error messages.
- The audit log records metadata only (timestamp, upstream name, path, decision, status code, byte counts, duration) and never request bodies, query strings, or header values.
- Probes: `/healthz` returns 204 and `/status` returns JSON (upstream names, upstream hosts, quotas, today's usage; no keys).
- The container itself is non-root (UID 1000) with `cap_drop: ALL`, `no-new-privileges`, a read-only root filesystem, and no published host port.

### Configuration

Interactive installs read each upstream key without echo and also ask for the API shape and any fixed request headers. Automation uses `--model-keys-file` pointing at a 0600 `keys.json`; `--model-key NAME=KEY` exists only for pipelines that cannot be interactive, and a key on the command line reaches `ps`. Upstream addresses use `--model-base-url NAME=URL` (deepseek/openai/anthropic have built-in defaults), and `--no-model-broker` disables the broker and clears `data/broker/keys.json`. The file can also be edited directly: the broker reloads its configuration every 5 seconds, with no container restart.

`--model-api NAME=PROFILE` (PowerShell: `-ModelApi`) picks the auth header and the allowed endpoints; without it the profile is inferred from the upstream name:

| PROFILE | Auth header | Allowed endpoints | Protocol written into DSH |
| --- | --- | --- | --- |
| `any` (default) | `authorization: Bearer {key}` | the broker's default prefix set (chat/completions, responses, embeddings, models, ...) | `openai-completions` |
| `responses` | `authorization: Bearer {key}` | `/v1/responses` and `/v1/models` only (plus the variants without `/v1`) | `openai-responses` |
| `chat` | `authorization: Bearer {key}` | `/v1/chat/completions` and `/v1/models` only (plus the variants without `/v1`) | `openai-completions` |
| `messages` | `x-api-key: {key}` | `/v1/messages` and `/v1/models` only (plus the variants without `/v1`), with `anthropic-version` attached | `anthropic-messages` |
| `gemini` | `x-goog-api-key: {key}` | `/models` and `/v1beta/models` only | built-in catalog routes only |

The last column is the protocol the installer declares in the DSH configuration. Custom DSH routes support only the first three; the Gemini protocol exists only on built-in catalog routes, so an upstream that should serve Gemini models must be named `google`.

`--model-header NAME=HEADER=VALUE` (PowerShell: `-ModelHeader`, repeatable) writes `extraHeaders` for upstreams that require fixed headers, such as the Codex `originator` / `version` pair and a custom `User-Agent`:

```
--model-key justwoker=sk-...
--model-base-url justwoker=https://api.justwoker.icu
--model-api justwoker=responses
--model-header justwoker=originator=codex_cli_rs
--model-header justwoker=version=0.101.0
--model-header justwoker=user-agent=codex_cli_rs/0.101.0
```

The broker applies these headers when forwarding, overriding any client header of the same name, so container-side configuration cannot change them. Auth headers (`authorization`, `api-key`, `x-api-key`, `x-goog-api-key`, `cookie`, ...) and hop-by-hop headers are rejected by `--model-header`, since setting them would bypass key injection.

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

Omitting `requestsPerMinute` and `dailyRequestBudget` or setting them to `0` means unlimited, in which case the broker only prevents key exfiltration and provides no quota protection. Setting them explicitly is recommended (`requestsPerMinute: 60` is a reasonable start; size the daily budget from real usage and raise it after hitting 429). Neither the install wizard nor the admin panel asks for them (DSH's own Models page has no such control either), so set them with `--model-keys-file` or by editing `data/broker/keys.json` on the host directly (the broker hot-reloads it every 5 seconds by mtime); saving from the panel never clears values already present. `maxRequestBytes` defaults to 8 MiB. `headerName` and `headerTemplate` default to `authorization` and `Bearer {key}`; only upstreams using a different auth header need them. `allowedPathPrefixes` defaults to the broker's built-in prefix set; setting it restricts forwarding to exactly those prefixes. On the client side, `base_url` is `http://dsh-key-broker:8080/u/<upstream>` with no version segment, and the api key field takes the placeholder `dsh-broker-placeholder`.

### Model settings written into DSH

Once the real keys live in the broker, all DSH needs is a base_url pointing at the broker and a placeholder key — neither is a secret. The installer writes both in DSH's own format, so nothing has to be retyped in the WebUI:

| File | Contents |
| --- | --- |
| `data/dsh/settings.yaml` | `baseURL` / `apiKeyEnv` under `llm-pi-ai.providers.<upstream>`, plus `api` and `models` when needed; `llm-deepseek.baseURL` for an upstream named `deepseek`; and `agent-default-model` when it is not set yet |
| `data/dsh/.credentials.yaml` | `refs.<UPSTREAM>_API_KEY` = the placeholder `dsh-broker-placeholder` (0600) |

- The credential reference name matches the one the WebUI derives itself (upstream name uppercased, non-alphanumerics to underscores, `_API_KEY` suffix), so editing the key in the UI later edits the same reference.
- `deepseek` configures DSH's first-party namespace `llm-deepseek` (route id `deepseek-official`) instead of adding a same-named `llm-pi-ai` route: the Models page renders one row per route, so both would show up as two DeepSeek rows while the default model points at only one of them. The first-party route already reads `DEEPSEEK_API_KEY` and ships its own model list. A duplicate route left behind by an older installer is removed on the next write, and only when its `baseURL` points at this deployment's broker.
- DSH hot-reloads both files, so a page refresh is enough; no container restart.
- The upstream name must match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` and stay within 32 characters, mirroring the `ROUTE_PATTERN` behind DSH's "Add custom provider". DSH drops a non-conforming route silently, which surfaces only as a missing card on the Models page, so both the installer and the panel reject it at input time.
- When the upstream name matches DSH's built-in model catalog (`deepseek`, `openai`, `anthropic`, `google`, `nvidia`, `openrouter`, `groq`, `xai`, `moonshotai`, and others), the catalog supplies the protocol and the full model list, so the installer writes only `baseURL` and `apiKeyEnv` and the WebUI immediately offers a full model dropdown.
- A self-hosted gateway that is not in the catalog must carry model ids, or DSH rejects the whole `llm-pi-ai` namespace and every provider disappears. The installer therefore queries the upstream's `/models` with the key it just received (`bin/discover-upstream-models.mjs`, through the SSRF-guarded resolver, capped at 200 ids) and fills the list automatically; when that fails it prints the reason and the ids can be supplied with `--model-id NAME=ID[,ID]` (PowerShell: `-ModelId`) or in the admin panel. The installer still validates the section with DSH's own checker before writing and writes nothing when it fails.
- `baseURL`, `apiKeyEnv`, and the credential reference value are rewritten every time to match the current deployment. `api`, `models`, and `agent-default-model` are only filled in when missing, never overwritten.
- A `baseUrl` in `keys.json` that lacks its version segment is repaired automatically. It can only be noticed while the model list is queried: the query tries both `<base>/models` and `<base>/v1/models`, and success on the second one means the segment is missing from base_url. pi-ai's OpenAI-compatible client sends `/responses`, `/chat/completions`, and `/models` without adding any version segment, so every request lands on the upstream root path and DSH reports 403 or "API key is invalid" while the panel looks perfectly healthy. Anthropic and Gemini are the opposite — their clients send `/v1/messages` and `/v1beta/models` themselves — so those shapes keep base_url without a version segment.
- The reasoning-effort menu requires each model to declare its levels: pi-ai reports "no efforts offered" for every hand-declared model, which is all the installer and the panel write, so the dropdown never appears. The panel's reasoning-efforts field writes `reasoningEfforts` (`off` maps to `null`, the other levels to their own names) onto every model of that upstream, including routes whose `models` list was written earlier — those are patched entry by entry, and any model that already carries `reasoningEfforts` (including a user's own `false`) is left alone. Nothing is declared by default: declaring levels for a model that does not accept `reasoning_effort` makes the upstream reject the request.
- The credential reference is pinned to the placeholder rather than "filled in when missing": the real key for this upstream lives in the broker, which replaces the auth header on every forward, so a real key inside the container does nothing except show up in plain text on the WebUI provider card where the agent can read it. When the reference holds something other than the placeholder, it is reset and called out in the output; treat that key as having been exposed inside the container and rotate it upstream.
- The reset is not limited to upstreams still present in `keys.json`: any reference belonging to a route whose `baseURL` equals this deployment's broker address is reset, which covers references orphaned by deleting an upstream from the panel (the route and the reference stay behind and nothing writes them again). A provider the user added directly does not point at the broker and is left alone.
- Besides running on save, `dsh-key-admin` sweeps periodically (30 seconds by default, `DSH_KEY_ADMIN_SCRUB_INTERVAL_MS=0` disables it, unchanged `.credentials.yaml` mtime skips the round). The reason is the browser: the DSH model page renders the key field as `type=password`, so a password manager autofills a saved password for that origin and any save on that page writes it into `.credentials.yaml` in plain text. The panel's own password fields use `autocomplete="new-password"` because `off` is ignored for password fields in Chrome.
- `--no-model-settings-seed` (PowerShell: `-NoModelSettingsSeed`) skips this step and leaves providers and models to be added in the WebUI.

The merge runs in the image's node (that is where the yaml library, the built-in model catalog, and DSH's validator live) and receives its input on stdin, so neither the keys nor the upstream list appear in `ps`.

### Adding keys later

`./install.sh key-panel` (Windows: `.\install.ps1 -DshAction key-panel`) enables the key admin panel for an existing deployment; `--no-key-admin` disables it and removes the panel container while leaving `keys.json` and `admin.token` untouched. Like `model-key`, it only adds a sidecar container and never recreates `dsh`.

`./install.sh model-key` (Windows: `.\install.ps1 -DshAction model-key`) writes `data/broker/keys.json` for an existing deployment, flips the `.env` switch to `on`, starts `dsh-key-broker`, and verifies `/healthz`. `docker-compose.keys.yml` only adds the broker service and does not touch the `dsh` service definition, so the container is not recreated and apt-installed toolchains survive. The only leftover is the `DSH_MODEL_BROKER` value shown in the in-container skill document, which is fixed when the container is created and refreshes on the next recreate; it is descriptive text and does not affect the broker.

### Key admin panel

When `.env` sets `DSH_KEY_ADMIN=on`, the installer also overlays `docker-compose.keys-admin.yml` and runs the separate `dsh-key-admin` container: a small panel that does nothing but model key configuration (add or remove upstreams, enter keys, pick the API shape, list model ids, set fixed request headers, fetch an upstream's model list once). Saving writes both `data/broker/keys.json` and DSH's `settings.yaml` and `.credentials.yaml`.

It closes the "keys can only be entered from the install wizard" gap without becoming a new attack surface. The panel holds every real key, so if any of these three boundaries is missing it is worse than typing keys into the WebUI:

1. **Network**: the panel joins only the `dsh-admin` network, which the `dsh` container is not on, so Docker itself drops traffic across the two bridges. Before reporting success the installer runs `net.connect(8090, 'dsh-key-admin')` from inside the `dsh` container; that connection must fail or the install fails. The in-container self-check does the same thing as `key-admin-unreachable`, regardless of whether the panel is enabled: with the panel off the probe usually fails at DNS resolution, which also counts as a pass.
2. **Published address**: the host port defaults to `127.0.0.1:3082`. Published on `0.0.0.0`, the `dsh` container can reach the port back through the host gateway and boundary 1 is bypassed, so a non-loopback bind produces a warning and remote access should go through an SSH tunnel.
3. **Authentication**: every `/api` route requires a bearer token; only `/healthz` and the static assets do not. The token is a 192-bit random value stored in `data/broker/admin.token` (0600) and never written into `.env`. Comparison runs over fixed-length digests, and repeated failures hit the same incremental delay and lockout used for the container root password.

The container is locked down like the broker: non-root (1000:1000), `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem, `pids_limit`, and only `data/broker` and `data/dsh` writable. Two details are worth stating separately:

- The service code is mounted read-only from the project's `./bin` rather than baked into the image, so an existing deployment can enable the panel without rebuilding.
- Before writing DSH configuration the panel `lstat`s the targets and refuses when `settings.yaml` or `.credentials.yaml` is a symlink or a directory. The `dsh` container can write `data/dsh`, so without this check it could replace those paths with symlinks and trick the panel into writing `keys.json` content somewhere the agent can read. A refusal counts only as "writing DSH configuration failed" and does not affect saving the keys themselves.
- An empty `upstreams` array is a valid state, because the panel has to work from scratch: install without any key and the broker answers every `/u/` request with 503 until the first key is entered.

### Limits

The broker guarantees that **the key literal never enters the DSH container**: the key cannot be copied out or reused elsewhere. It does not protect the quota or the data — a compromised agent can still spend the quota and send container contents to the upstream as a prompt. It also does not authenticate clients: anything that can reach the `dsh-internal` network can send requests through it, because any broker credential placed inside the DSH container would be readable too. The available mitigations are quotas to bound the loss and the egress allow list to bound where data can go.

## Outbound modes

`DSH_EGRESS_MODE` in `.env` selects how the container reaches the network.

**open (default)**: the container connects directly like any Docker container. Simple, but a compromised agent can POST data anywhere and can reach model vendors directly, bypassing the broker.

**allowlist**: the installer overlays `docker-compose.isolated.yml` and all outbound traffic must pass the separate `dsh-egress` forward proxy (listening on 3128), which allows traffic by domain. Topology:

```text
host 3080 ──► dsh-ingress ──► dsh-app:3080      Nginx L4 forwarding, the only container publishing a port
                    dsh ──► dsh-egress ──► internet   domain allow list, HTTP 80/443, CONNECT 443 only
                    dsh ──► dsh-key-broker ──► model upstream
```

In this mode the dsh container joins only `dsh-internal` (`internal: true`, no default gateway), so direct internet access is not denied — there is no route.

- The built-in allow list has 15 domains: `deb.debian.org`, `security.debian.org`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `github-releases.githubusercontent.com`, `pkg-containers.githubusercontent.com`, `ghcr.io`, `astral.sh`, `nodejs.org`.
- Forms that bypass domain matching are refused by default: IP literals (including `127.0.0.1`, `169.254.169.254`, 10/8, 172.16/12, 192.168/16, `::1`, `fd00::/8`), `localhost` and the `.internal`/`.local`/`.localdomain`/`.localhost` suffixes, integer or hexadecimal address forms (`2130706433`, `0x7f000001`), URLs with credentials, non-http(s) schemes, and CONNECT to any port other than 443. Hop-by-hop headers are stripped on forward, and the proxy does not intercept TLS, so the in-container certificate chain is unchanged.
- DNS rebinding protection: resolution results are validated before connecting and only public unicast addresses are allowed. Loopback, private, link-local (including the cloud metadata address `169.254.169.254`), CGNAT, and IPv4-mapped private addresses return 403. `DSH_EGRESS_ALLOW_PRIVATE_UPSTREAM=1` disables the check; it should only be disabled when the allow list genuinely contains an on-network mirror, because with it off one controlled allow-listed domain turns the proxy into a path to the host and the local network.
- Allowing more domains: set `DSH_EGRESS_ALLOWED_HOSTS` in the host `.env` (comma separated, supporting leftmost single-label wildcards such as `*.example.com`, which does not match the bare domain) and restart the stack, or use `--egress open|allowlist` and `--egress-allow HOSTS` at install time. Values are appended to the built-in list so the built-in package sources keep working; `DSH_EGRESS_ALLOWED_HOSTS_MODE=replace` swaps the list out instead, in which case every still-needed domain must be listed. The list cannot be modified from inside the container.
- Scope: anything outside the list returns 403 for apt, pip, npm, git, and for any web page or search API the agent tries to fetch, so required domains must be listed explicitly. Model requests do not go through `dsh-egress`; `dsh-key-broker` reaches upstreams directly and is unaffected.
- The ingress does L4 forwarding: `dsh-ingress` uses the Nginx `stream` module, so it does not parse HTTP, rewrite Host, or add `X-Forwarded-*`; Basic Auth, same-origin, and credential boundaries stay with the Nginx inside the dsh container. Its `proxy_pass` uses a variable form so every new connection resolves through Docker's embedded DNS and follows the dsh container across restarts.
- The upstream is `dsh-app:3080` rather than `dsh:3080` because `dsh-ingress` holds the network alias `dsh` on `dsh-private` (so reverse proxies configured with `http://dsh:3080` need no change), and Docker's embedded DNS includes the querying container's own aliases in the answer, which makes the ingress resolve `dsh` to itself and fail to connect. `docker-compose.isolated.yml` therefore gives the dsh service a dedicated `dsh-app` alias on `dsh-internal`.
- Package managers inside the container: in isolated mode `bin/entrypoint.sh` writes `/etc/apt/apt.conf.d/00-dsh-proxy`, `/etc/pip.conf`, the npm globalconfig, and `git config --system http.proxy`, and sets `NODE_USE_ENV_PROXY=1` (Node 24's `--use-env-proxy`; undici/fetch ignores proxy environment variables by default). These files are required because these tools support proxy environment variables incompletely and apt additionally runs with a scrubbed environment inside the privileged helper. Only files carrying the `dsh-docker managed` marker are rewritten or removed, user-authored configuration is preserved with a notice, and the managed files are deleted when switching back to open mode.
- Operations: `./dsh.sh egress` prints the proxy `/status` (allow-list size, allowed ports, whether resolution validation is on, active connections, allow and deny counters).

The sidecar containers share the same hardening:

| Container | Identity | Hardening | Host port | Mounts | Role |
| --- | --- | --- | --- | --- | --- |
| `dsh` | PID 1 root; DSH, agent sessions, and Nginx workers 1000:1000 | `cap_drop: ALL` + 7 capabilities, `no-new-privileges`, writable system layer | 3080 in open mode, none in isolated mode | `/data`, `/workspace` bind mounts | DSH and the agent |
| `dsh-key-broker` | 1000:1000 | `cap_drop: ALL`, `no-new-privileges`, `read_only` rootfs + 16 MB `/tmp` tmpfs | none | `data/broker` read-only | Key injection, rate limit, quota |
| `dsh-egress` | 1000:1000 | same | none | none | Domain allow-list forward proxy |
| `dsh-ingress` | 1000:1000 | same | 3080 in isolated mode (bound to `127.0.0.1` by default) | none | L4 forwarding to `dsh-app:3080` |

## User namespace remap

The layers above constrain what can be done inside the container. Remap addresses a different problem: separating container root from host root. With user namespace remap enabled on the host, UID 0 in the container is an ordinary subuid on the host, so a kernel or runtime escape lands as that ordinary user rather than root.

To enable it on a Linux host, edit `/etc/docker/daemon.json` and restart Docker with `sudo systemctl restart docker`:

```json
{
  "userns-remap": "default"
}
```

Trade-offs:

- This is a **daemon-level** switch affecting every container on the host. Existing containers must be recreated and their ownership realigned.
- Bind mount ownership must be realigned: UID 1000 in the container maps into the host `dockremap` subuid range (commonly `165536 + 1000 = 166536`), and without alignment the container cannot write `/data`. Once enabled the container also cannot change ownership of those directories, and `bin/entrypoint.sh` prints the `chown` to run on the host when it detects that state.
- `install.sh --userns-preflight` (Linux) detects whether remap is enabled, reads the host subuid range, computes the offset, and aligns bind mount ownership. It never edits `/etc/docker/daemon.json`, which is host-level configuration that an administrator must change and restart Docker for.
- **Not supported by the Docker Desktop / WSL2 backend**, where `docker run --userns` accepts only `host`, so this layer applies to Linux hosts only.
- Current state is visible from `/proc/self/uid_map` inside the container: the identity map `0 0 4294967295` means remap is off, which is how `bin/entrypoint.sh` resolves `DSH_USERNS_REMAP` to `false`.

### Alternative: rootless Docker

On Linux, rootless Docker is stronger than `userns-remap` because the daemon itself runs as an ordinary user, lowering the starting point of any compromise. It costs more, so it is an alternative rather than the default:

- Ports below 1024 cannot be bound directly; either adjust `net.ipv4.ip_unprivileged_port_start` or add host-side forwarding. DSH uses 3080, but an 80/443 reverse proxy on the same host is affected.
- Networking goes through userspace implementations such as RootlessKit / slirp4netns, with trade-offs in throughput and source IP preservation; some storage and network drivers are unavailable or need a newer kernel.
- cgroup resource limits require cgroup v2 with systemd delegation to work fully, otherwise constraints such as `pids_limit` may not apply.

## Known limits

- **Shared kernel**: the container and the host share one kernel, so kernel and runtime vulnerabilities such as Dirty Pipe or the runC CVEs cannot be blocked by in-container hardening. Updating the host kernel and Docker is the only fix; user namespace remap reduces the blast radius without preventing the escape.
- **Passwordless apt**: `DSH_PRIVILEGED_APT=nopasswd` is the default, so the container root identity is reachable through the allow-listed helper. This is the trade-off between letting the agent install software and making the container non-escalatable; `DSH_PRIVILEGED_APT=password` tightens it at the cost of a password prompt per install.
- **The removal guard is a package-name allow list**: it covers boot-chain dependencies only, and removing other packages can still break functionality. Cascade bypasses are caught by the `apt -s` dry run, which leaves a theoretical gap between simulation and execution.
- **The broker protects neither quota nor data**: it only keeps the key literal out of the container. A compromised agent can still spend the quota and send data upstream; rate limits and quotas bound the loss.
- **The broker does not authenticate clients**: anything that can reach `dsh-internal` can send requests through it.
- **The egress allow list matches domains only**: DNS result validation is included, but the proxy does not intercept TLS, so any path under an allowed domain is reachable — allowing `github.com` also allows the endpoints that upload content to it.
- **The real first line of defense is not feeding untrusted content to the agent**: every layer above only reduces the impact of an injection that already happened.

## Other implementation notes

- **Built-in control plugin**: the image ships `dsh-docker-control`, restored automatically on first start with an empty profile, which adds a "DSH environment" page to the settings navigation.
- **WebUI and proxy stability**: the configuration editor uses a dedicated portal and a fixed-height scroll area to avoid flicker and input height jumps, and a built-in WebSocket keepalive patch reduces UI hangs caused by idle reverse-proxy disconnects.
- **Authentication forwarding**: when accessed through a public domain, the container Nginx converts a request to DSH's internal loopback access only after built-in Basic Auth or a trusted outer authentication has passed. `DSH_TRUSTED_HOSTS` only validates the browser authority; it is not login authentication and does not enable remote settings write access for plugins.
- **Plugins and toolchains**: the `/data` write access needed for plugin installation, session management, and MCP deployment is inside the sandbox. apt-installed software goes to standard Debian paths and persists in the container writable layer, while the Python and Node toolchains live in `/data/home/.local` and `/data/home/.npm-global`. The `container-environment` skill is rendered at container start from the actual system, architecture, and permission variables.
