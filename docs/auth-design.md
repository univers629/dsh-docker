# DSH 多用户认证与实例编排系统 · 策划书 v3

本文是整个项目的权威策划书（取代 v2），覆盖：总体架构、鉴权体系、安全设计（含
威胁模型与漏洞缓解对照）、多用户隔离与实例编排、安装器引导（一键/自定义两条路
线）、页面清单、实现里程碑、验收与测试策略、风险边界。实现以此文档为准。

需求基线（用户拍板记录）：

| 项 | 决定 |
| --- | --- |
| 登录页 | 左「大图标+两行官方文字」/ 右表单；整页星空背景；深浅色；GitHub 徽标（原型已定稿，http://127.0.0.1:8787/） |
| 鉴权体系 | 借鉴 KPanel：Argon2id 密码 + TOTP+恢复码 + Passkey + 改密撤销会话；吸收 new-api 的 auth_version / auth_flows / 2FA 独立锁 / 审计内聚 |
| 多用户 | 开放注册；仅初始管理员（root）可配模型 API 与管理设置；普通用户会话与文件完全隔离 |
| 隔离方式 | 路线 B：每用户一个 DSH 容器实例（可信隔离）；创建用户时整树 chown 给该实例身份 |
| 资源 | 每实例内存上限 200MB；闲置自动停（默认 30 分钟，可配）；负载过高时动态调整 |
| 多用户模式入口 | **仅自定义安装向导可选**；一键安装保持单管理员模式（默认不开注册） |
| 视觉 | deepseek.com 风格（只借鉴配色/材质，自绘素材，不用官方资产） |
| 单管理员安全底线 | dsh-auth 不弱于 nginx basic auth：存储更强（Argon2id）、传输更少（密码只 POST 一次）、爆破更贵（双桶锁）、可审计可撤销 |

## 1. 系统总览

新增三个组件（全部部署层，DSH 核心零改动）：

```
浏览器 ─ nginx:3080 ─┬─ auth_request → dsh-auth（认证网关+登录/注册页）
                     ├─ root  → dsh-admin 实例（管理员工作台 + 管理面板）
                     └─ user N → dsh-uN 实例（每用户独立容器+数据目录）

dsh-auth ──调用──> dsh-instances（唯一挂 docker.sock，实例生命周期管理器）
dsh-admin / dsh-uN ──模型请求──> dsh-key-broker（真实密钥仅此处，root 经 key-admin 面板配置）
```

| 组件 | 形态 | 职责 |
| --- | --- | --- |
| dsh-auth | Node ESM `bin/dsh-auth.mjs`，无构建 | 用户注册/登录/TOTP/Passkey/改密；会话签发与 auth_request 校验；按角色路由；管理面板静态页（用户管理/审计/实例状态） |
| dsh-instances | Node ESM `bin/dsh-instances.mjs` | 唯一持有 docker.sock；按模板创建/启停/删除用户实例；闲置回收；负载感知动态调整；磁盘配额 |
| 用户实例 | compose 模板实例化的 DSH 容器 | 与现 dsh 容器同规格：非 root、cap_drop ALL；数据目录独立且 chown 给该实例身份 |

网络划分：`dsh-private`（nginx↔auth↔管理员工作台 dsh-admin）；`dsh-instances-net`（用户实例↔入口↔密钥代理，与管理员/网关物理隔离）；`dsh-mgmt`（auth↔instances，仅两者）；
key-broker 网络不变。**docker.sock 只出现在 dsh-instances。**

### 模式矩阵

| 部署模式 | 认证 | 组件 | 注册 |
| --- | --- | --- | --- |
| 一键安装（默认/`--quick`/curl|bash 无 TTY） | dsh-auth password 模式（单管理员，最小面） | dsh 容器 + dsh-auth | 关闭（/register 404） |
| 自定义-单管理员 | basic / local / trusted-proxy / password 任选 | 按所选模式，选 password 才部署 dsh-auth | 关闭 |
| 自定义-多用户 | password（强制） | dsh-admin + dsh-auth + dsh-instances | 开放（可选邀请码） |

## 2. 鉴权体系（借鉴落点，逐条锚定出处）

### 2.1 密码
- Argon2id（`@noble/hashes`）：m=64MiB、t=3、p=min(CPU,4)、盐 16B、密钥 32B；编码
  `$argon2id$v=19$m=65536,t=3,p=N$salt$key`。
- 强度：12–256 字节、至少一字母一数字（KPanel validatePassword 同款）。
- 登录防枚举：用户不存在时仍跑一次 dummy hash 比对（KPanel dummyHash 同款），
  响应时间与存在用户一致。

### 2.2 会话与失效
- 不透明 token（32B），只存 SHA-256 哈希；HttpOnly + SameSite=Strict + Secure cookie。
- CSRF token 同法；管理写操作与状态变更接口校验 `X-CSRF-Token`。
- **auth_version 级联失效**（new-api 同款）：用户行存 auth_version；会话签发时记录当时值；
  改密/关 2FA/停用用户/passkey 变更 → auth_version++ → 该用户全部会话立即失效，无需遍历。
