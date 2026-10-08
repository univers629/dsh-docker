// DSH 重启后自动恢复页面。
//
// 背景：DSH 的模型配置（settings.yaml）只在启动时读取一次，所以改了供应商必须重启
// DSH 进程。而每次重启都会生成新的会话令牌，页面里那份随即失效：界面不会报错，
// 只是模型目录一直停在「正在加载模型…」——发起它的那次 RPC 再也等不到回应。
//
// 判据用 DSH 自己的存活通道 /plugins/events（SSE，client-hmr 插件用它做热更新）：
//   * 它先连上过、之后又连上 → 服务端换过一次进程；
//   * 它先连上过、之后持续连不上 → 服务端重启后拒绝了旧会话。
// 两种情况页面都需要重新加载才能恢复。
//
// 只在「曾经连上过」之后才刷新：初次就连不上（服务还没起来）不刷新，否则用户打开
// 一个暂时不可用的页面会被反复重载。
(() => {
  const EVENTS = '/plugins/events'
  // 刷新节流：重连会连续触发，不节流会让页面永远在转圈。
  const RELOAD_GUARD_MS = 15_000
  // 断开多久才认定「不是瞬时抖动」。SSE 的自动重连很快，给它几次机会。
  const DOWN_GRACE_MS = 5_000

  let connectedOnce = false
  let reloading = false
  let lastReload = 0
  let downSince = 0

  const reload = (reason) => {
    if (reloading) return
    const now = Date.now()
    if (now - lastReload < RELOAD_GUARD_MS) return
    reloading = true
    lastReload = now
    console.info('[dsh] ' + reason + '，正在重新加载页面')
    location.reload()
  }

  const source = new EventSource(EVENTS)
  source.addEventListener('open', () => {
    if (connectedOnce) {
      // 曾经连上过、现在又连上：中间的断开说明服务端重启过。
      reload('服务已重启')
      return
    }
    connectedOnce = true
    downSince = 0
  })
  source.addEventListener('error', () => {
    // 还没成功连上过就不介入：那多半是服务尚未就绪。
    if (!connectedOnce) return
    if (downSince === 0) {
      downSince = Date.now()
      return
    }
    if (Date.now() - downSince >= DOWN_GRACE_MS) reload('与服务端的连接已断开')
  })
})()
