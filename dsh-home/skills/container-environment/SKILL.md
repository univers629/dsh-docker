---
name: container-environment
description: "Use whenever the user asks to install, update, remove, or manage DSH plugins (e.g. dsh-better-sidebar, dsh-vision-router, MCP tools, profile bundles); or when configuring/running MCP servers (Model Context Protocol); or when installing toolchains/subagent CLIs (python, uv, uvx, node, npm, rust, claude-cli, aider); or when querying container system version, architecture, environment variables, directory standards, persistence, permissions, and restarting."
---

# Container Environment Specification & Autonomous SOP

You run inside a production Docker container for DeepSeek Harness (DSH). This document defines your runtime specifications, system architecture, environment variable paths, and strict directory placement standards.

---

## 1. System Version & Hardware Architecture

| Property | Specification | Notes |
|---|---|---|
| **OS Base** | **Debian GNU/Linux 13 (Trixie)** | Standard Linux Debian 13 rootfs |
| **Architecture** | **Multi-Arch (`x86_64` / `aarch64`)** | Check via `uname -m` to download matching precompiled binary wheels (`amd64` / `arm64`) |
| **Node.js** | **v24 (LTS)** | `/usr/local/bin/node`, npm & pnpm 11 built-in |
| **Python** | **Python 3.13** | `/usr/bin/python3`, `/usr/local/bin/python`, pip3, venv |
| **Tool Runner** | **uv & uvx** | `/usr/local/bin/uv`, `/usr/local/bin/uvx` (Ultrafast Python package & MCP runner) |
| **Process Manager**| **procps** | `pkill`, `pgrep`, `ps`, `kill` built-in |
| **Reverse Proxy** | **Nginx 1.26+** | Built-in loopback rewrite proxy listening on private `127.0.0.1:3080` (or an explicitly configured private Docker gateway) and forwarding to `127.0.0.1:3081` |

---

## 2. Core Environment Variables

The following environment variables are pre-configured in your runtime:

```text
HOME=/data/home
DSH_HOME=/data/dsh
DSH_AGENTS_HOME=/data/agents
DSH_PERMISSION_MODE=danger-full-access
DSH_WEB_PORT=3081
NODE_PATH=/app/dsh/node_modules:/data/dsh/profiles/node_modules
PATH=/data/home/.local/bin:/data/home/bin:/data/home/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
```

---

## 3. Strict Directory Placement Standards (目录存放规范)

To guarantee that your work, toolchains, and user data survive container restarts, rebuilds, and updates, **strictly follow this directory taxonomy**:

```text
/ (Container Root)
├── workspace/                     # 💻 [PERSISTENT] User project code & working directory
├── data/                          # 💾 [PERSISTENT] All persistent app and user state
│   ├── dsh/                       # ⚙️ DSH engine state ($DSH_HOME)
│   │   ├── sessions/              # 📜 Chat session history (*.jsonl)
│   │   ├── profiles/              # 🧩 Custom DSH plugins and profile bundles
│   │   ├── settings.yaml          # 🔑 User settings & model API credentials
│   │   └── skills/                # 💡 Installed skills
│   ├── home/                      # 👤 User home root ($HOME, UID 1000 node)
│   │   ├── .local/bin/            # 🚀 Python CLI tools & Subagent binaries (pip --user, uv tool)
│   │   ├── .npm-global/bin/       # 🚀 Node global CLI tools (npm install -g)
│   │   ├── bin/                   # 🚀 Custom standalone scripts and executable binaries
│   │   ├── .cache/                # ⚡ Toolchain caches (uv, pip, npm, npx)
│   │   └── .ssh/                  # 🔐 Git SSH keys and credentials
│   ├── mcp/                       # 🌟 Dedicated MCP server projects & virtual environments
│   │   └── <mcp-server-name>/     # Custom MCP source code, .venv, and SQLite/data files
│   └── agents/                    # 🤖 Subagent shared storage, memory, and cross-session state
├── opt/                           # 📦 [EPHEMERAL] Optional local scratch space (chowned to node)
└── tmp/                           # ⚡ [EPHEMERAL] Fast tmpfs temporary scratch
```

### 🚫 Anti-Patterns (Forbidden Placement)
- **NEVER** write persistent user tools to `/usr`, `/root`, or `/var` (these are in the ephemeral container image layer and will be wiped on updates).
- **NEVER** install Python tools with `sudo` — always use `uv tool install <pkg>`, `pip install --user <pkg>`, or create a virtual environment in `/data/mcp/` or `/workspace/`.

---

## 4. Subagent CLI & Toolchain Recipes

Because `$HOME/.local/bin`, `$HOME/bin`, and `$HOME/.npm-global/bin` are pre-set in `$PATH` and stored in `./data/home`, **any tool installed here is immediately executable and 100% persistent**:

