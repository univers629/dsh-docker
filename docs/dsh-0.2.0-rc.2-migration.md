# DSH 0.2.0-rc.2 迁移说明

容器内更新（`./install.sh update` 或面板上的"立即更新"）只替换 `/app/dsh` 并重打产物补丁，
不触碰 profile。DSH 0.2.0 起会在加载 profile 之前校验每个插件声明的 `@deepseek-ai/dsh*`
peer 范围，不满足的插件被直接禁用：进程照常启动、健康检查照样通过、更新脚本的回滚逻辑
也看不到它，只有 stderr 上的一行 `dsh: disabling profile plugin ...`。插件功能整块消失，
但站点看起来一切正常。这份文档记录 0.1.7-rc.2 → 0.2.0-rc.2 的实测结论与升级顺序。

## 实测结论

对 npm 上真实的 `@deepseek-ai/dsh@0.2.0-rc.2` 产物逐条验证（不是读变更日志推断）：

| 项目 | 结论 |
| --- | --- |
| 13 条产物补丁 | 10 条锚点命中；`sandbox-escalation-self-mode` 已被上游内置（marker 已在产物里，判为已存在并跳过）；`app-boot-realpath-import` 与 `public-local-mode` 两条可选项锚点失效，均无害 |
| `app-boot-realpath-import` 失效原因 | 0.2.0 的 `dsh-app-boot` 自己就导入了 `realpathSync`，不再需要这条补丁 |
| `public-local-mode` 失效原因 | 旧产物形状已不存在；同一功能的 `public-local-mode-transport-owner` 仍然命中，落盘后 `isLoopback` 判定里的 `DSH_PUBLIC_LOCAL_MODE=1` cookie 分支仍在 |
| 命令行表面 | `lib/bin.js` 入口、`web` 与 `--profile`、`--port`/`--host`/`--no-open`/`--trusted-host`、`--patch`、`--dump-config*`、`plugin add\|update\|remove` 全部保留 |
| 目录布局 | `lib/node_modules/<pkg>/node_modules` 与根 `node_modules` 相对软链不变，`bin.dsh` 仍指向 `lib/bin.js` |
| 安装脚本白名单 | 闭包内带 install 脚本的包仍是五项：`@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty`、`@google/genai`、`protobufjs` |
| profile 与 bundle 名 | `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` 仍是 web 模板的 bundle；`webserver`/`web-runtime` 两个 entry 与 `ctx.webStartup` 服务未改名 |
| 组合层 | `schedule`/`time-context`/`ui-schedule` 三行移出 `dsh-web-app` 默认层，改为可选 bundle `@deepseek-ai/dsh-experimental-schedule-bundle`；`dsh-base` 新增 `otel` 行，遥测默认端点从 `harness-telemetry.deepseeksvc.com/v1/logs` 改为 `dsh-otel-collector.deepseeksvc.com/v1/logs` |
| 配置表 | `--dump-config-schema` 的 `$defs` 只多出一个 group 型条目，属性零变化 |
| 插件 peer 校验 | 当前 profile 的 20 个 bundle 里有 6 个在 0.2.0-rc.2 下会被禁用（同一份 profile 在 0.1.7-rc.2 下 0 个） |

三处环境变量注入、六条补丁目标包名、`DSH-BUILD-METADATA.json` 的自造格式都不受这次升级影响，
无需改动。

## 升级顺序

顺序不可颠倒：插件管理器在调用 pnpm 之前就做 peer 校验，在 0.1.7 宿主上安装"支持 0.2.0"
的插件版本会被直接拒绝。正确顺序是先升级宿主，再升级插件。

```text
1. 备份 DSH_HOME（profiles/、storages/ 与凭据文件）；更新本身不碰这些目录，
   但插件升级会重写 profile 清单。
2. 容器内更新到 0.2.0-rc.2：./install.sh update 或面板"立即更新"。
   此阶段预检会报出将被禁用的插件，功能在升级后补齐前不可用。
3. 升级有兼容版本的插件（宿主已是 0.2.0-rc.2，peer 校验通过）：
   dsh plugin --profile web add <插件>@<版本>
4. 对没有兼容版本的插件授予精确版本豁免（见下一节）。
5. 重启并核对：启动日志里不应再出现 disabling profile plugin；
   GET /dsh-docker-control/info 应看到插件全部在位。
```

