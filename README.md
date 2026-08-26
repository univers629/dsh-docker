# dsh-docker

DeepSeek Harness 的本地 Docker 构建与持久化运行方案，提供可由 Agent 持续安装软件和开发的预制 Debian 13 环境。

[![Linux](https://img.shields.io/badge/Linux-supported-FCC624?style=flat-square&logo=linux&logoColor=black)](https://www.kernel.org/)
[![Windows](https://img.shields.io/badge/Windows-supported-0078D4?style=flat-square&logo=windows&logoColor=white)](https://www.microsoft.com/windows)
[![Debian 13](https://img.shields.io/badge/Debian-13-A81D33?style=flat-square&logo=debian&logoColor=white)](https://www.debian.org/releases/trixie/)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

[简体中文](README.md) · [English](README.en.md)

> DSH 本体在容器内更新即可（WebUI 设置里的“DSH 环境”页，或 `./dsh.sh update`），不需要重建容器、也不用追镜像更新——重建容器会丢掉 Agent 在里面用 apt 装的工具链。

## 安装与配置

起步配置 1 vCPU / 2 GB 内存和 10 GB 磁盘即可；打算长期让 Agent 在容器里装工具链，建议 2 vCPU / 4 GB 和 20 GB 磁盘。默认拉取多架构预构建镜像 `ghcr.io/univers629/dsh-docker:latest`（覆盖 `linux/amd64` 和 `linux/arm64`），拉不到时自动退回用当前工程的 `Dockerfile` 现场构建，并把实际来源写进 `.env` 的 `DSH_IMAGE` 和 `DSH_IMAGE_SOURCE`；非交互安装用 `--image-source prebuilt|build` 和 `--image REF`，Windows 对应 `-ImageSource` 和 `-Image`。

安装器会询问本次操作、镜像来源、访问保护方式、反向代理位置、域名和端口绑定、模型密钥代理的上游与配额、容器出站模式，并自动写入 `.env`。选择内置 Basic Auth 时，密码只以 bcrypt 哈希保存到 `data/auth/htpasswd`。DSH 和 Agent 以容器内非特权账户 `dsh`（1000:1000）运行，apt 仍然可用：包装脚本把请求交给以 root 常驻的特权代理，代理按白名单执行。安装器还会问一个容器 root 密码，用于容器内白名单之外的特权操作；它只以 sha512crypt 哈希写入 `data/secret/root.hash`，不写进 `.env`。非交互安装用 `--root-password VALUE`（或环境变量 `DSH_ROOT_PASSWORD`），明确不需要时用 `--no-root-password`；Windows 对应 `-RootPassword` 和 `-NoRootPassword`。这套配置都不会授予宿主机 root、Docker socket 或特权容器权限。

Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker/main/install.sh | bash
```

Windows PowerShell（需要 Docker Desktop，并切换到 Linux containers）：

```powershell
irm https://raw.githubusercontent.com/univers629/dsh-docker/main/install.ps1 | iex
```

Linux 和 Windows 安装器都会获取项目、准备 Debian 13 镜像（默认拉取预构建镜像）并启动同一套容器运行时。Windows 安装器会在需要时自动启动 Docker Desktop Linux Engine。

两个平台的一行命令进入同一套交互菜单：

| 选项 | 作用 |
| --- | --- |
| 1 全新安装 | 工程目录已存在时变为“重新配置并重建容器（保留挂载数据）”，会追问镜像来源、访问保护、反代位置、域名、端口绑定、模型密钥代理和出站模式 |
| 2 在容器内更新 DSH | 在运行中的容器里从 npm 装新版本并重打补丁，只重启 DSH 进程 |
| 3 启动 / 4 停止 / 5 重启 | 只操作已存在的容器，不重建、不丢 apt 装的工具链 |
| 6 查看日志 / 7 查看状态 | 转发到 `./dsh.sh logs` 和 `status` |
| 8 删除 | 输入 `DELETE` 确认后完整清理容器、镜像、挂载、网络、构建缓存和工程目录 |

只有第 1 项会问 Debian 13 镜像来源（预构建或本机构建）；第 2 至 8 项直接对现有容器执行。

无人值守安装示例：

```bash
curl -fsSL https://raw.githubusercontent.com/univers629/dsh-docker/main/install.sh | bash -s -- install --access local --image-source prebuilt --root-password '至少12位的密码' --non-interactive
```

密码写在命令行会进入 shell 历史，更稳妥的做法是用环境变量：

```bash
DSH_ROOT_PASSWORD='至少12位的密码' bash install.sh install --access local --non-interactive
```

在已下载的工程目录中执行 `bash install.sh --help` 可查看 Linux 参数；Windows 可直接运行 `powershell -ExecutionPolicy Bypass -File .\install.ps1`。

### 镜像发布

预构建镜像由 [.github/workflows/publish-image.yml](.github/workflows/publish-image.yml) 在 GitHub 原生 amd64 与 arm64 runner 上分别构建后合并成多架构清单，三种触发方式：

- **自动跟随上游**：每天 03:17 UTC 查一次 npm 上 `@deepseek-ai/dsh` 的 `latest`，只有该版本还没有对应镜像标签时才构建，因此上游一天连发多个版本也最多发一版镜像。
- **手动触发**：Actions 页面运行 workflow，可指定 npm 版本或 dist-tag（默认 `latest`）。工程文件或补丁改动后想立刻重新发版就用这个。
- **打标签发版**：推送 `v*` 标签。

每次发布都会打上 `latest`、`dsh-<DSH 版本>` 和 `<日期>-<提交>` 标签，所以包页面能直接看出镜像里装的是哪个 DSH。上游改动让某条产物补丁的锚点失效时构建会直接失败，不会推出一个没打补丁的镜像。公开仓库使用标准 runner 不计费，GHCR 上公开包的存储和拉取流量也不计费。新建的 GHCR 包默认私有，首次发布后需要在仓库 → Packages → Package settings → Change visibility 改成 public，否则服务器上匿名拉取会得到 `denied`。

## 日常管理

首次安装后，日常只需要管理同一个容器：

```text
Linux: ./dsh.sh [start|update|stop|restart|logs [服务]|status|shell|root-shell|verify|keys|egress|remove]
Windows: .\dsh.bat [start|update|stop|restart|logs [服务]|status|shell|root-shell|verify|keys|egress|remove]
```

`shell` 进入 DSH 真正的运行身份（非特权 `dsh` 账户），`root-shell` 是宿主机管理员通道（`docker exec` 直连容器 root，容器内部无法这样提权），`verify` 在容器里跑 `verify-dsh-hardening`，共 22 项，逐项检查运行 UID、能力集、`no-new-privileges`、特权代理 socket、启动链文件是否 root 独占写（`boot-chain-immutable`）、Supervisor / Nginx 主进程 / 特权代理与 `dsh` 的 UID 是否分离（`signal-isolation`）、apt 卸载保护是否真的生效（`apt-removal-guard`）、root 密码状态以及 `/proc`、`/sys`、cgroup 的挂载情况，任一项不合格就以非零码退出。

`start` 只在容器尚不存在时准备 Debian 13 镜像（按 `.env` 记录的来源拉取或构建）；之后只启动原容器。`stop`、`restart` 和容器内 Agent 执行的 `apt install` 都保留在同一个容器可写层。`remove`/`down` 会删除容器可写层，只有 `/data` 和 `/workspace` 绑定挂载会保留。不要把 `update` 当成项目或镜像更新，它只是在容器内重装 DSH 的 npm 包并替换 `/app/dsh`。容器健康检查同时探 Nginx 入口和 DSH 自己的端口，所以 DSH 崩溃循环时 `docker ps` 会显示 `unhealthy`，而不是掩盖成 `healthy`。

如需在服务器上彻底清空本项目后重新安装，请在工程目录中重新运行安装器并选择“删除”（菜单第 8 项），或执行：

```bash
./install.sh delete
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DshAction delete
```

删除会精确清理 `dsh` 容器、DSH 镜像（`dsh:*` 以及 `.env` 记录的预构建引用）、本项目挂载和网络、全局 Docker 构建缓存以及工程目录；需要输入 `DELETE` 确认。不会使用 `name=dsh` 子串筛选，也不会删除外部共享网络（例如 `dpanel-local`）。无论在工程目录内还是在它的上一级目录执行，安装器都会先把自己复制到临时目录再删除，脚本文件和当前目录不会因为位于被删目录内而中断删除。

## 公网访问与认证

DSH 本身不提供登录认证。安装器默认将 3080 绑定到 `127.0.0.1`，公网访问必须经过 HTTPS 和认证入口；不要使用 `0.0.0.0`、`::` 或其他通配绑定。

安装器提供三种访问模式：

1. `local`：仅本机或 SSH 隧道访问。
2. `trusted-proxy`：由 Cloudflare Access、dPanel、宿主机 Nginx、私有 VPN 或其他外层入口负责认证；安装器可记录 trusted hosts 和外部 Docker 网络。
3. `basic`：由容器内 Nginx 使用 bcrypt 密码文件认证。它不提供 MFA，公网部署仍应在外层启用 HTTPS。

Cloudflare Access/OIDC + MFA 的安全能力高于单纯 Basic Auth。Caddy、Nginx 和容器内 Nginx 的反代性能差异对 DSH 使用场景可以忽略。

宿主机 Nginx 示例（证书路径替换为实际文件；认证配置按所选模式补充）：

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

使用 Docker 面板反代时，在安装器中选择 Docker 容器/面板并填写反代容器所在的网络名（dPanel 通常是 `dpanel-local`），上游使用 `http://dsh:3080`。宿主机反代或 SSH 隧道使用 `http://127.0.0.1:3080`。

外部网络必须先存在，Compose 不会代建。如果反代面板还没部署，直接填一个新名字（例如 `dsh-proxy`），安装器会征求同意后创建它；之后部署反代时执行 `docker network connect dsh-proxy <反代容器名>` 接入同一网络即可。`dsh-private` 是 DSH 自己管理的内部网络名，不能填成外部网络。

## 架构与持久化

```mermaid
flowchart LR
    Client["浏览器 / SSH 隧道 / 已认证反代"] -->|私有 3080| Proxy["容器内 Nginx"]
    Proxy -->|loopback 3081| DSH["DSH Web 服务"]
    DSH --> Sessions["/data/dsh<br/>会话、设置、凭据、插件"]
    DSH --> Home["/data/home<br/>用户工具链与 SSH"]
    DSH --> MCP["/data/mcp<br/>MCP 服务与数据"]
    DSH --> Agents["/data/agents<br/>子智能体共享状态"]
    DSH --> Workspace["/workspace<br/>项目工作区"]
    Sessions -.-> H1["./data/dsh"]
    Home -.-> H2["./data/home"]
    MCP -.-> H3["./data/mcp"]
    Agents -.-> H4["./data/agents"]
    Workspace -.-> H5["./workspace"]
```

持久化目录：

这些目录通过绑定挂载持久化。Debian 系统本身（包括 `/usr`、`/etc`、`/var`）留在容器可写层中，不使用覆盖系统目录的 overlay；因此同一个容器停止、启动或重启后，Agent 安装的 apt 软件和系统配置仍在。

| 容器路径 | 宿主机路径 | 内容 |
| --- | --- | --- |
| `/data/dsh` | `data/dsh` | 会话、设置、凭据、profile 和内置插件 |
| `/data/home` | `data/home` | 用户家目录、SSH、npm/uv 工具链和缓存 |
| `/data/mcp` | `data/mcp` | 自定义 MCP 源码、虚拟环境和数据 |
| `/data/agents` | `data/agents` | 子智能体共享状态 |
| `/workspace` | `workspace` | Agent 工作区 |
| `/usr`、`/etc`、`/var` | 容器可写层（不单独挂载） | Debian 系统、Agent 用 `apt` 安装的软件、配置和 apt 缓存；`/bin`、`/sbin`、`/lib` 在 Debian usr-merge 下跟随 `/usr` |

删除容器（`docker rm` 或 `docker compose down`）会删除这部分系统可写层；重新 `start` 会得到初始 Debian 13 系统。`/data`、`/workspace` 和 Docker 镜像本身不因此自动删除。

## 模型密钥防御链条

威胁模型很直接：容器里的 Agent 以 `danger-full-access` 运行，可以执行任意命令。所以任何放在容器内的模型 API 密钥都必然可被读出——提示注入不需要「骗」它说出密钥，一条 `cat` 就够了。非特权运行、能力集收敛、apt 白名单这些措施防的是提权与逃逸，不是「读自己本来就有权读的文件」，对密钥没有帮助。

唯一有效的做法是把密钥移出容器。`.env` 里 `DSH_MODEL_BROKER=on` 时，安装器叠加 `docker-compose.keys.yml`，额外运行一个独立容器 `dsh-key-broker`：

- 真实密钥只存在于宿主的 `data/broker/keys.json`（0600，`data/` 已在 `.gitignore` 中）和该容器的内存里。这份文件以只读方式挂到 broker 的 `/etc/dsh-broker`，**绝不挂进 DSH 容器**；两个容器之间只有 HTTP，没有共享卷。
- DSH 侧把模型 base_url 配成 `http://dsh-key-broker:8080/u/<上游名>/v1`，api key 填任意占位串。容器内不存在真实密钥这个字符串，翻遍文件系统和环境变量也找不到。

broker 的防护面：

- 剥掉客户端送来的一切认证材料（`authorization`、`api-key`、`x-api-key`、`x-goog-api-key`、`cookie` 等）后再注入真实密钥，所以在容器内伪造或覆盖认证头没有意义。
- 上游主机固定由 `keys.json` 里的 `baseUrl` 决定，客户端只能选「哪个上游 + 哪条被允许的路径」，选不了主机。`baseUrl` 必须是 https，不允许内嵌凭据，也不允许指向环回、私网或链路本地地址。
- 路径前缀白名单：默认只放行常见的 OpenAI / Anthropic / Gemini 兼容端点（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/models` 等），账号管理、文件上传之类的接口进不去。路径先归一化再判定，`%2e%2e` 这类穿越写法直接 400。
- 只放行 GET 和 POST，其他方法 405。
- 每分钟限速加 UTC 每日配额（`requestsPerMinute` / `dailyRequestBudget`），超出返回 429；同时在途请求超过 `DSH_BROKER_MAX_CONCURRENT` 返回 503。
- 上游返回 ≥400 时，响应体里的密钥字面值会被替换成 `***redacted***`——有些上游会在错误信息里回显收到的密钥。
- 审计日志只记元数据（时间、上游名、路径、判定、状态码、字节数、耗时），不记请求体、query 和任何 header 值。
- 探针：`/healthz` 返回 204，`/status` 返回 JSON（上游名、上游主机、配额与今日用量，不含密钥）。
- 容器本身：非 root（UID 1000）、`cap_drop: ALL`、`no-new-privileges`、只读根文件系统、不发布任何宿主端口。

配置方法：人工安装直接跑向导，按提示逐个输入上游密钥（不回显）；自动化用 `--model-keys-file` 指向一份 0600 的 `keys.json`，`--model-key NAME=KEY` 只是给没法交互的流水线留的后路——写在命令行上的密钥会进 `ps`。上游地址用 `--model-base-url NAME=URL`（deepseek/openai/anthropic 有内置默认），`--no-model-broker` 关掉代理并清空 `data/broker/keys.json`。真实密钥只落到 `data/broker/keys.json`，`.env` 里只留开关和地址。也可以直接编辑这个文件，broker 每 5 秒重载配置，不需要重启容器。结构如下（示例里的密钥是假的）：

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

`requestsPerMinute` 与 `dailyRequestBudget` 缺省或写 `0` 都表示**不限**：装上 broker 并不会自动带来配额保护，不写这两个字段等于只防密钥外泄。既然「不保护额度」是这套方案最重要的边界，它们应该显式写出来——`requestsPerMinute: 60` 是个合适的起步值，`dailyRequestBudget` 按自己的实际用量设，宁可先设紧一点，撞到 429 再往上调。`maxRequestBytes` 缺省是 8 MiB。
对应到 DSH 的模型设置：base_url 填 `http://dsh-key-broker:8080/u/deepseek/v1`，api key 填任意占位串（安装器摘要里给的是 `dsh-broker-placeholder`）。`headerName` 和 `headerTemplate` 默认是 `authorization` 与 `Bearer {key}`，只有 Anthropic 这类用别的认证头的上游才需要写。

运维命令：`./dsh.sh keys` 打印 broker 的 `/status`（上游、配额、今日用量、放行与拒绝计数），不会输出密钥。

**边界要写清楚**：broker 保护的是**密钥字面值不外泄**——密钥不会被复制出容器，也不会在别处被复用。它**不保护额度，也不保护数据**：一个被注入的 Agent 仍然可以借它用你的额度发请求，并把容器里的数据当作 prompt 送到上游。broker 也**不对客户端做认证**，凡是能连上 `dsh-internal` 的东西都能用它发请求（详见「诚实的边界清单」）。可用的缓解手段只有两个：`requestsPerMinute` / `dailyRequestBudget` 把损失限在一个上限内，出站白名单让数据不能被送到你没批准的地址。

实测验证（临时验证栈 `dsh:verify` 加独立 compose 工程）：DSH 容器用占位 key 发 `GET http://dsh-key-broker:8080/u/deepseek/v1/models`，broker 剥掉占位认证头、注入真实密钥并转发到 `https://api.deepseek.com`，上游返回 401（验证用的本来就是假密钥）——注入链路成立。同时真实密钥字面值在 DSH 容器的 `/etc`、`/data`、`/app`、`/usr/local`、`/root`、`/workspace` 全文搜索命中 0 处，在所有进程的环境里命中 0 处，在响应体与 broker 审计日志里也命中 0 处。

## 两种出站模式

`.env` 里的 `DSH_EGRESS_MODE` 决定容器怎么出网。

**open（默认）**：容器像普通 Docker 容器一样直连公网。省事，但被注入的 Agent 可以把数据 POST 到任意地址，也可以绕开 key broker 直接连模型厂商。

**allowlist**：安装器叠加 `docker-compose.isolated.yml`，容器出网必须经过独立的 `dsh-egress` 正向代理（监听 3128），由它按域名白名单放行。网络拓扑：

```text
宿主 3080 ──► dsh-ingress ──► dsh-app:3080         Nginx 四层转发，隔离模式下唯一发布端口的容器
                     dsh ──► dsh-egress ──► 公网    域名白名单，HTTP 仅 80/443，CONNECT 仅 443
                     dsh ──► dsh-key-broker ──► 模型上游    注入真实密钥
```

dsh 容器此时只挂 `dsh-internal`（`internal: true`，没有默认网关），所以直连外网不是「被拒绝」，而是根本没有路由。

上游写成 `dsh-app:3080` 而不是 `dsh:3080` 是必须的：`dsh-ingress` 在 `dsh-private` 网络上顶着 network alias `dsh`（这样 DPanel 那种把上游写成 `http://dsh:3080` 的反代才不用改配置），而 Docker 内嵌 DNS 会把查询方**自己**的 alias 也算进解析结果——实测 ingress 解析 `dsh` 会解析到它自己并自连失败（`connect() to <自己>:3080 failed (99)`）。所以 `docker-compose.isolated.yml` 给 dsh 服务在 `dsh-internal` 上另挂了一个专用别名 `dsh-app`，只有它能无歧义地指向 DSH 本体。

内置白名单只有 15 个域名：`deb.debian.org`、`security.debian.org`、`registry.npmjs.org`、`pypi.org`、`files.pythonhosted.org`、`github.com`、`api.github.com`、`codeload.github.com`、`objects.githubusercontent.com`、`raw.githubusercontent.com`、`github-releases.githubusercontent.com`、`pkg-containers.githubusercontent.com`、`ghcr.io`、`astral.sh`、`nodejs.org`。

代理默认拒绝这些绕过域名判定的写法：IP 字面量（含 `127.0.0.1`、`169.254.169.254`、10/8、172.16/12、192.168/16、`::1`、`fd00::/8`）、`localhost` 与 `.internal`、`.local`、`.localdomain`、`.localhost` 后缀、整数或十六进制形式的地址（`2130706433`、`0x7f000001`）、带凭据的 URL（`user:pass@host`）、非 http(s) 的 scheme，以及 CONNECT 到 443 以外的端口。逐跳头在转发时剥掉；代理不做 TLS 中间人，容器里的证书链保持原样。

放行新域名：在宿主的 `.env` 里写 `DSH_EGRESS_ALLOWED_HOSTS`（逗号分隔，支持 `*.example.com` 这种最左一级通配，不匹配裸 `example.com`），然后重启这套容器；安装时也可以直接用 `--egress open|allowlist` 和 `--egress-allow HOSTS` 定好。注意它是**整体替换**内置白名单，仍然需要的域名要自己写全。容器内改不了白名单，这是有意的——Agent 不能给自己开门。

DNS rebinding 防护：白名单只认域名，而域名可以被解析到内网。所以真正建连之前还会看一眼 DNS 解析结果，只允许公网单播地址；解析到环回、私网、链路本地（含云 metadata 的 `169.254.169.254`）、CGNAT 或 IPv4 映射的私网地址一律 403。这一层可以用 `DSH_EGRESS_ALLOW_PRIVATE_UPSTREAM=1` 关掉，只有白名单里确实写了同网段的内网镜像源时才该关；**关掉就等于放弃这层防护**，此时一个受控的白名单域名就能把代理变成打宿主机和内网的工具。

入口为什么是四层转发：`dsh-ingress` 用 Nginx 的 `stream` 模块做 TCP 转发，不解析 HTTP、不改 Host、不加 `X-Forwarded-*`。这是刻意的——Basic Auth 与同源、凭据边界仍然由 dsh 容器内的那个 Nginx 负责，语义完全不变。它的 `proxy_pass` 用变量形式，每条新连接都走 Docker 内嵌 DNS，所以 dsh 容器重启换 IP 后会自动跟上。

容器内的包管理器：`bin/entrypoint.sh` 在隔离模式下写 `/etc/apt/apt.conf.d/00-dsh-proxy`、`/etc/pip.conf`、npm 的 globalconfig 和 `git config --system http.proxy`，并给容器设 `NODE_USE_ENV_PROXY=1`（Node 24 的 `--use-env-proxy`；undici/fetch 默认不读代理环境变量）。这些配置文件是必需的：这几个工具对代理环境变量的支持都不完整，apt 更是在特权代理里被清过环境。只有带 `dsh-docker managed` 标记的文件才会被改写或回收，你自己写过的配置会被保留并提示；切回 open 模式时这些文件会被删掉，免得 apt 一直去连一个已经不存在的代理。

运维命令：`./dsh.sh egress` 打印代理的 `/status`（白名单条数、允许端口、解析结果校验是否开启、活跃连接数、放行与拒绝计数）。

三个旁路容器都按同一套加固运行：

| 容器 | 运行身份 | 加固 | 宿主端口 | 挂载 | 职责 |
| --- | --- | --- | --- | --- | --- |
| `dsh` | PID 1 是 root；DSH、Agent 会话与 Nginx worker 是 1000:1000 | `cap_drop: ALL` + 7 项能力、`no-new-privileges`、可写系统层 | open 模式下发布 3080；隔离模式下不发布 | `/data`、`/workspace` 等绑定挂载 | DSH 本体与 Agent |
| `dsh-key-broker` | 1000:1000 | `cap_drop: ALL`、`no-new-privileges`、`read_only` 根文件系统 + 16 MB `/tmp` tmpfs | 不发布 | 只读挂载 `data/broker` | 注入模型密钥、限速与配额 |
| `dsh-egress` | 1000:1000 | 同上 | 不发布 | 无 | 出站域名白名单正向代理 |
| `dsh-ingress` | 1000:1000 | 同上 | 隔离模式下发布 3080（默认仍绑 `127.0.0.1`） | 无 | 四层转发到 `dsh-app:3080`，并在 `dsh-private` 上顶替 `dsh` 这个名字 |

## user namespace remap

前面几层收敛的是「容器内能做什么」。剩下最有价值的一层是把容器 root 和宿主 root 彻底分开：宿主开启 user namespace remap 后，容器里的 UID 0 在宿主上只是一个普通的 subuid，内核漏洞或运行时漏洞真的导致逃逸时，落到宿主上的身份是那个普通用户，而不是 root。

这台机器上的现状（实测，Docker 29.7.2）：

- `docker info` 的 SecurityOptions 是 `["name=seccomp,profile=builtin","name=cgroupns"]`，**没有 `name=userns`**——当前未启用，而且 Docker Desktop / WSL2 后端不支持启用。
- 容器内 `/proc/self/uid_map` 是恒等映射 `0 0 4294967295`，因此 `bin/entrypoint.sh` 把 `DSH_USERNS_REMAP` 判为 `false`。这条判定逻辑用真实 remap 映射（例如 `0 165536 65536`）验证过，会正确判成 `true`。

开启方法（Linux 宿主，编辑 `/etc/docker/daemon.json`）：

```json
{
  "userns-remap": "default"
}
```

然后 `sudo systemctl restart docker`。

代价要算清楚：

- 这是 **daemon 级**开关，影响宿主上的所有容器，不是只影响 DSH。已有容器需要重建，属主也要重新对齐。
- 绑定挂载的属主要重新对齐：容器内的 1000 对应宿主上 `dockremap` 的 subuid 区间（常见是 `165536 + 1000 = 166536`），不对齐容器起来就写不了 `/data`。启用后容器内也改不动这些目录的属主，`bin/entrypoint.sh` 检测到这种情况会打印需要在宿主执行的 `chown`。
- `install.sh --userns-preflight`（Linux）做预检：检测是否已启用、读出宿主的 subuid 区间、算好偏移并对齐绑定挂载属主。它**绝不会自动改 `/etc/docker/daemon.json`**——那是宿主级配置，必须由你决定并自己重启 Docker。
- **Docker Desktop / WSL2 不支持**：这台机器实测 `docker run --userns` 只接受 `host`。所以这一条只对 Linux VPS 有意义。

本阶段交付的是**支持、预检与文档**，不是「已在这台机器上启用」。

### 备选：rootless Docker

如果你愿意付更多代价，Linux 上还有一条比 `userns-remap` 更强的路径：rootless Docker——整个 daemon 都跑在普通用户下，不只是容器进程被映射，daemon 自己也不是 root，被攻破时的起点就低一层。

代价也更大，所以这里只作为备选、不作为推荐默认：

- 端口小于 1024 无法直接绑定，要么改 `net.ipv4.ip_unprivileged_port_start`，要么在前面加一层宿主转发。DSH 默认用 3080，这一条影响不大，但同机的 80/443 反代会受影响。
- 网络走 RootlessKit / slirp4netns 之类的用户态实现，吞吐与源 IP 保留上有取舍；部分存储与网络驱动不可用或需要较新内核。
- cgroup 资源限制要 cgroup v2 加 systemd 委派才完整，否则 `pids_limit` 之类的约束可能不生效。

## 诚实的边界清单

- **共享内核**：容器和宿主共用同一个内核，Dirty Pipe、runC 这类内核与运行时漏洞防不住，任何容器内的加固都拦不住它们。只能靠升级宿主内核与 Docker；userns-remap 只降低逃逸的影响面，不消除逃逸本身。
- **免密 apt**：默认 `DSH_PRIVILEGED_APT=nopasswd`，意味着容器内可以通过白名单代理变成容器 root。这是「Agent 能自己装软件」和「容器内不可提权」之间的取舍，要收紧就设 `DSH_PRIVILEGED_APT=password`，代价是每次装包都要人来输密码。
- **卸载保护是按包名的白名单**：它只覆盖启动链真正依赖的那些包（Nginx 系列、`openssl`、`ca-certificates`、`passwd`、`adduser`、`mawk`、`util-linux`）。名单之外的包被卸掉仍可能让某个功能不可用——某个语言运行时、某个调试工具、你自己装的东西——只是不会让容器起不来。级联绕法靠执行前的 `apt -s` 模拟拦，模拟结果与真实执行之间理论上仍存在时间差。
- **broker 不保护额度与数据**：它只保证密钥字面值不出容器。被注入的 Agent 仍然可以用你的额度发请求、把数据送到上游，只能用限速和配额把上限压低。
- **broker 不对客户端做认证**：凡是能连上 `dsh-internal` 网络的东西——实际上就是 dsh 容器本身——都能用它发请求。这是刻意的：任何放进 DSH 容器的 broker 凭据同样会被一条 `cat` 读出来，加了等于没加。所以它的保证严格限定为「真实密钥字面值不进入 DSH 容器」，额度靠 `requestsPerMinute` / `dailyRequestBudget` 兜，数据外泄靠出站白名单兜。
- **出站白名单只按域名判定**：已经加了 DNS 解析结果校验，但代理不做 TLS 中间人，所以放行域名内部的任意路径都能访问——`github.com` 一旦放行，往它上传内容的接口也一起放行了。
- **真正的第一道防线仍然是「不要把不可信内容喂给 Agent」**。上面每一层都只是在缩小已经发生的注入能造成多大后果。

优先级排序，从最有效到最边缘：**可信输入 > 密钥外置 > 出站白名单 > 容器逃逸加固**。前两项决定会不会出事和出事有多贵，第三项决定数据能流到哪里，最后一项只在前面三层都失守之后才起作用。

## 项目特殊处理

<details>
<summary>展开查看内置控制、权限和稳定性说明</summary>

### 内置控制插件

镜像自带 `dsh-docker-control`，首次启动空 profile 时自动恢复。它在设置窗口左侧导航新增“DSH 环境”页（与“通用设置 / 模型 / 插件 / Agent 预设”同级），显示当前与最新 DSH 版本，提供“检查更新”“立即更新”，以及“电脑 UI / 手机 UI”布局选择器。打开设置不会自动联网，只有按下“检查更新”才会查询 npm registry 上的最新版本；手机布局把设置面板改为全屏、左侧导航改为可横向滑动的顶部标签条，并把首页侧边栏改成抽屉：收起时完全让位给对话区，左上角的浮动按钮负责展开，展开后浮在对话之上而不是挤压它。首次访问按浏览器 UA 自动选择布局。更新在容器内从 npm 安装目标版本、对产物重新应用当前补丁并原子替换，失败时保留旧版本，不需要 SSH。更新和“重启 DSH”都只替换 Supervisor 管理的 DSH 子进程，不重启 Debian 容器或 Nginx。设置窗口顶部还提供 WebUI 配置文件编辑器，编辑器固定读写 `/data/dsh/settings.yaml`，保存前校验 YAML 并保护并发修改。

容器内 Agent 应使用 `manage-dsh-plugin` 安装、更新或删除插件。它会在 `/data/dsh/profiles` 下创建同卷临时 profile，允许 pnpm 执行插件所需的构建脚本，通过配置、入口解析和实际导入验证后再原子替换正式 profile。正常结束会立即删除临时 profile 和本次 pnpm Git 构建临时目录；断电或强制终止留下的事务和旧备份会在下一次 DSH 启动或插件操作时自动恢复、清理。pnpm 的内容寻址 store 是 `/data/home` 下有意保留的下载缓存，可在需要释放空间时执行 `pnpm store prune`。

### WebUI 与反代稳定性

配置编辑器使用独立 portal 和固定高度滚动区域，避免设置页闪烁、输入框高度跳动和白屏。内置 WebSocket keepalive 补丁用于降低空闲反代断开导致的 UI 假死。

通过公网域名访问时，容器 Nginx 只在请求已经通过内置 Basic Auth 或可信外层认证后，将请求转为 DSH 的内部回环访问。`DSH_TRUSTED_HOSTS` 只校验浏览器 authority，不等同于登录认证，也不会自动打开插件的远程设置写权限；此类授权仍由对应插件设置页明确控制。

### 权限边界

DSH、Agent 会话和 Nginx worker 都以非特权账户 `dsh`（1000:1000）运行；只有 PID 1、Nginx 主进程和特权代理保持 root。入口脚本仍然保护凭据和 SSH 私钥权限，并把 `/data`、`/workspace` 的属主对齐到运行账户。

容器 `cap_drop: ALL`，只补回 `CHOWN`、`DAC_OVERRIDE`、`FOWNER`、`FSETID`、`SETGID`、`SETUID`、`KILL`——降权启动和 dpkg 需要这些，其中没有任何一项能加载内核模块、ptrace 其他进程、挂载文件系统或直接访问裸设备。`no-new-privileges:true` 保持开启，因此镜像里不装 setuid 的真 sudo。

容器内唯一的提权入口是 `/run/dsh-priv/helper.sock`（0660 root:dsh）上的特权代理：

- `apt`、`apt-get`、`apt-mark` 和 `update-dsh` 是包装脚本，默认免密，但只放行固定子命令与形如包名的参数；`apt-cache` 是纯查询命令，`dsh` 账户直接跑就能用，因此镜像里没给它做软链，它不占用特权代理的串行锁（经 `dsh-root apt-cache` 显式调用时同样受这套白名单约束）；`-o`/`-c`/`-t`、本地路径、`.deb` 文件、通配模式和 `apt-get source` 一律拒绝（退出码 126）。`sudo` 也只是同一个包装脚本，`sudo -i` 拿不到 shell。
- 卸载保护：`remove`/`purge`/`autoremove`/`autopurge` 不许卸掉容器启动链依赖的包。它防的不是提权，而是「一条命令把自己住的房子拆了」——`apt-get purge -y nginx` 会把反向代理从容器可写层里删掉，已经在跑的 nginx 进程靠已删除的 inode 继续活着，容器还一直报 healthy，直到下一次重启才发现再也起不来；而且这种损坏发生在容器可写层，`docker restart` 救不回来，只能 `docker compose up -d --force-recreate` 重建容器。防护分两层：
  - **显式点名拒绝**：受保护的包是 `nginx`、`nginx-common`、`nginx-core`、`nginx-light`、`nginx-full`、`nginx-extras`、`libnginx-mod-stream`、`ca-certificates`、`openssl`、`passwd`、`adduser`、`mawk`、`util-linux`。带 `:arch` 限定或 `=version` 锁定的写法一样拦得住。
  - **执行前 `apt -s` 模拟**：解析模拟计划里的 `Remv`/`Purg` 行，拦住「点名一个不在名单里的包、让 apt 级联把运行时带走」的绕法，例如 `apt-get purge -y iproute2`（计划里会出现 `Purg nginx`），或先 `apt-mark auto nginx` 再 `apt-get autoremove -y --purge`。命中即整条请求原子拒绝（退出码 126），不会部分执行。
  - 只限制卸载：这些包的安装、重装、查询完全不受影响；你自己装的包照旧可以随便卸。
- `apt-mark` 现在也走同一个包装脚本。此前镜像只给 `apt-get` 做了软链，`apt-mark` 会以 UID 1000 直接跑真实的 `apt-mark`，写 `/var/lib/apt/extended_states` 时报 `mkstemp (13: Permission denied)` 并以 rc=100 失败；补上软链后 `apt-mark hold`/`unhold`/`auto`/`manual` 经代理可正常使用。
- 其他任意特权命令走 `dsh-root run <命令>`，必须提供容器 root 密码。
- 防暴破：同一 900 秒窗口内累计 5 次失败即锁定，起始 300 秒并按 2 的幂递增至上限 3600 秒，每次失败还会让下一次尝试额外延迟（1 秒起，每次 +500 毫秒，上限 8 秒）。锁定期内连正确密码也直接拒绝，但 apt 不受影响。
- 密码哈希放在 `/root/dsh-secret`（0700 root:root，只读挂载）和 `/etc/shadow`，`dsh` 账户两者都读不到，所以容器内拿不到哈希做离线爆破。

针对公开的容器逃逸手法：不启用 privileged、不挂载 Docker socket、不共享宿主 PID/network/IPC/user namespace、不放开 seccomp 或 AppArmor、不授予 `SYS_ADMIN`/`SYS_MODULE`/`SYS_PTRACE`/`DAC_READ_SEARCH`，并设置 `pids_limit`。容器内 root 也不获得宿主机管理员权限。

需要说明清楚的边界：apt 免密意味着容器内的 Agent 仍然可以安装软件、改动容器可写层，真正的信任边界是容器本身而不是 `dsh` 账户。不过这条边界已经收窄：启动链的 9 个路径（entrypoint、Supervisor、特权代理、各个包装脚本等）都是 root 独占写，运行时依赖的包不可卸载，所以 Agent 在可写层里剩下的能力是「装东西、改自己本来有权改的配置」，不再包括「把容器拆了」。别把它读成绝对安全：`upgrade`/`dist-upgrade` 仍可能引入破坏性变更，你自己装的包被卸掉仍然会丢东西，`autoremove` 也仍会摘掉真正变成孤儿的依赖。`--no-root-password` 会关掉 `dsh-root run`，此时容器内没有任何通往任意 root 命令的路径。这一层之外还防不住什么，收敛在上面的「诚实的边界清单」一节。

### 插件与工具链

插件安装、会话管理和 MCP 部署所需的 `/data` 写权限已纳入沙箱。通过 `apt` 安装的软件写入标准 Debian 路径并持久化在该容器的可写层；Python/Node 工具链分别放在 `/data/home/.local` 和 `/data/home/.npm-global`。容器启动时会根据实际系统、架构和权限变量渲染 `container-environment` skill。

</details>

## 许可证

[MIT License](LICENSE)
