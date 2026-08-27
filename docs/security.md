# 安全模型详解

本文补充 [README](../README.md) 的「安全模型」一节，说明威胁模型、每层控制的具体实现，以及各层的边界。

## 威胁模型

容器内的 Agent 以 `danger-full-access` 运行，可以执行任意命令。因此设计前提是：**容器内的任何文件和环境变量都视为 Agent 可读**，容器内的加固目标是限制提权与逃逸，而不是阻止 Agent 读取它本来有权读取的内容。

由此得到的优先级：**可信输入 > 密钥外置 > 出站白名单 > 逃逸加固**。前两项决定事故是否发生以及代价高低，第三项决定数据能流向哪里，最后一层只在前三层失效后起作用。

## 运行身份与能力集

- DSH、Agent 会话与 Nginx worker 以非特权账户 `dsh`（1000:1000）运行；只有 PID 1、Nginx 主进程和特权代理保持 root。
- 容器 `cap_drop: ALL`，只补回 `CHOWN`、`DAC_OVERRIDE`、`FOWNER`、`FSETID`、`SETGID`、`SETUID`、`KILL`。降权启动与 dpkg 需要这些能力，其中没有任何一项可以加载内核模块、ptrace 其他进程、挂载文件系统或访问裸设备。
- `no-new-privileges: true` 保持开启，镜像中不安装 setuid 的真实 sudo。
- 不使用 privileged、不挂载 Docker socket、不共享宿主 PID/network/IPC/user namespace、不放开 seccomp 与 AppArmor、不授予 `SYS_ADMIN`/`SYS_MODULE`/`SYS_PTRACE`/`DAC_READ_SEARCH`，并设置 `pids_limit`。
- 入口脚本会保护凭据与 SSH 私钥权限，并把 `/data`、`/workspace` 的属主对齐到运行账户。

对应到常见逃逸手法：`CAP_SYS_ADMIN` 相关的 `unshare` 挂载逃逸与 cgroup `release_agent` 写入均因缺少该能力而不可行；Docker socket 逃逸因未挂载 socket 而不可行；内核与容器运行时漏洞（例如 Dirty Pipe、runC 系列 CVE）无法在容器内加固层面消除，只能通过升级宿主内核与 Docker 缓解，并用 user namespace remap 降低逃逸后的影响面。

## 提权闸门

容器内唯一的提权入口是 `/run/dsh-priv/helper.sock`（0660 root:dsh）上的特权代理。

- `apt`、`apt-get`、`apt-mark` 与 `update-dsh` 是包装脚本，默认免密，只放行固定子命令与形如包名的参数；`-o`/`-c`/`-t`、本地路径、`.deb` 文件、通配模式和 `apt-get source` 一律拒绝（退出码 126）。`sudo` 指向同一个包装脚本，`sudo -i` 无法取得 shell。
- `apt-cache` 是纯查询命令，`dsh` 账户可直接执行，不占用特权代理的串行锁。
- 其他任意特权命令走 `dsh-root run <命令>`，需要提供容器 root 密码。`--no-root-password` 会关闭这条通道，此时容器内不存在通往任意 root 命令的路径。
- 防暴力破解：同一 900 秒窗口内累计 5 次失败即锁定，起始 300 秒并按 2 的幂递增至上限 3600 秒；每次失败还会让下一次尝试额外延迟（1 秒起，每次 +500 毫秒，上限 8 秒）。锁定期内即使密码正确也会被拒绝，apt 不受影响。
- 密码哈希位于 `/root/dsh-secret`（0700 root:root，只读挂载）与 `/etc/shadow`，`dsh` 账户无法读取，容器内无法取得哈希做离线破解。

## 启动链完整性与卸载保护

启动链的 9 个路径（入口脚本、Supervisor、特权代理、各包装脚本等）为 root 独占写。卸载保护防的不是提权，而是容器内一条命令拆掉自身运行环境：`apt-get purge -y nginx` 会把反向代理从可写层删除，正在运行的进程靠已删除的 inode 继续存活、健康检查仍然通过，直到下次重启才暴露；这种损坏发生在容器可写层，`docker restart` 无法恢复，只能重建容器。

防护分两层：

