# dsh-docker-control

dsh-docker 内置控制插件。它在 Web 设置窗口的左侧导航中注册独立的“DSH 环境”页（与“通用设置 / 模型 / 插件 / Agent 预设”同级），在顶层操作栏保留“重启 DSH”按钮，并将官方“打开配置文件”操作替换为 WebUI 内的 `settings.yaml` 编辑器，不依赖 SSH、插件市场或系统图形文本编辑器。

“DSH 环境”页显示当前版本与最新版本、提供“检查更新”和“立即更新”，并提供“电脑 UI / 手机 UI”布局选择器。打开设置页只读取容器内的构建元数据，不会联网：只有按下“检查更新”才会 `git ls-remote` 上游分支并读取上游 `package.json`。布局选择保存在当前浏览器的 `localStorage`，没有保存过时按浏览器 UA（以及窄窗口）自动判定；手机布局把设置面板改为全屏、左侧导航改为顶部横向标签条（保留可见滚动条以提示可以左右滑动），并把首页侧边栏改成抽屉：侧边栏收起时连 56px 图标轨道一起让位，改由插件在左上角渲染一个浮动展开按钮（调用宿主 `ctx.layout.toggleSidebar()`）；展开后浮在会话之上而不是挤压它。侧边栏列本身始终保留在 DOM 中，因为设置窗口是它的 `position: fixed` 后代。

“立即更新”固定调用容器内的 `/usr/local/bin/update-dsh`。更新器在 `/tmp` 的临时目录中拉取配置的 upstream、应用镜像内的补丁集、执行 `pnpm install --frozen-lockfile` 和 `pnpm run build:official`，通过 `nginx -t` 后原子替换 `/app/dsh`，最后请求 Supervisor 只替换 DSH 子进程。Debian 容器和 Nginx 均保持运行。更新状态和日志写入 `/data/dsh/update`。补丁无法应用、构建失败或配置检查失败时，当前 DSH 版本保持不变。

更新接口只接受经过 Nginx 认证并被转换为同源回环请求的固定路径，不接受命令、仓库或路径参数，也不需要 Docker Socket。

按钮只在用户明确确认后调用 `/dsh-docker-control/restart`，重启请求由容器内 Nginx 的认证入口转换为回环同源请求，再交给 `/usr/local/bin/restart-dsh` 和 Supervisor。插件不会自行复制 Node 启动命令、不会重启容器或 Nginx，也不会改变 Vision Router 或其他设置。重启期间页面会短暂断开，服务恢复后自动刷新。版本信息在打开“DSH 环境”页时读取一次；设置面板的顶层操作栏不再渲染版本文本，因此打开设置不会再看到版本区域闪动。当前没有后台轮询或红点提示。

配置编辑器固定读写 `$DSH_HOME/settings.yaml`，不接受任意文件路径。保存前会执行完整 YAML 语法和根对象校验，以 SHA-256 修订值阻止覆盖其他进程已经写入的更改，并通过同目录临时文件原子替换目标文件。无效、过大或过期的编辑都不会改动现有配置。
