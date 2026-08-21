# dsh-docker-control

DSH-Docker 内置控制插件。它在 Web 设置窗口的顶层操作栏提供“重启 DSH”按钮，不依赖插件市场。

按钮只在用户明确确认后调用 `/dsh-docker-control/restart`，重启请求由容器内 Nginx 的认证入口转换为回环同源请求。插件不会默认重启，也不会改变 Vision Router 或其他设置。重启期间页面会短暂断开，服务恢复后自动刷新。