- **点名拒绝**：受保护的包为 `nginx`、`nginx-common`、`nginx-core`、`nginx-light`、`nginx-full`、`nginx-extras`、`libnginx-mod-stream`、`ca-certificates`、`openssl`、`passwd`、`adduser`、`mawk`、`util-linux`。带 `:arch` 限定或 `=version` 锁定的写法同样拦截。
- **执行前 `apt -s` 模拟**：解析模拟计划中的 `Remv`/`Purg` 行，拦截「点名一个未受保护的包、由 apt 级联带走运行时依赖」的绕过方式，例如 `apt-get purge -y iproute2`，或先 `apt-mark auto nginx` 再 `apt-get autoremove -y --purge`。命中即整条请求原子拒绝（退出码 126）。

只限制卸载：这些包的安装、重装与查询不受影响，其他包可以自由卸载。名单只覆盖启动链依赖的包，名单外的包被卸载仍可能造成功能不可用，只是不会导致容器无法启动。`upgrade`/`dist-upgrade` 仍可能引入破坏性变更，`autoremove` 仍会摘除真正成为孤儿的依赖。

## 自检

`./dsh.sh verify` 在容器内运行 `verify-dsh-hardening`，共 24 项，覆盖运行 UID、能力集、`no-new-privileges`、特权代理 socket、启动链文件是否 root 独占写（`boot-chain-immutable`）、Supervisor / Nginx 主进程 / 特权代理与 `dsh` 的 UID 分离（`signal-isolation`）、apt 卸载保护是否生效（`apt-removal-guard`）、root 密码状态，以及 `/proc`、`/sys` 与 cgroup 的挂载情况。任一项不合格即以非零码退出。

## 模型密钥代理

`.env` 中 `DSH_MODEL_BROKER=on` 时，安装器叠加 `docker-compose.keys.yml`，额外运行独立容器 `dsh-key-broker`。

