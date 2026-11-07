// 最小的 CDP 客户端：把一条命令发给 Chromium 并等待结果。
//
// puppeteer 与 playwright 会引入大量依赖，而这个面板只需要 navigate、历史、重载、
// 输入文本、截图五个方法。CDP 本身是 HTTP 发现目标加 WebSocket 收发 JSON，Node 24
// 自带 fetch 与 WebSocket，无需新增依赖。
//
// 所有命令都发给同一个 page target；连接按需建立，超时即丢弃，避免把失效连接
// 留给下一次调用。

const HTTP_TIMEOUT_MILLISECONDS = 3000
const COMMAND_TIMEOUT_MILLISECONDS = 5000

export class CdpError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CdpError'
  }
}

export function createCdp(options = {}) {
  const port = options.port ?? 9222
  const fetchImpl = options.fetch ?? globalThis.fetch
  const WebSocketImpl = options.WebSocket ?? globalThis.WebSocket
  const commandTimeout = options.commandTimeout ?? COMMAND_TIMEOUT_MILLISECONDS

  let socket = null
  let pending = null
  let sequence = 0

  async function listTargets() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MILLISECONDS)
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal })
      if (!response.ok) throw new CdpError(`CDP 目标列表返回 ${response.status}`)
      const targets = await response.json()
      if (!Array.isArray(targets)) throw new CdpError('CDP 目标列表格式不符')
      return targets
    } catch (error) {
      if (error instanceof CdpError) throw error
      throw new CdpError(`连不上 Chromium 的调试端口：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  async function pageTarget() {
    const targets = await listTargets()
    const page = targets.find((target) => target?.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
    if (page === undefined) throw new CdpError('没有可用的 page target（浏览器还没有窗口）')
    return page
  }

  function connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocketImpl(url)
      const fail = (error) => reject(new CdpError(error instanceof Error ? error.message : 'CDP WebSocket 握手失败'))
      ws.addEventListener('open', () => resolve(ws), { once: true })
      ws.addEventListener('error', fail, { once: true })
    })
  }

  async function ensureSocket() {
    if (socket !== null) return socket
    const target = await pageTarget()
    socket = await connect(target.webSocketDebuggerUrl)
    socket.addEventListener('close', () => {
      socket = null
    })
    socket.addEventListener('message', (event) => {
      const current = pending
      if (current === null) return
      let payload
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'))
      } catch {
        return
      }
      if (payload?.id !== current.id) return
      pending = null
      current.settle(payload)
    })
    return socket
  }

  async function send(method, params = {}) {
    const ws = await ensureSocket()
    sequence += 1
    const id = sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending?.id === id) pending = null
        reject(new CdpError(`${method} 在 5s 内没有回应`))
      }, commandTimeout)
      pending = {
        id,
        settle: (payload) => {
          clearTimeout(timer)
          if (payload.error !== undefined) {
            reject(new CdpError(`${method}: ${payload.error?.message ?? '未知错误'}`))
            return
          }
          resolve(payload.result)
        },
      }
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        pending = null
        socket = null
        reject(new CdpError(`发送 ${method} 失败：${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  return {
    listTargets,
    pageTarget,
    send,
    async navigate(url) {
      await send('Page.enable')
      const result = await send('Page.navigate', { url })
      if (typeof result?.errorText === 'string' && result.errorText !== '') {
        throw new CdpError(`导航失败：${result.errorText}`)
      }
      return result
    },
    // 历史栈通过页面内的 history API 操作，返回操作后的 history.length。
    async history(direction) {
      const expression = direction === 'back' ? 'history.back(), history.length' : 'history.forward(), history.length'
      const result = await send('Runtime.evaluate', { expression, returnByValue: true })
      return result?.result?.value ?? null
    },
    async reload() {
      await send('Page.enable')
      await send('Page.reload', { ignoreCache: false })
      return true
    },
    // 返回页面当前的 location.href：页面内跳转与重定向只反映在页面里。
    async url() {
      const result = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
      const value = result?.result?.value
      return typeof value === 'string' ? value : null
    },
    async insertText(text) {
      await send('Input.insertText', { text })
      return true
    },
    async screenshot() {
      const result = await send('Page.captureScreenshot', { format: 'png' })
      const data = result?.data
      if (typeof data !== 'string' || data === '') throw new CdpError('截图返回为空')
      return Buffer.from(data, 'base64')
    },
    dispose() {
      pending = null
      try {
        socket?.close()
      } catch {}
      socket = null
    },
  }
}
