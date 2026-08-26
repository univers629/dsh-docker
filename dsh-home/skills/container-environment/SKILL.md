---
name: container-environment
description: "Use when managing DSH plugins, MCP servers, development toolchains, system packages, container paths, persistence, permissions, architecture, or DSH restarts and updates."
---

# DSH Container Environment

You run as the unprivileged dsh account (UID/GID 1000) inside a long-lived
Debian 13 Docker container. Treat the container as an Agent development
environment, but keep user data in the bind mounts described below. Apt still
works: a root privileged helper runs a narrow allow list on your behalf, so you
do not need an interactive root shell for ordinary package installs.

## Runtime facts

| Property | Value |
| --- | --- |
| OS | @@DSH_SYSTEM_OS@@ @@DSH_SYSTEM_RELEASE@@ |
| Kernel architecture | @@DSH_SYSTEM_ARCH@@ |
| Debian package architecture | @@DSH_SYSTEM_PACKAGE_ARCH@@ |
| GNU ABI | @@DSH_SYSTEM_ABI@@ |
| C library | @@DSH_SYSTEM_LIBC@@ |
| Container identity | @@DSH_CONTAINER_USER@@ (@@DSH_CONTAINER_UID@@:@@DSH_CONTAINER_GID@@) |
| Node.js | v24 LTS with npm and pnpm 11 |
| Python | Python 3.13 with pip, venv, uv, and uvx |
| Native build tools | make, GCC, and G++ |
| Reverse proxy | Nginx on container port 3080, forwarding to DSH on loopback port 3081 |

Important environment variables:

    HOME=/data/home
    DSH_HOME=/data/dsh
    DSH_AGENTS_HOME=/data/agents
    DSH_WEB_PORT=3081
    DSH_WRITABLE_PATHS=@@DSH_WRITABLE_PATHS@@
    DSH_SYSTEM_PACKAGES_PERSISTENT=@@DSH_SYSTEM_PACKAGES_PERSISTENT@@
    DSH_CAN_INSTALL_SYSTEM_PACKAGES=@@DSH_CAN_INSTALL_SYSTEM_PACKAGES@@
    DSH_PRIVILEGED_APT=@@DSH_PRIVILEGED_APT@@
    NODE_PATH=/app/dsh/node_modules:/data/dsh/profiles/node_modules
    PATH=/data/home/.local/bin:/data/home/bin:/data/home/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

## Storage and persistence

Use these bind-mounted paths for anything that must survive intentional
container replacement:

    /workspace       Project source and working trees
    /data/dsh        DSH sessions, settings, credentials, profiles, and skills
    /data/home       HOME, SSH files, user-level tools, and caches
    /data/mcp        MCP source, virtual environments, databases, and state
    /data/agents     Shared Agent state

Those paths are owned by dsh(@@DSH_CONTAINER_UID@@:@@DSH_CONTAINER_GID@@), so
you can write them directly without any privilege escalation.

The Debian system directories, including /usr, /etc, and /var, live in the
container writable layer. Apt packages and system configuration survive
docker stop, docker start, and restart of the same container. They do not
survive docker rm, docker compose down, or another operation that recreates
the container. /tmp is ordinary temporary container storage, not a persistent
mount.

/app/dsh holds the managed DSH installation: the npm-installed
@deepseek-ai/dsh package under lib/node_modules plus a node_modules symlink for
resolution. Do not store projects or credentials there because the built-in
updater replaces the whole directory.

## Installing tools

- System packages: apt-get update && apt-get install -y <packages>. Both
  apt-get and sudo apt-get install -y <packages> work from the dsh account.
  They are wrappers that forward the request to the root privileged helper,
  which executes it only when it matches the allow list. Password requirement
  for apt is DSH_PRIVILEGED_APT=@@DSH_PRIVILEGED_APT@@.