- **Python Subagent CLIs (e.g. `aider`, `goose`, `gpt-engineer`)**:
  ```sh
  uv tool install <package-name>
  # or
  pip install --user <package-name>
  ```
- **Node-based Subagent CLIs (e.g. `claude-code`, `@anthropic-ai/sdk`)**:
  ```sh
  npm install -g <package-name>
  ```
- **Standalone Binary Downloads**:
  Download, `chmod +x`, and move to `/data/home/.local/bin/<binary-name>`.

---

## 5. MCP Server (Model Context Protocol) SOP

### 1. Instant Stdio MCP Execution (uvx / npx)
```sh
# Python MCPs (auto-cached to /data/home/.cache/uv)
uvx mcp-server-fetch
uvx mcp-server-sqlite --db-path /data/mcp/sqlite.db

# Node MCPs (auto-cached to /data/home/.npm-global)
npx -y @modelcontextprotocol/server-filesystem /workspace
```

### 2. Custom MCP Development & Hosting
Always create custom MCP servers under `/data/mcp/<server-name>/`:
```sh
mkdir -p /data/mcp/my-custom-mcp
cd /data/mcp/my-custom-mcp
uv venv
uv pip install mcp httpx
# Executable target: /data/mcp/my-custom-mcp/.venv/bin/python server.py
```

---

## 6. Privileges & Permissions

- You run as non-root user `node` (UID 1000).
- You have full read, write, modify, and delete permissions across `/workspace`, `/data/home`, `/data/dsh`, `/data/mcp`, `/data/agents`, and `/opt`.
- Sandbox permissions are in `danger-full-access` mode; execute bash commands directly without sandbox escalation barriers.

---

## 7. DSH 插件管理标准流程

当用户要求安装、更新或删除 DSH 插件（例如 `dsh-better-sidebar`、`dsh-vision-router`）时：

使用内置的 `/usr/local/bin/manage-dsh-plugin`。它会用中文标明每个阶段、保留 pnpm/DSH 的真实输出、校验组合后的 profile，并且只在当前 Agent 回合完成持久化后安排 DSH 重启。这里的 profile 校验只证明配置能够解析，不证明插件的前端入口或功能已经生效；安装命令返回时，重启和依赖重新链接尚未开始。

```sh
manage-dsh-plugin install <package-name>@latest
manage-dsh-plugin update <package-name>@latest
manage-dsh-plugin remove <package-name>
```

当用户明确要求“重启 DSH”或“重启服务”时，使用通用重启入口：

```sh
manage-dsh-plugin restart
```

该入口会校验 `/run/dsh.pid` 对应的确实是 DSH 主进程，并在当前 Agent 回合结束后只终止这个目标进程；容器现有的 `restart: unless-stopped` 策略会负责重新拉起它。不要在容器内执行 `docker compose`，也不要在前台 Bash 中使用 `pkill`、`kill` 或 `kill -9`。重启命令返回后应先用中文说明“已安排重启”，让当前回复正常结束，再在下一轮查看状态和最近 500 行日志确认结果。

Vision Router 的 `allowRemoteSettings` 是用户明确控制的安全权限，不是插件安装或 trusted host 配置的一部分。除非用户在当前请求中明确要求开启或关闭它，否则 Agent 不得代为调用授权接口、修改 `/data/dsh/settings.yaml`，或声称该权限已经改变。`DSH_TRUSTED_HOSTS` 只声明允许的请求 authority，不等于远程设置授权。

公网访问使用 host 设置的前提是：前置入口已经完成认证，且宿主机的 3080 只监听私有接口。`DSH_PUBLIC_LOCAL_MODE` Cookie 仅用于让浏览器选择官方 host 设置镜像，不是后端授权凭据；不要把 3080 绑定到 `0.0.0.0`。

不要在前台 Bash 调用后追加 `pkill`、`kill` 或第二条重启命令。辅助脚本已经在回合边界后安排了一次精确的优雅重启。在前台调用内杀死 DSH 会让界面只显示“调用被中断，结果未知”。

辅助脚本成功后，立即发送一条简短的中文完成回复，让当前回合结束并执行已安排的重启。例如：

```text
插件 `<package-name>` 已写入持久化 web profile，profile 配置解析通过，但前端尚未确认生效。DSH 会在本轮回复结束后自动重启并加载插件；本轮不会等待重启完成后再补发通知。页面会短暂断开，请等待约 30～60 秒（复杂插件可能接近 1 分钟）后再刷新，过早刷新仍看不到插件属于正常现象。超过 90 秒仍未出现时，再查看最近 500 行日志和插件自身入口。
```

不要假定所有插件都有设置页、侧边栏或按钮。只有在阅读该插件说明或源码并实际验证页面后，才向用户说明它的具体入口和生效状态。

辅助脚本失败后，用中文报告失败行和命令输出。不要声称安装、删除、校验或重启成功；在确认当前安装状态前，不要重试有副作用的插件操作。