- 会话绝对上限时长（默认 7 天）+ 滑动过期（默认 24h 无活动过期，均可配）。

### 2.3 TOTP + 恢复码（KPanel 逻辑 + new-api 持久化）
- 6 位 / 30s / ±1 步 / HMAC-SHA1 / 密钥 20B base32；otpauth URI issuer=DSH。
- 密钥 AES-256-GCM 加密落盘（主密钥 32B，0600，AAD=`dsh-totp-v1`）。
- 恢复码 10 个 `XXXXX-XXXXX-XXXXX`（A-Z2-7），只存 SHA-256 哈希；消费即焚。
- 开通流程走 **auth_flows 表**（见 2.5）：start（验当前密码）→ confirm（验码、记已用
  时间步防重放）→ 一次性返回恢复码。
- **2FA 独立锁定**（new-api TwoFA 同款）：每用户 FailedAttempts + LockedUntil 持久化，
  与密码锁（IP+账户双桶）互不干扰；passkey 登录不喂密码锁（防恶意锁死管理员）。

### 2.4 Passkey / WebAuthn（KPanel 同款策略）
- `@simplewebauthn/server`；固定 HTTPS origin + RPID 校验（域名合法、非 IP、含点）。
- residentKey + userVerification = required；ceremony 3 分钟、单次消费。
- passkey 通过后若开了 TOTP 仍需第二因子。计数器回退拒绝。
- 本地 http 部署（127.0.0.1/内网 IP）passkey 入口自动隐藏（origin 校验失败即不渲染）。

### 2.5 auth_flows 通用一次性凭据（new-api 模式）
- 表：purpose(totp_setup|passkey_register|passkey_login|step_up) + token HMAC 哈希 +
  user_id + payload + expires_at + consumed_at；单次消费、过期清理。
- 作用：所有多步仪式（TOTP 开通、passkey 绑定/登录、敏感操作 step-up）统一持久化，
  重启不丢、防重放。

### 2.6 注册（仅多用户模式）
- `/register`：用户名 + 密码（+确认）+ 可选邀请码；角色恒为 user；建账户即分配数据目录
  与实例身份（uid 从 100000 段递增）。
- 邀请码门槛（配置项，默认关）；注册成功即审计。用户名规则同 KPanel
  `^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$`。
- 单管理员模式：/register 返回 404，注册代码路径不注册（路由表裁剪，见 §3.1）。

### 2.7 角色与守卫
- root：初始管理员（bootstrap/一键凭据创建）；独占——密钥面板、用户管理、审计、
  实例管理、系统设置页。
- user：仅自己的实例与管理自己的 2FA/passkey/会话。
- 守卫：最后一个 root 的停用/降级/删除必须拒绝（new-api DeleteUser 同款）；
  root 不可由 user 修改。

### 2.8 审计（new-api 审计内聚同款）
- 事件：注册、登录成功/失败、2FA 开关、passkey 增删、改密、用户管理操作、实例
  创建/停用/删除、水位模式切换。
- 记录 actor_id、action、ip、result、change（元数据）；**永不**记录密码/验证码/恢复码/
  token（new-api 审计红线同款）。
- 审计写入内聚在管理写操作鉴权中间件：路由层无法漏挂。
- 管理面板审计页仅 root 可见；审计文件自身 0600、属主 dsh-auth。

## 3. 安全设计（威胁模型 + 漏洞缓解对照）