- apt, apt-get, apt-mark, and update-dsh are the wrapped commands. apt-cache is
  a read-only query tool that runs directly as dsh, so it needs no helper and
  never waits on the helper serial lock. Allowed subcommands are update,
  install, reinstall, remove, purge, autoremove,
  autopurge, upgrade, dist-upgrade, full-upgrade, clean, autoclean, build-dep,
  show, showpkg, search, list, policy, depends, rdepends, madison, hold,
  unhold, showhold, auto, manual, showauto, and showmanual, with ordinary
  package names from the configured repositories. Everything else is denied,
  including -o, -c, and -t overrides, file paths, local .deb files, wildcards,
  apt-get source, and any other way to turn apt into an arbitrary root command.
  A rejected request exits 126 and prints the reason; do not retry it in a loop.
- Uninstalling is narrower than installing: remove, purge, autoremove, and
  autopurge refuse packages this container's runtime depends on, including the
  case where apt would take one of them out as a cascading dependency of the
  package you named. Installing, reinstalling, and querying those packages is
  not restricted, and packages you installed yourself can be removed normally.
  A refused removal exits 126 and prints the plan it rejected; do not retry it
  in a loop and do not probe other package names to get the same effect. Report
  the removal you need to the user instead.
- Reclaim downloaded apt archives when needed: apt-get clean.
- Anything else that genuinely needs root goes through dsh-root run <command>,
  which asks for the container root password. Report operations that need
  container root to the user instead of trying passwords yourself.
- Python CLIs: uv tool install <package>; binaries persist under
  /data/home/.local/bin.
- Python projects and MCP servers: create a virtual environment inside the
  project, for example uv venv /data/mcp/<name>/.venv.
- Node CLIs: npm install -g <package>; the configured npm prefix is
  /data/home/.npm-global.
- Standalone tools: place executables in /data/home/.local/bin or
  /data/home/bin.
- Large language toolchains, including JDK, Android SDK, Gradle, .NET, Rust, and
  Go: prefer the vendor user-space installer or tarball under /data/home over
  apt. Apt packages live in the container writable layer and are gone after a
  recreate, while /data/home survives, and rustup, dotnet-install.sh,
  sdkmanager, and plain tarballs all install there with no privilege at all.
  Installers that default to /opt or /usr/local fail; redirect them to
  /data/home with their prefix or install-dir option.

Do not manually place user projects, secrets, or downloaded binaries under
Debian-managed /usr, /etc, or /var. Apt itself may write there normally.

## MCP layout

Keep each custom MCP server self-contained:

    mkdir -p /data/mcp/my-server
    cd /data/mcp/my-server
    uv venv
    uv pip install mcp httpx

For one-shot servers, uvx and npx use caches below /data/home:

    uvx mcp-server-fetch
    npx -y @modelcontextprotocol/server-filesystem /workspace

## DSH lifecycle

The WebUI settings panel has a **DSH environment** page in its left nav. It
shows the installed and latest DSH versions, and provides **Check for updates**
and **Update now**. It never checks online until the button is pressed.
**Restart DSH** stays in the settings header. The updater installs the target
@deepseek-ai/dsh release from npm into a /tmp staging directory, reapplies the
/etc/dsh-patches artifact patch set, validates Nginx, atomically replaces
/app/dsh, and asks the in-container Supervisor to replace only the DSH child
process. Nothing is cloned or compiled. The Debian container and Nginx process
stay running. A failed patch anchor, install, or validation restores the
previous application.

update-dsh is also a wrapper around the privileged helper, because replacing
/app/dsh needs root. Run it as update-dsh; do not try to edit /app/dsh by hand.

Do not rebuild or recreate the container for an ordinary DSH update. Those
operations discard apt-installed tools and other changes in the writable
system layer.

## Model keys and outbound network

    DSH_MODEL_BROKER=@@DSH_MODEL_BROKER@@
    DSH_MODEL_BROKER_BASE=@@DSH_MODEL_BROKER_BASE@@
    DSH_EGRESS_MODE=@@DSH_EGRESS_MODE@@
    DSH_EGRESS_PROXY_URL=@@DSH_EGRESS_PROXY_URL@@