- 真实密钥只存在于宿主的 `data/broker/keys.json`（0600，`data/` 已在 `.gitignore` 中）与该容器的内存中。该文件以只读方式挂到 broker 的 `/etc/dsh-broker`，不挂进 DSH 容器；两个容器之间只有 HTTP，没有共享卷。
- DSH 侧 base_url 配成 `http://dsh-key-broker:8080/u/<上游名>`，api key 填任意占位串，容器内不存在真实密钥字面值。版本段（`/v1`、`/v1beta`）属于 `keys.json` 里的上游地址，客户端 SDK 只往后接相对路径，两边都写会变成 `/v1/v1/responses`。安装器按这个格式自己写进 DSH 配置，见下文「写进 DSH 的模型配置」。
- 代理会剥掉客户端送来的全部认证材料（`authorization`、`api-key`、`x-api-key`、`x-goog-api-key`、`cookie` 等）后再注入真实密钥，因此在容器内伪造或覆盖认证头无效。
- 上游主机固定由 `keys.json` 的 `baseUrl` 决定，客户端只能选择上游名与被允许的路径。`baseUrl` 必须是 https，不允许内嵌凭据，也不允许指向环回、私网或链路本地地址。
- 路径前缀白名单：默认只放行常见的 OpenAI / Anthropic / Gemini 兼容端点（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/models` 等），账号管理与文件上传类接口不放行。路径先归一化再判定，`%2e%2e` 之类的穿越写法返回 400。
- 只放行 GET 与 POST，其他方法返回 405。
- 每分钟限速加 UTC 每日配额（`requestsPerMinute` / `dailyRequestBudget`），超出返回 429；在途请求超过 `DSH_BROKER_MAX_CONCURRENT` 返回 503。
- 上游返回状态码 ≥400 时，响应体中的密钥字面值会被替换为 `***redacted***`，避免上游在错误信息里回显密钥。
- 审计日志只记录元数据（时间、上游名、路径、判定、状态码、字节数、耗时），不记录请求体、query 与任何 header 值。
- 探针：`/healthz` 返回 204，`/status` 返回 JSON（上游名、上游主机、配额与今日用量，不含密钥）。
- 容器自身：非 root（UID 1000）、`cap_drop: ALL`、`no-new-privileges`、只读根文件系统、不发布任何宿主端口。

### 配置方式

交互安装按提示逐个输入上游密钥（不回显），并逐个询问 API 形态与固定请求头。自动化用 `--model-keys-file` 指向一份 0600 的 `keys.json`；`--model-key NAME=KEY` 仅供无法交互的流水线使用，写在命令行的密钥会进入 `ps`。上游地址用 `--model-base-url NAME=URL`（deepseek/openai/anthropic 有内置默认值），`--no-model-broker` 关闭代理并清空 `data/broker/keys.json`。也可以直接编辑该文件，broker 每 5 秒重载配置，无需重启容器。

`--model-api NAME=PROFILE`（PowerShell：`-ModelApi`）决定认证头与放行的端点，未指定时按上游名推断：

| PROFILE | 认证头 | 放行端点 | 写进 DSH 的协议 |
| --- | --- | --- | --- |
| `any`（默认） | `authorization: Bearer {key}` | broker 默认前缀集合（chat/completions、responses、embeddings、models 等） | `openai-completions` |
| `responses` | `authorization: Bearer {key}` | 只有 `/v1/responses` 与 `/v1/models`（含去掉 `/v1` 的同名变体） | `openai-responses` |
| `chat` | `authorization: Bearer {key}` | 只有 `/v1/chat/completions` 与 `/v1/models`（含去掉 `/v1` 的同名变体） | `openai-completions` |
| `messages` | `x-api-key: {key}` | 只有 `/v1/messages` 与 `/v1/models`（含去掉 `/v1` 的同名变体），自动带 `anthropic-version` | `anthropic-messages` |
| `gemini` | `x-goog-api-key: {key}` | 只有 `/models` 与 `/v1beta/models` | 仅内置目录路由 |

最后一列是安装器写进 DSH 配置时声明的协议。DSH 的自定义路由只支持前三种，Gemini 协议只存在于内置目录路由上，因此要用 Gemini 模型时上游名必须取 `google`。

`--model-header NAME=HEADER=VALUE`（PowerShell：`-ModelHeader`，可重复）写入 `extraHeaders`，用于上游要求的固定请求头，例如 Codex 那套 `originator` / `version` 与自定义 `User-Agent`：

```
--model-key justwoker=sk-...
--model-base-url justwoker=https://api.justwoker.icu
--model-api justwoker=responses
--model-header justwoker=originator=codex_cli_rs
--model-header justwoker=version=0.101.0
--model-header justwoker=user-agent=codex_cli_rs/0.101.0
```

这些头由 broker 在转发时覆盖客户端同名头，所以容器里的配置改不动它们。认证类头（`authorization`、`api-key`、`x-api-key`、`x-goog-api-key`、`cookie` 等）与逐跳头不允许通过 `--model-header` 设置，否则等于绕过密钥注入。

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

`requestsPerMinute` 与 `dailyRequestBudget` 缺省或为 `0` 表示不限，此时代理只防密钥外泄、不提供额度保护，建议显式设置（例如 `requestsPerMinute: 60`，每日配额按实际用量设定，撞到 429 再调高）。`maxRequestBytes` 缺省为 8 MiB。`headerName` 与 `headerTemplate` 默认是 `authorization` 与 `Bearer {key}`，只有使用其他认证头的上游需要显式设置。`allowedPathPrefixes` 缺省为 broker 内置的前缀集合，显式给出即为只放行这些前缀。客户端侧的 `base_url` 是 `http://dsh-key-broker:8080/u/<上游名>`，不带版本段，api key 填占位串 `dsh-broker-placeholder`。

### 写进 DSH 的模型配置

密钥搬进代理之后，DSH 侧需要的只是「指向代理的 base_url」和「一个占位密钥」，两样都不是秘密。安装器直接按 DSH 官方格式写好，不需要在 WebUI 里手抄：

| 文件 | 写入内容 |
| --- | --- |
| `data/dsh/settings.yaml` | `llm-pi-ai.providers.<上游名>` 的 `baseURL` / `apiKeyEnv`，必要时补 `api` 与 `models`；上游名叫 `deepseek` 时改写 `llm-deepseek.baseURL`；`agent-default-model`（仅在还没设过时） |
| `data/dsh/.credentials.yaml` | `refs.<上游名大写>_API_KEY` = 占位串 `dsh-broker-placeholder`（0600） |

