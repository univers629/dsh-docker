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
| **Reverse Proxy** | **Nginx 1.26+** | Built-in loopback rewrite proxy listening on `0.0.0.0:3080` forwarding to `127.0.0.1:3081` |

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

使用内置的 `/usr/local/bin/manage-dsh-plugin`。它会用中文标明每个阶段、保留 pnpm/DSH 的真实输出、校验组合后的 profile，并且只在当前 Agent 回合完成持久化后安排 DSH 重启。

```sh
manage-dsh-plugin install <package-name>@latest
manage-dsh-plugin update <package-name>@latest
manage-dsh-plugin remove <package-name>
```

不要在前台 Bash 调用后追加 `pkill`、`kill` 或第二条重启命令。辅助脚本已经在回合边界后安排了一次精确的优雅重启。在前台调用内杀死 DSH 会让界面只显示“调用被中断，结果未知”。

辅助脚本成功后，立即发送一条简短的中文完成回复，让当前回合结束并执行已安排的重启。例如：

```text
插件 `<package-name>` 已安装并通过配置校验。DSH 会在本轮回复结束后自动重启，页面短暂断开后刷新即可。
```

辅助脚本失败后，用中文报告失败行和命令输出。不要声称安装、删除、校验或重启成功；在确认当前安装状态前，不要重试有副作用的插件操作。