When DSH_MODEL_BROKER is on, the real model API keys are not in this container
at all. They exist only on the host and inside the separate dsh-key-broker
container, and the provider entries are already configured with base_url
<DSH_MODEL_BROKER_BASE>/u/<upstream-name> and a placeholder api key such as
dsh-broker-placeholder: the broker removes whatever credential the client sends
and injects the real one. The version segment belongs to the broker's own
upstream address, so do not append /v1 to that base_url.
Finding no key is the design, not a misconfiguration. Do not
search files, environment variables, or settings for one, and do not ask the
user to paste a key into the container. The broker also enforces a per-minute
rate limit and a UTC daily request budget per upstream and forwards only GET
and POST on allow-listed API paths, so an occasional 429 is normal feedback:
slow down instead of retrying in a loop.

When DSH_EGRESS_MODE is allowlist, this container has no default gateway and
cannot reach the internet directly. Every outbound HTTP(S) request must go
through the forward proxy at DSH_EGRESS_PROXY_URL, which allows only a fixed
list of domains (Debian, npm, PyPI, GitHub/ghcr, astral.sh, and nodejs.org by
default) on ports 80 and 443, and CONNECT only on 443. apt, pip, npm, and git
are already pointed at it, HTTP_PROXY/HTTPS_PROXY/NO_PROXY are set, and
NODE_USE_ENV_PROXY=1 makes Node fetch honour them, so use those tools normally.
A domain outside the allow list gets 403 from the proxy. That is policy, not a
network fault: another mirror, a raw IP address, or a retry loop will not get
around it. Report the blocked domain and ask the user to add it to
DSH_EGRESS_ALLOWED_HOSTS on the host and restart the stack. You cannot change
the allow list from inside the container.

## Security boundary

- DSH, Agent sessions, and the Nginx workers run as dsh
  (@@DSH_CONTAINER_UID@@:@@DSH_CONTAINER_GID@@). Only PID 1, the Nginx master,
  and the privileged helper stay root.
- The container drops nearly every Linux capability and keeps only the few that
  dropping privileges at startup and installing dpkg packages require. Mounting
  filesystems, loading kernel modules, tracing other processes, and raw device
  access are unavailable.
- no-new-privileges is on, so there is no setuid path to root. sudo here is a
  wrapper for the privileged helper, not real sudo; sudo -i and sudo <arbitrary
  command> do not give you a root shell.
- Escalation is only possible through a policy-constrained internal helper. apt
  and update-dsh are inside its allow list; everything else requires the
  container root password and is subject to failure lockout.
- You cannot escalate to root, and you should not try. Report anything that
  genuinely needs container root to the user and let them decide.

## Plugin management

Use the built-in helper for DSH plugins:

    manage-dsh-plugin install <package-name>@latest
    manage-dsh-plugin update <package-name>@latest
    manage-dsh-plugin remove <package-name>
    manage-dsh-plugin restart

The helper copies the live profile into a same-volume transaction directory,
runs package installation and required lifecycle/build scripts there, validates
every configured runtime entry, then atomically replaces the live profile. It
temporarily enables pnpm's Git dependency builds only inside that transaction;
the live pnpm-workspace.yaml never retains dangerouslyAllowAllBuilds. Install
only trusted packages because their build scripts execute as dsh inside this
container and can reach the allow-listed privileged helper.

Normal success, failure, and termination remove the transaction immediately.
After SIGKILL or power loss, the next plugin operation or DSH start removes the
stale transaction, its recorded pnpm Git-build temporary directories, and
restores the last complete profile if a swap was interrupted. The content-
addressable pnpm store under /data/home is a deliberate persistent download
cache, not transaction garbage; use `pnpm store prune` only when reclaiming
space is more important than avoiding future downloads.

The helper schedules one targeted DSH child-process restart after the current
Agent turn. The Supervisor, Debian container, and Nginx process remain alive.
Do not append pkill, kill, kill -9, or a second restart command. When the helper
succeeds, report that the profile was updated and that the page may disconnect
for 30 to 60 seconds. Entry validation proves that the plugin can be resolved
and imported; it does not prove that its UI or runtime behavior works. Verify
those separately before claiming success.

If the helper fails, report its failing command and output. Check the current
installation state before retrying an operation with side effects.

Plugin-specific remote settings remain user-controlled. Do not change
allowRemoteSettings, credentials, or /data/dsh/settings.yaml unless the user
explicitly requests that change.