- 凭据引用名与 WebUI 自己派生的一致（上游名大写、非字母数字换成下划线、加 `_API_KEY`），所以之后在页面上改密钥改的是同一个引用。
- `deepseek` 走 DSH 第一方命名空间 `llm-deepseek`（路由 id `deepseek-official`），而不是再建一条同名 `llm-pi-ai` 路由：WebUI 的「模型」页按路由渲染，两条都在就会显示两行 DeepSeek，而默认模型只指其中一行。第一方那条的凭据引用名本来就是 `DEEPSEEK_API_KEY`，模型清单也沿用它内置的那份。旧版安装器写下的重复路由，在下次写配置时会被删掉（只删 `baseURL` 指向本部署代理的那条）。
- 两份文件 DSH 都在热加载，写完刷新页面即可，不重启容器。
- 上游名命中 DSH 内置模型目录（`deepseek`、`openai`、`anthropic`、`google`、`nvidia`、`openrouter`、`groq`、`xai`、`moonshotai` 等）时，协议和整份模型清单由目录提供，安装器只写 `baseURL` 与 `apiKeyEnv`，WebUI 里立刻有一整排可选模型。
- 目录里没有的自建网关必须显式给模型 id：向导会问，非交互用 `--model-id NAME=ID[,ID]`（PowerShell：`-ModelId`）。少了它 DSH 会拒绝整个 `llm-pi-ai` 命名空间，结果是所有供应商一起消失，所以安装器在写入前先用 DSH 自己的校验函数过一遍，不通过就一个字都不写，并在输出里说明原因。
- `baseURL` 与 `apiKeyEnv` 每次重新配置都按当前部署重写（改了地址不重写就会绕开代理）；`api`、`models`、`agent-default-model` 和已经有值的凭据引用只在缺失时补，不覆盖用户在 WebUI 里的选择。
- `--no-model-settings-seed`（PowerShell：`-NoModelSettingsSeed`）关闭这一步，供应商与模型改为在 WebUI 里自行添加。

合并动作在镜像里的 node 中执行（那里才有 yaml 库、DSH 内置模型目录和校验函数），配置经 stdin 传入，因此模型密钥和上游清单都不会出现在 `ps` 里。

### 补填密钥

`./install.sh key-panel`（Windows：`.\install.ps1 -DshAction key-panel`）为已有部署开启密钥管理面板，`--no-key-admin` 关闭它并移除面板容器（`keys.json` 与 `admin.token` 保持原样）。它和 `model-key` 一样只新增旁路容器，不重建 `dsh`。

`./install.sh model-key`（Windows：`.\install.ps1 -DshAction model-key`）为已有部署写入 `data/broker/keys.json`、把 `.env` 的开关翻成 `on`，再启动 `dsh-key-broker` 并核验 `/healthz`。`docker-compose.keys.yml` 只新增 broker 服务、不修改 `dsh` 的定义，因此不重建容器、不丢失 apt 安装的工具链。唯一残留是容器内 skill 文档上的 `DSH_MODEL_BROKER` 仍显示安装时的值（环境变量在容器创建时固定），下次重建容器才会刷新，不影响代理生效。

### 密钥管理面板

`.env` 中 `DSH_KEY_ADMIN=on` 时，安装器再叠加 `docker-compose.keys-admin.yml`，运行独立容器 `dsh-key-admin`：一个只做模型密钥配置的小面板（增删上游、填密钥、选 API 形态、写模型 id、设固定请求头、按上游拉一次模型列表），保存时同时写 `data/broker/keys.json` 与 DSH 的 `settings.yaml`、`.credentials.yaml`。

它填的是「密钥只能在安装向导里填」这个缺口，同时不能变成新的攻击面。面板持有全部真实密钥，所以以下三条边界缺一条它就比 WebUI 直填更糟：

1. **网络**：面板只接入 `dsh-admin` 网络，`dsh` 容器不在其上，跨网桥的流量由 Docker 自己拦掉。安装器在报告成功前会从 `dsh` 容器内执行一次 `net.connect(8090, 'dsh-key-admin')`，这次连接必须失败，否则安装失败。容器自检里的 `key-admin-unreachable` 做同一件事，且不看面板有没有开——面板关着时这里通常是 DNS 解析失败，同样算通过。
2. **发布地址**：宿主端口默认只发布在 `127.0.0.1:3082`。发布到 `0.0.0.0` 时 `dsh` 容器能经宿主网关回连这个端口，第 1 条就被绕开了，因此非回环绑定会给出警告，远程访问应当走 SSH 隧道。
3. **鉴权**：除 `/healthz` 与静态资源外，所有 `/api` 都要 Bearer 令牌。令牌是 192 bit 随机值，写 `data/broker/admin.token`（0600），不进 `.env`；比较走定长摘要，连续失败触发与容器 root 口令同一套递增延迟与锁定。

