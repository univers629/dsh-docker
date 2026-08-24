# dsh-docker-control

dsh-docker 内置控制插件。它在 Web 设置窗口的顶层操作栏显示 DSH 版本，提供“更新 DSH”和“重启 DSH”按钮，并将官方“打开配置文件”操作替换为 WebUI 内的 `settings.yaml` 编辑器，不依赖 SSH、插件市场或系统图形文本编辑器。

“更新 DSH”固定调用容器内的 `/usr/local/bin/update-dsh`。更新器在 `/tmp` 的临时目录中拉取配置的 upstream、应用镜像内的补丁集、执行 `pnpm install --frozen-lockfile` 和 `pnpm run build:official`，通过 `nginx -t` 后原子替换 `/app/dsh`，最后安排当前容器进程优雅重启。更新状态和日志写入 `/data/dsh/update`。补丁无法应用、构建失败或配置检查失败时，当前 DSH 版本保持不变。

更新接口只接受经过 Nginx 认证并被转换为同源回环请求的固定路径，不接受命令、仓库或路径参数，也不需要 Docker Socket。

按钮只在用户明确确认后调用 `/dsh-docker-control/restart`，重启请求由容器内 Nginx 的认证入口转换为回环同源请求。插件不会默认重启，也不会改变 Vision Router 或其他设置。重启期间页面会短暂断开，服务恢复后自动刷新。

配置编辑器固定读写 `$DSH_HOME/settings.yaml`，不接受任意文件路径。保存前会执行完整 YAML 语法和根对象校验，以 SHA-256 修订值阻止覆盖其他进程已经写入的更改，并通过同目录临时文件原子替换目标文件。无效、过大或过期的编辑都不会改动现有配置。
