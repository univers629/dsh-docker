# DSH 0.2.1-rc.2 迁移说明

0.2.1 改掉了四处产物补丁依赖的形状：两条补丁的目标文件或锚点消失（安装直接失败），
一条补丁的锚点还在但它引用的函数已被删除（装上去会在请求路径上抛错）。这份文档记录针对
npm 上 `@deepseek-ai/dsh@0.2.1-rc.2` 实产物的逐条验证结果，以及升级顺序。

## 实测结论

| 项目 | 结论 |
| --- | --- |
| 产物补丁 | 12 条：9 条锚点命中；`sandbox-escalation-self-mode` 上游已内置（marker 已在产物里）；`app-boot-realpath-package-dir` 与 `public-local-mode-transport-owner-node` 命中；两条旧条目已删除（见下） |
| `public-local-mode-transport-owner` | `exports["./client"]` 拆成 `browser` 与 `node` 两个条件，`lib/client.js` 不再存在；浏览器侧补丁改打 `lib/client.browser.js`，另加一条可选条目覆盖 `lib/client.node.js`。模块加载器取条件的 `default`，即 `client.browser.js` |
| `workspace-model-pending-attachments-create` | `reuseOrCreateBlank` 被 `connectBlank` → `createInWorkspace` → `createNamed` 取代，旧锚点消失；所有创建路径都经过 `createNamed`，通知 Workspace model 的位置随之内移 |
| `trusted-proxy-auto-browser-auth` | 锚点仍在，但 `requestAuthority(headers)` 已改为 `requestAudience(headers, secure)`，`isAuthenticated` 与 `sessionCookie` 都多了 `secure` 参数；不跟签名就会在首个 trusted-proxy 请求上抛 `ReferenceError` |
| 已删除的旧条目 | `public-local-mode`（旧产物形状自 0.2.0 起就不存在，功能由 transport-owner 承担）与 `app-boot-realpath-import`（0.2.0 起 app-boot 自己导入 `realpathSync`） |
| 预检返回形状 | 兼容性判定结果由 `peers` 改名为 `requirements`，键是 `engines.dsh` 或 `@deepseek-ai/dsh*`；0.2.1 还新支持插件用 `engines.dsh` 声明版本要求，优先于 `peerDependencies` |
| 安装脚本白名单 | 闭包内带 install 脚本的包仍是五项：`@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty`、`@google/genai`、`protobufjs` |
| 目录布局、CLI、bundle 名 | `lib/bin.js` 入口、`--dump-config*`、`--profile`、`web` 与 `plugin` 子命令、`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` 两个 bundle、`webserver`/`web-runtime` 两个 entry 与 `ctx.webStartup` 服务均未改名 |
| 运行时要求 | `engines` 仍是 `^22.19.0 || >=24.0.0`，镜像的 `node:24-trixie-slim` 满足 |

三处环境变量注入与 `DSH-BUILD-METADATA.json` 的自造格式不受这次升级影响，无需改动。

## 升级顺序

```text
1. 备份 DSH_HOME（profiles/、storages/ 与凭据文件）。
2. 更新工程源码后重建镜像并升级容器（补丁集已跟随 0.2.1），或换用按 0.2.1 构建的镜像：
   ./install.sh upgrade
3. 查看预检报告里会被禁用的插件，按下一节处置。
4. 重启并核对：启动日志里不应出现 disabling profile plugin；
   GET /dsh-docker-control/info 应看到插件全部在位。
```

容器内更新（`./install.sh update` 或面板"立即更新"）也能带上新补丁，但补丁定义随镜像
发布：仍运行旧镜像的容器拿不到这次的目标文件与锚点修正，会在替换 `/app/dsh` 前失败。

## 预检

`bin/preflight-profile-plugins.mjs` 的判定仍来自目标运行时树的 `@deepseek-ai/dsh-app-boot`，
报告格式不变；`未满足的要求` 一行按 `requirements` 打印要求的版本范围。

```text
用法：preflight-profile-plugins.mjs <module-root> [profile-dir] [--json] [--fail-on-incompatible]
退出码：0 完成；1 预检自身失败；2 参数错误；3 存在会被禁用或未装载的插件（仅带 --fail-on-incompatible）
```

## 精确版本豁免

没有兼容版本的插件仍可用精确版本豁免登记，格式与 0.2.0 相同：

```json
{
  "dsh-cmdgo-provider@0.9.1": ["0.2.1-rc.2"]
}
```

```text
dsh plugin --profile web allow-version <包名@版本> --dsh-version 0.2.1-rc.2 --accept-risk
dsh plugin --profile web version-exemptions
```

## 验证命令

```text
# 产物补丁（非 optional 未命中即失败）
DSH_PATCH_DIR=$PWD/patches node bin/apply-dsh-artifact-patches.mjs <树>/node_modules --check

# 插件兼容性
node bin/preflight-profile-plugins.mjs <树>/node_modules [profile-dir]

# 离线冒烟（补丁定义的自洽与重入、预检输出、PWA 注入）
node tests/run-offline.mjs artifact-patches profile-preflight pwa
```

## 未决项

- 发布产物里 peer 或 `engines.dsh` 仍指向 `<0.2.0` 的插件在 0.2.1 宿主上会被禁用：
  实测 `dsh-cmdgo-provider@0.9.1`（六条 peer 卡在 `^0.1.0-rc.6` 一侧）与
  `@dsh-external/dsh-normify@0.5.4`（`engines.dsh: ">=0.1.5-rc.2 <0.2.0"`）。
  处置为先升级插件，或按上一节豁免。
- `nginx` 的 manifest `sub_filter` 此前只匹配绝对路径 `href="/manifest.webmanifest"`，
  而已发布的前端写的是目录相对路径 `href="./manifest.webmanifest"`，替换自 0.2.0 起一直
  空转。本次同时匹配两种形状；接入自定义前端时仍需核对该串。
- `bin/dsh` 的参数排除名单缺 `--dump-config-schema`：`dsh --profile web --dump-config-schema`
  会被注入 `--port`。属既有缺陷，与本次升级无关。