## 预检

`bin/preflight-profile-plugins.mjs` 在替换运行时之前，用目标运行时树里自带的判定函数
（`@deepseek-ai/dsh-app-boot` 的 `getDshRuntimeVersion()` 与 `evaluatePluginCompatibility()`）
算出哪些插件会被禁用。判定与启动时的判定同源，不在这里重写规则。

```text
用法：preflight-profile-plugins.mjs <module-root> [profile-dir] [--json] [--fail-on-incompatible]
      <module-root>  目标运行时树的 node_modules 目录，与 apply-dsh-artifact-patches.mjs 同一参数
      profile-dir    默认 $DSH_PROFILE_ROOT，缺省退回 $DSH_HOME/profiles/web
退出码：0 完成；1 预检自身失败；2 参数错误；3 存在会被禁用或未装载的插件（仅带 --fail-on-incompatible）
```

人类可读模式的最后一行固定是 `摘要：...`，`update-dsh.sh` 取这一行写进更新状态，
所以插件会被禁用这件事在重启前就出现在日志与面板里。预检只报告、不拦截：它失败或
发现不兼容都不阻断更新，`--fail-on-incompatible` 也不出现在更新路径上。

## 精确版本豁免

没有兼容版本的插件可以在 profile 里登记精确版本豁免，代价是接受该插件在新宿主上
可能崩溃或损坏数据。豁免文件是 `<profile>/compatibility.json`，形如：

```json
{
  "@xxxyz/dsh-mcp-manager@2.2.7": ["0.2.0-rc.2"],
  "dsh-session-manager@0.2.2": ["0.2.0-rc.2"]
}
```

键必须是精确的 `包名@版本`，值必须是精确的 DSH 版本列表。更稳妥的写法是用插件管理器
生成（它同时做格式校验并在文件上持锁）：

```text
dsh plugin --profile web allow-version <包名@版本> --dsh-version <当前 DSH 版本> --accept-risk
dsh plugin --profile web revoke-version <包名@版本>
dsh plugin --profile web version-exemptions
```

豁免只对登记的那个版本组合生效：插件升级到新版本后需要重新登记。

## 验证命令

```text
# 产物补丁（对目标运行时的 node_modules 跑，非 optional 未命中即失败）
DSH_PATCH_DIR=$PWD/patches node bin/apply-dsh-artifact-patches.mjs <树>/node_modules --check

# 插件兼容性（期望：0.1.7-rc.2 全可用；0.2.0-rc.2 报出 6 个）
node bin/preflight-profile-plugins.mjs <树>/node_modules [profile-dir]

# 运行中核对
curl -s http://127.0.0.1:3081/dsh-docker-control/info | head -c 400
```

## 未决项

- `@xxxyz/dsh-mcp-manager@2.2.7` 是 npm 上的最新版本，peer 仍指向 `^0.1.2-rc.1`：只能豁免，
  或者等上游发布。
- `dsh-session-manager@0.2.2` 的 0.2.0 兼容修复停在上游未合并的 PR 里：要么改用该分支构建
  （版本号不变，peer 放宽为 `^0.1.0-rc.6 || ^0.2.0-rc.1`），要么豁免。
- `dsh-files` 的兼容版本没有打 tag，只能按 commit 安装。
- 本文的结论来自产物级与判定函数级验证：0.2.0-rc.2 没有在容器里真实启动过，插件升级后的
  界面行为需要在重启后人工确认一次。
- `nginx` 的 `sub_filter` 目标串没有对 0.2.0 的前端产物做字节级核对（失配是静默的，表现为
  PWA 元数据丢失）。
- `bin/dsh` 的参数排除名单缺 `--dump-config-schema`：`dsh --profile web --dump-config-schema`
  会被注入 `--port`，与本次升级无关，属于既有缺陷。