面板自身的收敛与 broker 一致：非 root（1000:1000）、`cap_drop: ALL`、`no-new-privileges`、只读根文件系统、`pids_limit`，可写范围只有 `data/broker` 与 `data/dsh` 两个挂载。另外两点值得单独说明：

- 服务代码从工程目录的 `./bin` 只读挂载进容器，不打进镜像，所以老部署开面板不需要重建镜像。
- 写 DSH 配置前会 `lstat` 目标文件，`settings.yaml` 或 `.credentials.yaml` 是符号链接或目录时拒绝写入。`dsh` 容器对 `data/dsh` 有写权限，没有这道检查的话它可以把这两个路径换成指向别处的符号链接，诱导面板把 `keys.json` 的内容写进 Agent 能读的位置。这种情况只按「写 DSH 配置失败」处理，不影响密钥本身保存。
- 空的 `upstreams` 是合法状态：面板要能从零开始，所以安装时可以先不填密钥。这期间 broker 对每个 `/u/` 请求返回 503。

### 边界

代理保证的是**密钥字面值不进入 DSH 容器**，密钥不会被复制出去或在别处复用。它不保护额度，也不保护数据：被注入的 Agent 仍然可以借它消耗额度，并把容器内的数据作为 prompt 发往上游。代理也不对客户端做认证，凡是能连上 `dsh-internal` 网络的进程都能通过它发请求——放进 DSH 容器的任何 broker 凭据同样会被读出，因此增加客户端认证没有实际收益。可用的缓解手段是配额限制损失上限，出站白名单限制数据能送往哪里。

## 出站模式

`.env` 中的 `DSH_EGRESS_MODE` 决定容器如何出网。

**open（默认）**：容器像普通 Docker 容器一样直连公网。配置简单，但被注入的 Agent 可以把数据 POST 到任意地址，也可以绕开密钥代理直连模型厂商。

**allowlist**：安装器叠加 `docker-compose.isolated.yml`，容器出网必须经过独立的 `dsh-egress` 正向代理（监听 3128），按域名白名单放行。网络拓扑：

```text
宿主 3080 ──► dsh-ingress ──► dsh-app:3080      Nginx 四层转发，隔离模式下唯一发布端口的容器
                    dsh ──► dsh-egress ──► 公网   域名白名单，HTTP 仅 80/443，CONNECT 仅 443
                    dsh ──► dsh-key-broker ──► 模型上游
```

此时 dsh 容器只接入 `dsh-internal`（`internal: true`，没有默认网关），直连外网不是被拒绝，而是没有路由。

