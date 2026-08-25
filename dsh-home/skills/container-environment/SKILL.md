---
name: container-environment
description: "Use when managing DSH plugins, MCP servers, development toolchains, system packages, container paths, persistence, permissions, architecture, or DSH restarts and updates."
---

# DSH Container Environment

You run as root inside a long-lived Debian 13 Docker container. Treat the
container as an Agent development environment, but keep user data in the bind
mounts described below.

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
    DSH_PERMISSION_MODE=@@DSH_PERMISSION_MODE@@
    DSH_HOST_ACCESS=@@DSH_HOST_ACCESS@@
    DSH_WRITABLE_PATHS=@@DSH_WRITABLE_PATHS@@
    DSH_SYSTEM_PACKAGES_PERSISTENT=@@DSH_SYSTEM_PACKAGES_PERSISTENT@@
    DSH_CAN_INSTALL_SYSTEM_PACKAGES=@@DSH_CAN_INSTALL_SYSTEM_PACKAGES@@
    DSH_DOCKER_SOCKET_AVAILABLE=@@DSH_DOCKER_SOCKET_AVAILABLE@@
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

The Debian system directories, including /usr, /etc, and /var, live in the
container writable layer. Apt packages and system configuration survive
docker stop, docker start, and restart of the same container. They do not
survive docker rm, docker compose down, or another operation that recreates
the container. /tmp is ordinary temporary container storage, not a persistent
mount.

/app/dsh contains the managed DSH application. Do not store projects or
credentials there because the built-in updater replaces it.

## Installing tools

- System packages: apt-get update && apt-get install -y <packages>.
- Reclaim downloaded apt archives when needed: apt-get clean.
- Python CLIs: uv tool install <package>; binaries persist under
  /data/home/.local/bin.
- Python projects and MCP servers: create a virtual environment inside the
  project, for example uv venv /data/mcp/<name>/.venv.
- Node CLIs: npm install -g <package>; the configured npm prefix is
  /data/home/.npm-global.
- Standalone tools: place executables in /data/home/.local/bin or
  /data/home/bin.

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
**Restart DSH** stays in the settings header. The updater pulls source into /tmp, reapplies
/etc/dsh-patches, builds, validates Nginx, atomically replaces /app/dsh,
and asks the in-container Supervisor to replace only the DSH child process.
The Debian container and Nginx process stay running. Failed patching, building,
or validation restores the previous application.

Do not rebuild or recreate the container for an ordinary DSH update. Those
operations discard apt-installed tools and other changes in the writable
system layer.

## Security boundary

- DSH runs as container root so the Agent can install Debian packages.
- Container root is not host root. This deployment is not privileged and does
  not mount the Docker socket by default.
- Host access is @@DSH_HOST_ACCESS@@; declared writable paths are
  @@DSH_WRITABLE_PATHS@@.
- The DSH sandbox mode is @@DSH_PERMISSION_MODE@@.
- Docker socket availability is @@DSH_DOCKER_SOCKET_AVAILABLE@@.
- The host publishes port 3080 on loopback by default. Public access requires
  HTTPS plus built-in Basic Auth or an authenticated outer proxy; never assume
  DSH_TRUSTED_HOSTS is authentication.

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
only trusted packages because their build scripts execute as container root.

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