### 3.1 攻击面收敛原则
- 单管理员模式部署 **路由裁剪版** dsh-auth：不注册 /register、/admin/*、实例编排相关
  端点；代码路径与依赖不变，路由表按模式生成。攻击面 = 登录 + verify + /account。
- 所有 dsh-auth/dsh-instances 端点默认拒绝；未列名路由 404。
- 静态资源（登录页）与 API 同源，无第三方资源引入（图标/字体自绘内联）。

### 3.2 威胁模型与缓解对照表

| # | 威胁 | 缓解 |
| --- | --- | --- |
| T1 | 登录爆破（在线撞库） | Argon2id 64MB/次（单次尝试成本抬高）；IP+账户双桶限速（窗口内 N 次失败锁定）；登录失败审计 |
| T2 | 用户枚举（响应差异/时序） | dummy hash 恒时比对；登录/注册错误文案统一；注册仅邀请码模式下泄露「码无效」不区分「码过期」 |
| T3 | 会话窃取（XSS/网络） | HttpOnly+Secure+SameSite=Strict；全程 HTTPS 前置（部署边界）；session token 仅哈希落盘 |
| T4 | CSRF | SameSite=Strict + 写操作 X-CSRF-Token 双保险；auth_request 校验只读不改状态 |
| T5 | TOTP 暴力（6 位空间小） | 2FA 独立锁定（失败 N 次锁 M 分钟）；已用时间步防重放；±1 步窗口防时钟漂移 |
| T6 | 恢复码穷举 | 30 字符空间 + 哈希存储 + 与 TOTP 共享 2FA 锁定预算 |
| T7 | WebAuthn 伪造/重放 | challenge 单次消费（auth_flows）；origin+RPID 固定校验；计数器回退拒绝 |
| T8 | 密码离线破解（盗走状态文件） | Argon2id 64MB 参数；状态文件 0600 + 宿主属主 root；TOTP 密钥 AES-GCM 加密（盗文件还需主密钥） |
| T9 | 越权访问他人实例（多用户） | 容器边界 + 每 uid 数据树 + nginx 按会话身份路由（伪造 cookie 需破 SHA-256 原像） |
| T10 | Agent 逃逸/横向 | 既有模型不变：cap_drop ALL、非 root、无 socket、userns-remap 建议；用户实例间无共享卷 |
| T11 | docker.sock 攻击面（dsh-instances） | 唯一挂载者；不含用户数据；不跑 Agent；仅 dsh-mgmt 内网受 dsh-auth 调用；命令白名单（只允许实例模板相关 API 调用）；调用方固定 token 鉴权 |
| T12 | dsh-auth RCE（Node 服务自身漏洞） | 无 eval/动态 require；JSON body 白名单字段 + 严格类型校验；请求体上限 64KB；非 root 运行 + 只读根文件系统（状态文件挂载除外） |
| T13 | 登录页资源耗尽（DoS） | Argon2id 并发信号量（KPanel hashSlots 同款）；登录/注册接口独立限速；nginx 层兜底 limit_req |
| T14 | 审计/状态文件篡改（容器内 root） | 状态文件挂载在宿主 data/auth，属主 root，dsh-auth 以 uid 1000 只写（追加语义由原子重写实现）；容器内 Agent 无法触碰 dsh-auth 容器 |
| T15 | 时序侧信道 | 恒时比较（subtle/timingSafeEqual）用于密码、TOTP、恢复码、auth_flow token 全部比对 |

### 3.3 与 nginx basic auth 的安全性论证（已向用户交底）
- 存储更强（Argon2id vs bcrypt(htpasswd)）；传输更少（密码仅登录时 POST 一次 vs 每请求
  base64 重发）；爆破更贵（双桶锁 + Argon2 单次成本）；新增 2FA/Passkey/审计/秒级撤销。
- 代价：约 2-3k 行自研代码 = 新攻击面。缓解：逐条锚定 KPanel/new-api 已验证实现，
  不自创密码学流程；单管理员模式路由裁剪；basic 模式保留为最小面选项。

### 3.4 密钥与敏感文件清单

| 文件 | 权限 | 属主 | 内容 |
| --- | --- | --- | --- |
| data/auth/state.json | 0600 | root(宿主) | users/sessions/auth_flows/audit/setup（含 Argon2id 哈希、AES-GCM 密文） |
| data/auth/totp.key | 0600 | root | TOTP 主密钥 32B |
| data/auth/instances.token | 0600 | root | dsh-auth→dsh-instances 调用 token |
| data/users/<uid>/ | 0750 | 100000+uid | 用户数据树（各实例内该 uid 可写） |
| data/broker/keys.json | 0600（不变） | root | 模型密钥（仅 broker） |

### 3.5 安全验证（测试即证据，见 §8）
每个 T# 对应至少一条自动化测试（爆破锁定、枚举恒时、CSRF 拒绝、重放拒绝、越权 403、
sock 白名单外的命令拒绝等）。OWASP ASVS 对照以 KPanel/new-api 同源要求执行。

## 4. 多用户隔离与实例编排

### 4.1 数据布局

```
data/
  users/<uid>/
    home/        DSH_HOME：sessions、profiles、settings.yaml（系统生成，只读挂载）
    workspace/   工作目录
    dsh/         DSH 侧模型配置（指向 broker 的占位密钥），只读
  auth/          dsh-auth 状态库
  broker/        key-broker 密钥（不变，root 经 key-admin 管理）
```

- 创建用户时 `data/users/<uid>` 整树 chown 给该实例身份（uid 100000+）——属主隔离在
  容器边界内字面成立：容器内进程以该身份跑，其他用户容器既无法以该 uid 访问，也被
  容器边界挡住。
- 用户实例的 settings.yaml 由 dsh-instances 生成：providers 指向
  `http://dsh-key-broker:8080/u/*` + 占位密钥；root 属主 + 只读挂载 → 普通用户在 DSH
  的「模型设置」里保存失败。真实密钥永远只在 broker。

### 4.2 实例生命周期（dsh-instances）

| 状态 | 动作 |
| --- | --- |
| 不存在 | 注册时仅建目录与身份（不建容器）；首次登录时按模板创建并启动 |
| 运行 | 正常服务；每实例 mem_limit=200MB、Node `--max-old-space-size=160`、pids_limit=256 |
| 闲置 | 无请求超过 idle_timeout（默认 30 分钟，可配）→ docker stop（数据保留，RSS 归零） |
| 唤醒 | 登录/请求到达已停实例 → 拉起（10–30 秒，登录页显示等待态；超时 60s 给重试提示） |
| 停用 | 管理员停用用户 → stop + 拒绝登录；启用 → 允许登录 |
| 删除 | 二次确认 → stop + 删容器 + 删 data/users/<uid>（可选保留 workspace 归档 7 天） |

后台任务保护：实例内有运行中 Agent 会话/后台 job 时**不**闲置停（busy 探针；探针失败
按 busy 处理，宁可不停不可误杀）。

### 4.3 负载感知动态调整（水位决策环，每 30s）

```
  在线实例数 × 200MB 与宿主可用内存对比
  - 水位 < 70%：正常；唤醒立即执行
  - 70% ≤ 水位 < 90%：收缩——idle_timeout 降为 5min；唤醒排队（上限 8，超时 503「系统繁忙」）
  - 水位 ≥ 90% 或 OOM 前兆（cgroup memory.events）：紧急——停最久未活跃实例（跳过 busy）；
    暂停唤醒
  - 水位回落 < 60%：恢复
```

磁盘配额：每用户默认 5GB（可配），du 周期统计；超限只读告警，不硬杀会话。

### 4.4 路由
- nginx 按 dsh-auth 校验后的会话身份（auth_request 响应头）反向代理到对应实例
  （dsh-private 网络别名 dsh-uN:3081；root → dsh-admin:3081）。
- 每实例宿主不发布端口；管理面板 /admin/* 仅 root 会话可达。

### 4.5 资源账（OCI ARM 12GB 实测口径）

| 项 | 值 |
| --- | --- |
| 系统 + docker + nginx/auth/broker/instances | ≈ 1.5GB |
| 每在线实例 | ≤ 200MB（硬上限） |
| 同时在线上限（默认水位策略） | 收缩触发前约 20–25 人 |
| 闲置用户 | 0 内存，仅磁盘 |
| 注册总数 | 无上限（磁盘配额约束） |

## 5. 安装器引导设计（一键 / 自定义两条路线）

### 5.1 一键安装（--quick / curl|bash 无 TTY，零提问）
固定流程：拉镜像 → 部署 dsh-auth（password 模式·单管理员·路由裁剪）→ 生成 root 随机
凭据 → 启动 → 末尾打印（沿用现行 print_quick_summary：访问地址 / root 凭据「只显示
这一次」/ 找回方式）。**不问任何多用户问题。**

### 5.2 自定义向导（交互式）

```
…（镜像来源、访问保护方式问答不变）…

[新增·仅当访问模式 = password 时出现]
用户模式：
 1) 单管理员（默认）—— 一套 root 凭据，无注册页，与现行为一致
 2) 多用户 —— 开放注册；会话与文件按用户隔离（每用户独立 DSH 实例，
    200MB 上限 + 闲置自动停 + 负载动态调整）
→ 选 1：跳到收尾（root 随机凭据同现行）
→ 选 2：追问三问（全部带默认值，回车即默认）：
    a. 注册门槛：开放注册（默认）/ 需要邀请码
       （邀请码则生成初始码并打印一次）
    b. 闲置停用阈值：30 分钟（默认）/ 15 / 60 / 从不
    c. 每用户磁盘配额：5GB（默认）/ 2 / 10 / 无限制
    （内存上限 200MB 与水位策略内置，不问）

[访问模式为 basic/local/trusted-proxy 时]
不出现用户模式问答（互斥已述），行为与现状一致。
```

### 5.3 参数与状态
- 旗标：`--multi-user` / `--no-multi-user`、`--register-gate=open|invite`、
  `--idle-timeout=SECONDS`、`--user-disk-quota=GB`（自动化路径）。
- `.env`：`DSH_MULTI_USER=on|off`、`DSH_REGISTER_GATE=open|invite`、
  `DSH_IDLE_TIMEOUT_SECONDS`、`DSH_USER_DISK_QUOTA_BYTES`（重跑向导默认取现值）。
  部署模式与注册门槛在服务启动时按 `.env` 同步进状态库（见 §10.3）。
- 访问保护方式新增 `password`：认证由 dsh-auth 网关承担，容器内 Nginx 关闭 Basic Auth。
  多用户模式强制使用它。
- 多用户模式部署动作：叠加 `docker-compose.multiuser.yml`（dsh-auth + dsh-instances +
  dsh-ingress）、生成 auth 状态库种子（root = 随机初始密码，回显一次）+ TOTP 主密钥
  + instances token + uid 段初始化。
- dsh.sh 子命令：`users`（列实例状态）、`start-user`、`stop-user`（尚未实施，见 §10.4）。

### 5.4 升级与兼容
- 单管理员（任何访问模式）↔ 多用户互转：重跑向导改选即可。
  - 单 → 多：现有 dsh 容器转正为 dsh-admin 实例，root 数据原地保留；新用户走注册。
  - 多 → 单：提示「将停用全部用户实例与数据（可选归档）」，二次确认后执行；root 不动。
- basic/local/trusted-proxy 照旧可用（不部署 dsh-auth）。

## 6. 页面清单（dsh-auth 静态服务，沿用登录页视觉语言）

| 页 | 路由 | 可见性 | 状态 |
| --- | --- | --- | --- |
| 登录 | /login | 所有人 | 原型已定稿（左大图标+两行官方文字/右表单/星空/深浅色/GitHub 徽标） |
| 注册 | /register | 多用户模式 | 与登录同壳：用户名/密码/确认/邀请码（如启用） |
| 实例唤醒等待 | 登录流程内嵌 | 停实例唤醒时 | 进度态 + 60s 超时提示 |
| 账户安全 | /account | 登录用户 | 改密/TOTP/passkey/本人会话管理 |
| 用户管理 | /admin/users | root | 列表/创建/停用/删除/重置密码 |
| 审计 | /admin/audit | root | 时间线 + 过滤 |
| 实例状态 | /admin/instances | root | 在线/停止/内存水位/磁盘用量 |

## 7. 实现里程碑（每项带验收路径）

| # | 内容 | 验收 |
| --- | --- | --- |
| M1 | 认证核心：状态库(JSON 原子写)、密码登录、session+CSRF、auth_version、双桶限速、audit 骨架、登录页收编、auth_request verify | 浏览器登录→auth_request 放行/拒绝；错误凭据锁定生效 |
| M2 | 凭据三件套：TOTP+恢复码、passkey、改密（auth_flows 全程）+ /account 页 | 开通 TOTP→恢复码一次性显示→改密后全部会话失效；passkey 注册/登录 |
| M3 | 多用户编排：dsh-instances（模板/chown/启停/闲置/水位/busy 探针）、/register、唤醒等待页 | 注册→首登实例拉起→闲置停→再登唤醒；水位收缩/紧急模式演练 |
| M4 | 管理面板：/admin/users、audit、instances + key-admin root 拦截 | root 全功能；user 访问 /admin/* 全部 403 |
| M5 | 安装器与收尾：向导分支、compose.multiuser.yml、dsh.sh 子命令、README/docs 双语、smoke 测试 | 一键=单管理员零提问；自定义选 2 三问成流；install-* 全套回归绿 |

## 8. 测试与验收策略
- 单元：密码哈希/校验、TOTP 步进与防重放、恢复码、auth_flows 消费、限速桶、水位决策
  （纯函数表驱动）。
- 集成（Node 冒烟，对齐现有 tests/install-*-smoke.mjs 模式）：auth_request 放行/拒绝/
  锁定；CSRF 拒绝；越权 403；实例生命周期（fake docker CLI）；sock 白名单外命令拒绝。
- 安全对照：§3.2 每个 T# 至少一条自动化测试（§3.5）。
- 安装器回归：既有 install-wizard/empty-dir/sudo-env/upgrade/quick 五套 + 新增
  multiuser 向导 smoke。

## 9. 风险与诚实边界
- 200MB 上限对重会话（长上下文+多工具并发）可能 OOM 重启：数据不丢、会话中断体验
  在所难免；水位策略优先停闲置者缓解。
- 唤醒 10–30 秒是 docker start + Node 启动物理时间；等待页缓解。
- docker.sock 受控例外（T11）：路线 B 固有代价，已在威胁模型登记并四重收敛。
- dsh-auth 为自研组件：攻击面大于内建 basic，安全论证见 §3.3；缓解为成熟实现移植
  + 路由裁剪 + 每威胁自动化测试。
- 多用户模式与 basic/local/trusted-proxy 互斥（认证只能有一个来源）。

## 10. 实现状态

### 10.1 已交付

| 里程碑 | 交付物 | 验证方式 |
| --- | --- | --- |
| M1 认证核心 | `bin/dsh-auth-policy.mjs`（Argon2id、强度、恒时比较、双桶限速、IP 与同源解析）、`bin/dsh-auth-store.mjs`（原子状态库、TOTP 主密钥）、`bin/dsh-auth.mjs`（登录/会话/CSRF/auth_version/审计/路由裁剪）、`bin/dsh-auth-web/` | `dsh-auth-policy-smoke`、`dsh-auth-integration-smoke`；并在目标镜像 `node:24-trixie-slim` 容器内实测登录往返 |
| M2 凭据 | TOTP 与恢复码、Passkey（`bin/dsh-auth-passkey.mjs`，`@simplewebauthn/server`）、改密级联失效 | `dsh-auth-policy-smoke`（含 RFC 6238 官方向量）、`dsh-auth-passkey-smoke`（合成认证器真实 ES256 验签）、`dsh-auth-integration-smoke` |
| M3 多用户 | `bin/dsh-instances-policy.mjs`、`bin/dsh-instances.mjs`（唯一持 socket 者）、注册与邀请码、实例唤起与就绪轮询 | `dsh-instances-policy-smoke`、`dsh-instances-smoke`（假 docker）、`dsh-auth-multiuser-smoke` |
| M4 管理面板 | `/api/admin/*`（用户、审计、实例、邀请码；含最后管理员与自助操作守卫）、`bin/dsh-auth-web/admin.html` | `dsh-auth-multiuser-smoke` |
| M5 部署接线 | `nginx/dsh-multiuser.conf`、`docker-compose.multiuser.yml`、Dockerfile 装载、安装器多用户向导 | `dsh-multiuser-compose-smoke`（compose 校验 + 真实 `nginx -t`）、`dsh-multiuser-e2e-smoke`（真实容器端到端）、`install-multiuser-smoke`（含 bash 行为验证） |

### 10.2 真实执行中发现并修正的问题

以下问题静态审查发现不了，必须真跑才暴露；均已修正并纳入回归：

| 问题 | 后果 | 修正 |
| --- | --- | --- |
| 静态 `upstream` 解析认证网关 | 网关未就绪时入口起不来 | 变量上游 + `resolver 127.0.0.11` |
| `daemon off` 重复指令 | nginx 拒绝启动 | 配置内声明后不再从命令行传入 |
| 绝对重定向 | 用户被带到 `http://<域名>:3080/...` | `absolute_redirect off` |
| `Host` 丢端口（`$host`） | 网关同源校验 403，注册不可用 | 改为 `$http_host` |
| `DSH_ACCESS_MODE=password` 未被识别 | 容器启动即失败 | `configure-nginx-auth` 接受 `password`（等同关闭容器内认证） |
| `ensure` 等待就绪 | 登录请求被代理超时截断 | `ensure` 立即返回，就绪状态由 `/instances/state` 轮询 |
| 登录响应的 `ready` 取自调用成功 | 谎报就绪，前端撞 502 | ensure 后再查一次真实状态 |
| 注册限速只统计失败 | 成功注册不计数，批量建号不受限 | 成功同样计入额度 |
| 随机口令可能不含数字 | 系统生成的口令过不了自身强度校验 | `generatePassword()` 保证组成 |
| 部署模式硬编码在状态库 | 改 `.env` 重跑向导不生效 | 启动时按 `.env` 同步模式与注册门槛 |
| 启动期 `chown` 非递归 | 子目录属主未隔离 | 递归 `chownTree` |
| 删除账号被编排故障阻断 | 封禁账号做不到 | 继续删除并回报 `instanceRemoved`，失败留痕 |
| Windows 无法执行 `.cmd` 测试替身 | 假 docker 不可用 | 服务新增通用 `DSH_DOCKER_ARGS` 前缀（亦可用于 `sudo docker`） |
| 镜像里没有 docker CLI | 实例编排无法创建任何实例（spawn ENOENT，报错为空） | 镜像加入 Debian 的 `docker-cli`（仅客户端） |
| `-v` 用了容器内路径 | 守护进程在宿主上找不到该路径，实例创建失败 | 编排服务 inspect 自身挂载表推导宿主路径，失败时回退 `DSH_HOST_USERS_DIR` |
| 实例缺入口所需能力 | 容器启动即 EPERM（`mkdir /data/dsh/...`） | 实例能力集与主容器一致（CHOWN/DAC_OVERRIDE/FOWNER/FSETID/SETGID/SETUID/KILL） |
| 给 `/tmp` 挂了 `noexec` 的 tmpfs | DSH 原生模块加载器物化 `.node` 后 dlopen 失败 | 去掉该 tmpfs，与主容器保持一致 |
| 嵌套的文件级挂载 | 在 Windows 宿主上失效，写入落回目录 | 只做目录级挂载，模型配置生成在实例 home 内 |
| 绑定挂载无法表达属主 | 入口 `install -o -g` 失败，Docker Desktop 上实例起不来 | 新增 `DSH_INSTANCE_STORAGE=volume`，Windows/macOS 用卷 |
| 入口未归口网关路径 | 登录页的 CSS/JS 与管理面板被转到用户实例，登录页打不开 | 显式归口 `/app.css`、`/backdrop.js`、`/admin`、`/api/admin/` |
| 编排令牌无人创建 | 实例服务反复重启（ENOENT） | 由 dsh-auth 创建（uid 1000 写 0600，root 读得到） |
| 就绪探针只探了实例 nginx 的 `/healthz` | 该端点是**无条件 204**，nginx 一起来就报「就绪」；页面立刻跳转，用户撞上实例 nginx 的原始 502 | 探针改为访问实例内的 DSH 本体端口（3081） |
| 入口未拦截上游错误 | nginx 默认 `proxy_intercept_errors off`，实例返回的 502 被原样透传，`error_page ... = @to_waking` 不生效，用户看到原始 502 而非唤醒页 | `location /` 增加 `proxy_intercept_errors on` |
| 登录后无实例即停在占位状态 | root 登录后只有「退出登录」，进不去工作台也看不到管理面板入口 | 有实例且就绪时直接进入工作台；已登录状态补上工作台与管理面板入口 |

### 10.2.1 安全审计修复（2026-10）

完整审计（六阶段，30 个覆盖单元）确认 15 项漏洞，已全部修复并为每一项补充回归测试：

| # | 严重度 | 漏洞 | 修复 |
| --- | --- | --- | --- |
| 1 | high | 畸形请求行使 `new URL` 在 try 外抛 ERR_INVALID_URL，进程退出（实测 `RestartCount 0→1`） | 解析移入独立 try + 400；进程级 `unhandledRejection` 兜底（`dsh-auth`/`dsh-instances` 同修） |
| 2 | high | 密钥面板 seed 守卫是「lstat 后子进程按路径名重开」的 TOCTOU，符号链接可把密钥写进容器可读文件 | 面板进程 `O_NOFOLLOW` 自读自写，文本经 stdin 传给 seeder、不再传 `--home`（`key-admin-seed-toctou-smoke`） |
| 3 | high | 成功登录删除共享 IP 桶 → 任一账户可逐个锁死其他账户（实测 12/12） | 只清账户自身桶；管理员重置口令同步清除账户桶（`dsh-auth-policy-smoke`） |
| 4 | high | 认证数据库整目录挂进 Agent 容器，Agent 同 uid 可读 totp.key 并解出全部 TOTP 密钥（实测 6/6） | 基础 compose 移除该挂载；basic 模式经 `docker-compose.basic-auth.yml` 只挂 htpasswd 单文件 |
| 5 | high | 实例与管理员工作台/网关共用 dsh-private，跨租户读写配置（实测 PUT 管理员 settings.yaml 成功） | 专用 `dsh-instances-net`（成员仅用户实例、入口、密钥代理）；broker 接入实例网络顺带修复实例无模型路由的问题 |
| 6 | medium | `clientIp` 无条件信任 `x-real-ip`，直连网关可自选配额键与审计地址 | 仅当直接对端在 `DSH_AUTH_TRUSTED_PROXIES`（默认入口容器）时采信转发头 |
| 7 | medium | 停用/删除账户不刷新授权表，被撤销账户的实例令牌仍被 broker 认作有效 | 两处处理器在 `store.write` 后调用 `syncBrokerGrants` |
| 8 | medium | 通行密钥登记仅凭会话，与删除/改密/关 TOTP 的再认证要求不对称 | `register/begin` 要求 `currentPassword`；恢复码与密钥的 UI 标签同步更新 |
| 9 | medium | 状态库读改写无并发控制：停用被回退、一次性挑战变回可重放、会话被销毁（审计实测三项全发生） | `revision()` 修订号 + `commitState()` 比对，过期快照写入抛 `StateConflictError` → 409 可重试（`dsh-auth-state-cas-smoke`） |
| 10 | medium | `prune_dir_except` 按行解析 find 输出，含换行的目录名让 `rm -rf` 越出项目范围（实测 sibling 被删） | `-print0` + `read -d ''` NUL 分隔（`install-prune-newline-smoke`） |
| 11 | medium | `normalizeUpstreamPath` 校验解码值、转发原始值，`..%2f` 类编码绕过前缀白名单（实测 broker 日志 deny vs forward） | 解码后含 `/` 的段直接拒绝（`broker-path-traversal-smoke`） |
| 12 | medium | 删除账户后 uid 立即回收，新账户继承遗留数据卷（实测读到前一用户文件） | 数据未确认清理时记入 `retainedUids` 墓碑，`allocateUid` 跳过（`dsh-auth-uid-tombstone-smoke`） |
| 13 | medium | 登录页 `redirect` 参数仅字符串前缀校验，`\`/tab/LF/CR 四类形式离开站点（实测） | 先拦控制字符与反斜杠，`new URL` 归一化后比较 origin（`redirect-target-smoke`） |
| 14 | medium | 失败计数由未认证输入按调用者键无限增长（实测 1000 请求 → 1250 键） | `prune` 按最大窗口过期 + `MAX_FAILURE_KEYS` 上限淘汰；被拒请求不再落键 |
| 15 | low | verify 端点仅靠 nginx `internal` 防护，进程不校验对端 | `DSH_AUTH_INGRESS_TOKEN` 共享密钥，入口经运行时 include 注入（配置本体不落密钥） |

审计建议的加固项（非漏洞）一并落地：`rate_limited` 审计条目补记来源地址与被哪个维度拦下；`passkeyOrigin` 公共后缀注释与实现对齐的说明保留在审计报告中。

### 10.3 运维要点

- **注册门槛以 `.env` 为准**：`DSH_REGISTER_GATE` 在启动时同步进状态库；切到 `invite` 而当前无可用邀请码时会自动生成一个并写入 `data/auth/invite-code`（0600），也可在管理面板轮换。
- **闲置停用**：默认 30 分钟。被回收后用户访问落到 `/waking`，页面主动唤起并轮询，就绪后回到原地址；唤醒耗时 10–30 秒。
- **Passkey 需要固定 HTTPS 域名**：设置 `DSH_PUBLIC_ORIGIN`（如 `https://dsh.example.com`）。未设置或经 IP、纯 HTTP 访问时，通行密钥入口自动隐藏。
- **数据与配额**：账户数据在 `data/users/<uid>/`，属主为该实例 uid。磁盘配额是统计与告警口径，不是文件系统硬配额。
- **状态库是权威**：`data/auth/state.json` 保存账户、会话哈希、一次性凭据与审计。删除它等于清空全部账户，升级前应备份。

### 10.4 账户界面的归置

账户相关的界面按「是否管理他人」分置两处：

| 界面 | 位置 | 理由 |
| --- | --- | --- |
| 登录 / 注册 / 实例唤醒 | dsh-auth（容器外） | 登录界面不能放在需要登录才能看到的页面里；它天然属于网关层 |
| 自助账户管理（改密、TOTP、通行密钥、本人会话） | **docker-control 插件**（容器内），`/account` 保留为兜底与深链目标 | 用户就在工作台里，不必记另一个地址；插件被关闭时仍有入口 |
| 管理他人（停用/删除账户、重置口令、轮换邀请码、审计、实例水位） | dsh-auth（容器外），仅多用户模式存在 | 这段界面用**管理员的会话**操作他人账户，影响面是全体用户；不容许由某个用户的容器渲染 |

**必须写明的信任变化**：插件的前端产物位于 `/data/dsh/docker-control/client/client.js`，属主是容器内的 dsh 账户且可写——Agent 以同一身份运行，因此**被注入的 Agent 可以改写这段界面**。放在容器内的代价就是：渲染密码框的那段代码不再是容器外那份不可篡改的副本。

这个取舍在单管理员模式下成立的理由是：容器属主与账户属主是同一个人，没有跨越权限边界；而在多用户模式下，「管理他人」的界面因此被刻意留在容器外。

第二道约束仍然有效：改密、关闭 TOTP、删除通行密钥都要求重新输入当前密码。即使 bundle 被改写，攻击者也无法在无交互的情况下改掉凭据——它只能骗用户亲手输入，而这是可以被拒绝的。

### 10.5 尚未实施

原先列在这里的四项（安装收尾摘要打印、`dsh.sh users` 子命令、账户页界面、每用户模型授权）均已交付：摘要由 `print_multiuser_summary` 输出，子命令见 `dsh.sh` 的 `users|start-user|stop-user`，界面是 `bin/dsh-auth-web/account-panel.js`（三处共享一份实现），模型授权按上游粒度（管理面板「模型开放」标签页 + `broker-grants.json`）。

仍在开放的工作项（均为平台级工程，不阻塞当前使用）：

- 密钥代理的成功响应**体**未做凭据脱敏：响应头已在成功与失败两个分支都过 `redactHeaders`（2026-10-02），但成功分支的响应体刻意保持流式直通——缓冲它会在长回答上吃满内存。因此“上游在 2xx 响应体里回显收到的凭据”这一情形仍取决于上游实现，仓库内无从判定。
- Windows 安装器与 Linux 的能力差距、两个安装器实现的字段差异、存量实例迁移到专用实例网络，以及编排服务与特权代理重叠的属主修复职责。

以下两项已于 2026-10-02 收口（详见 `changes/2026-10-02-close-five-known-gaps-test-debt-and-four-hardening-items.json`）：

- 通行密钥曾接受公共后缀根（`co.uk`）作为 RPID：现在 `passkeyOrigin` 以精选的 PSL 子集判定「整个主机名等于后缀根」并拒绝，其下的合法注册域（`example.co.uk`、`foo.github.io`）仍然可用，回归测试见 `tests/passkey-origin-suffix-smoke.mjs`。
- 判定端点曾只在内存里滑动会话活动时间：由于每个请求都会对磁盘快照跑 `prune`，用户在持续访问中也会在闲置窗口到点后被登出。现在按 `DSH_AUTH_ACTIVITY_PERSIST_SECONDS`（默认 60 秒）节流落盘，回归测试见 `tests/dsh-auth-activity-persist-smoke.mjs`。