- 内置白名单 15 个域名：`deb.debian.org`、`security.debian.org`、`registry.npmjs.org`、`pypi.org`、`files.pythonhosted.org`、`github.com`、`api.github.com`、`codeload.github.com`、`objects.githubusercontent.com`、`raw.githubusercontent.com`、`github-releases.githubusercontent.com`、`pkg-containers.githubusercontent.com`、`ghcr.io`、`astral.sh`、`nodejs.org`。
- 默认拒绝绕过域名判定的写法：IP 字面量（含 `127.0.0.1`、`169.254.169.254`、10/8、172.16/12、192.168/16、`::1`、`fd00::/8`）、`localhost` 与 `.internal`/`.local`/`.localdomain`/`.localhost` 后缀、整数或十六进制形式的地址（`2130706433`、`0x7f000001`）、带凭据的 URL、非 http(s) scheme，以及 CONNECT 到 443 以外的端口。逐跳头在转发时剥除；代理不做 TLS 中间人，容器内证书链保持原样。
- DNS rebinding 防护：建连之前校验 DNS 解析结果，只允许公网单播地址，解析到环回、私网、链路本地（含云 metadata 的 `169.254.169.254`）、CGNAT 或 IPv4 映射的私网地址返回 403。可用 `DSH_EGRESS_ALLOW_PRIVATE_UPSTREAM=1` 关闭，仅在白名单中确实包含同网段内网镜像源时才应关闭，关闭后一个受控的白名单域名即可让代理成为访问宿主与内网的通道。
- 放行新域名：在宿主的 `.env` 写 `DSH_EGRESS_ALLOWED_HOSTS`（逗号分隔，支持 `*.example.com` 形式的最左一级通配，不匹配裸域名），然后重启容器；安装时可用 `--egress open|allowlist` 与 `--egress-allow HOSTS` 指定。默认追加在内置白名单之后，内置软件源保持放行；写 `DSH_EGRESS_ALLOWED_HOSTS_MODE=replace` 才整体替换，此时仍需要的域名要写全。容器内无法修改白名单。
- 影响范围：白名单外的域名对 apt / pip / npm / git 与 Agent 的网页抓取、搜索接口一律返回 403，需要哪些域名就显式列出。模型请求不经过 `dsh-egress`，由 `dsh-key-broker` 直接出网，因此不受白名单限制。
- 入口使用四层转发：`dsh-ingress` 用 Nginx `stream` 模块做 TCP 转发，不解析 HTTP、不改 Host、不加 `X-Forwarded-*`，Basic Auth 与同源、凭据边界仍由 dsh 容器内的 Nginx 负责。其 `proxy_pass` 使用变量形式，每条新连接都走 Docker 内嵌 DNS，因此 dsh 容器重启换 IP 后自动跟上。
- 上游写 `dsh-app:3080` 而不是 `dsh:3080`：`dsh-ingress` 在 `dsh-private` 网络上持有 network alias `dsh`（使把上游写成 `http://dsh:3080` 的反代无需改配置），而 Docker 内嵌 DNS 会把查询方自身的 alias 计入解析结果，导致 ingress 解析 `dsh` 时指向自己并自连失败。`docker-compose.isolated.yml` 因此给 dsh 服务在 `dsh-internal` 上另挂专用别名 `dsh-app`。
- 容器内的包管理器配置：`bin/entrypoint.sh` 在隔离模式下写 `/etc/apt/apt.conf.d/00-dsh-proxy`、`/etc/pip.conf`、npm 的 globalconfig 和 `git config --system http.proxy`，并设置 `NODE_USE_ENV_PROXY=1`（Node 24 的 `--use-env-proxy`；undici/fetch 默认不读代理环境变量）。这些文件是必需的：这些工具对代理环境变量的支持不完整，apt 在特权代理中还会被清理环境。只有带 `dsh-docker managed` 标记的文件会被改写或回收，用户自建配置会被保留并提示；切回 open 模式时这些文件会被删除。
- 运维命令：`./dsh.sh egress` 打印代理的 `/status`（白名单条数、允许端口、解析结果校验是否开启、活跃连接数、放行与拒绝计数）。

旁路容器的加固一致：

| 容器 | 运行身份 | 加固 | 宿主端口 | 挂载 | 职责 |
| --- | --- | --- | --- | --- | --- |
| `dsh` | PID 1 为 root；DSH、Agent 会话与 Nginx worker 为 1000:1000 | `cap_drop: ALL` + 7 项能力、`no-new-privileges`、可写系统层 | open 模式发布 3080，隔离模式不发布 | `/data`、`/workspace` 等绑定挂载 | DSH 本体与 Agent |
| `dsh-key-broker` | 1000:1000 | `cap_drop: ALL`、`no-new-privileges`、`read_only` 根文件系统 + 16 MB `/tmp` tmpfs | 不发布 | 只读挂载 `data/broker` | 注入模型密钥、限速与配额 |
| `dsh-egress` | 1000:1000 | 同上 | 不发布 | 无 | 出站域名白名单正向代理 |
| `dsh-ingress` | 1000:1000 | 同上 | 隔离模式发布 3080（默认绑 `127.0.0.1`） | 无 | 四层转发到 `dsh-app:3080` |

## user namespace remap

前面各层限制的是容器内能做什么。remap 解决的是另一个问题：把容器 root 与宿主 root 分开。宿主开启 user namespace remap 后，容器内的 UID 0 在宿主上只是一个普通的 subuid，内核或运行时漏洞导致逃逸时，落到宿主上的身份是该普通用户而不是 root。

开启方法（Linux 宿主，编辑 `/etc/docker/daemon.json`，随后 `sudo systemctl restart docker`）：

```json
{
  "userns-remap": "default"
}
```

取舍：

