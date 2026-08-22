# DSH Docker

DeepSeek Harness 的本地构建和 Docker 运行环境。镜像从上游源码构建，不依赖预构建的 DSH 镜像。

## 安装

Linux / macOS：

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker-dev/main/install.sh | bash
```

Linux 容器内 root 模式：

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker-dev/main/install.sh | bash -s -- --root
```

恢复默认的 `node` 模式：

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker-dev/main/install.sh | bash -s -- --user
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/univers629/dsh-docker-dev/main/install.ps1 | iex
```

安装器会同步已有的 Git 工程、写入模式配置并强制重新创建 `dsh`。检测到本地源码修改时会停止，不会覆盖修改。

## 持久化目录

| 容器路径 | Linux 宿主机路径 | 用途 |
| --- | --- | --- |
| `/data/dsh` | `data/dsh` | 会话、设置、插件和凭据 |
| `/data/home` | `data/home` | 用户 home、Python/Node 工具和缓存 |
| `/data/mcp` | `data/mcp` | MCP 服务和数据 |
| `/data/agents` | `data/agents` | 子智能体状态 |
| `/workspace` | `workspace` | 项目工作区 |

Linux 还会启用 `docker-compose.system.yml`。Debian 包仍安装在标准容器路径，相关路径外置到 `data/system/`：`/usr/bin`、`/usr/lib`、`/usr/share`、`/usr/sbin`、`/etc`、`/var/lib` 和 `/var/cache`。`/usr/local` 保留在镜像中，确保 DSH 自带运行文件随镜像更新。Windows 使用镜像系统层。


备份 Linux 安装时，保存 `data/`、`data/system/` 和 `workspace/`。

## 日常管理

Linux / macOS：

```bash
./dsh.sh start
./dsh.sh update
./dsh.sh restart
./dsh.sh logs
./dsh.sh status
./dsh.sh stop
```

Windows：

```powershell
.\dsh.bat start
.\dsh.bat update
.\dsh.bat logs
```

Web UI 默认监听 `127.0.0.1:3080`。公网访问必须经过认证反向代理；不要把 `DSH_BIND_HOST` 设置为 `0.0.0.0`。dpanel 可将 DSH 加入同一 Docker 网络并代理到 `http://dsh:3080`。

## 插件和工具

镜像内置 `dsh-docker-control`，设置页可安排 DSH 重启。插件安装写入 `/data/dsh/profiles`，Python 用户工具使用 `uv tool install` 或 `pip install --user`，Node 用户工具使用 `npm install -g`；这些路径都在 `/data/home` 下。

标准 MCP 可以直接使用 `uvx` 或 `npx`；自定义 MCP 放在 `data/mcp/<name>/`。

## 开发和测试

```bash
node tests/run-mode-smoke.mjs
node tests/docker-control-client-smoke.mjs
node tests/profile-plugin-patches-smoke.mjs
```

许可证：MIT。