- 这是 **daemon 级**开关，影响宿主上的所有容器。已有容器需要重建，属主也要重新对齐。
- 绑定挂载的属主需要对齐：容器内的 1000 对应宿主上 `dockremap` 的 subuid 区间（常见为 `165536 + 1000 = 166536`），未对齐时容器无法写入 `/data`。启用后容器内也无法修改这些目录的属主，`bin/entrypoint.sh` 检测到此情况会打印需要在宿主执行的 `chown`。
- `install.sh --userns-preflight`（Linux）做预检：检测是否已启用、读取宿主的 subuid 区间、计算偏移并对齐绑定挂载属主。它不会自动修改 `/etc/docker/daemon.json`，该文件属于宿主级配置，需要管理员自行修改并重启 Docker。
- **Docker Desktop / WSL2 后端不支持**：该后端的 `docker run --userns` 只接受 `host`，因此这一层只对 Linux 宿主有意义。
- 容器内可通过 `/proc/self/uid_map` 判断当前状态：恒等映射 `0 0 4294967295` 表示未启用，`bin/entrypoint.sh` 据此把 `DSH_USERNS_REMAP` 判为 `false`。

### 备选：rootless Docker

Linux 上还有一条比 `userns-remap` 更强的路径：rootless Docker，整个 daemon 运行在普通用户下，被攻破时的起点更低。代价更大，因此只作为备选：

- 小于 1024 的端口无法直接绑定，需要调整 `net.ipv4.ip_unprivileged_port_start` 或在前面加一层宿主转发。DSH 默认使用 3080，但同机的 80/443 反代会受影响。
- 网络走 RootlessKit / slirp4netns 等用户态实现，吞吐与源 IP 保留上有取舍；部分存储与网络驱动不可用或需要较新内核。
- cgroup 资源限制需要 cgroup v2 加 systemd 委派才完整，否则 `pids_limit` 等约束可能不生效。

## 已知限制

- **共享内核**：容器与宿主共用内核，Dirty Pipe、runC 一类内核与运行时漏洞无法在容器内加固层面拦住，只能升级宿主内核与 Docker；user namespace remap 只降低逃逸的影响面，不消除逃逸本身。
- **免密 apt**：默认 `DSH_PRIVILEGED_APT=nopasswd`，容器内可以通过白名单代理成为容器 root。这是「Agent 能自行安装软件」与「容器内不可提权」之间的取舍，收紧方式是 `DSH_PRIVILEGED_APT=password`，代价是每次安装都需要人工输入密码。
- **卸载保护是按包名的白名单**：只覆盖启动链依赖的包，名单外的包被卸载仍可能导致功能不可用。级联绕过依靠执行前的 `apt -s` 模拟拦截，模拟与真实执行之间理论上存在时间差。
- **密钥代理不保护额度与数据**：只保证密钥字面值不出容器，被注入的 Agent 仍可消耗额度并把数据发往上游，只能用限速与配额压低上限。
- **密钥代理不对客户端做认证**：能连上 `dsh-internal` 的进程都能通过它发请求。
- **出站白名单只按域名判定**：已包含 DNS 解析结果校验，但代理不做 TLS 中间人，放行域名下的任意路径都可访问；例如放行 `github.com` 也就放行了向它上传内容的接口。
- **真正的第一道防线是不把不可信内容交给 Agent**：以上各层只缩小注入成功后的后果。

## 其他实现说明

- **内置控制插件**：镜像自带 `dsh-docker-control`，首次启动空 profile 时自动恢复，在设置窗口左侧导航新增“DSH 环境”页。
- **WebUI 与反代稳定性**：配置编辑器使用独立 portal 与固定高度滚动区域，避免设置页闪烁与输入框高度跳动；内置 WebSocket keepalive 补丁降低空闲反代断开导致的 UI 假死。
- **认证转发语义**：通过公网域名访问时，容器 Nginx 只在请求已通过内置 Basic Auth 或可信外层认证后，才转为 DSH 的内部回环访问。`DSH_TRUSTED_HOSTS` 只校验浏览器 authority，不等同于登录认证，也不会自动打开插件的远程设置写权限。
- **插件与工具链**：插件安装、会话管理与 MCP 部署所需的 `/data` 写权限已纳入沙箱。apt 安装的软件写入标准 Debian 路径并持久化在容器可写层；Python/Node 工具链分别位于 `/data/home/.local` 与 `/data/home/.npm-global`。容器启动时根据实际系统、架构与权限变量渲染 `container-environment` skill。
