import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

import { createCdp } from './cdp.js'

// 侧边栏浏览器：容器内的 Chromium 通过 RFB 呈现。
//
// 画面走 RFB：Xvfb 起一块虚拟屏，headed Chromium 画在上面，x11vnc 把这块屏转成
// RFB，前端用 noVNC 客户端接入。鼠标、滚轮、键盘共用同一条 RFB 连接。CDP screencast
// 是逐帧截图，拖拽与滚动有明显滞后，因此画面不走那条路。
//
// 这里只做进程与路由：Xvfb → openbox → x11vnc → chromium 的启停、健康状态，以及
// 控制接口。noVNC 的静态资源与 WebSocket 由 websockify 提供（novnc 包自带的依赖，
// `--web /usr/share/novnc 5800 -> 5900`），nginx 把 /dsh-browser-panel/vnc/ 反代到它，
// 因此这个插件不实现 WebSocket 转发，也不必往宿主的静态路由白名单里加入 JS 文件。
export const name = 'dsh-browser-panel'
export const inject = ['webServer']

const DISPLAY = process.env.DSH_BROWSER_DISPLAY ?? ':99'
const SCREEN_WIDTH = Number(process.env.DSH_BROWSER_WIDTH ?? 1280)
const SCREEN_HEIGHT = Number(process.env.DSH_BROWSER_HEIGHT ?? 800)
// 127.0.0.1 上的两个端口：RFB 给 x11vnc 用，http/ws 给 nginx 反代用。
const RFB_PORT = Number(process.env.DSH_BROWSER_RFB_PORT ?? 5900)
const WEB_PORT = Number(process.env.DSH_BROWSER_PORT ?? 5800)
// Chromium 的调试端口只绑回环：工具栏的导航、粘字与截图都从这里走。
const CDP_PORT = Number(process.env.DSH_BROWSER_CDP_PORT ?? 9222)
const DATA_DIR = process.env.DSH_BROWSER_DATA ?? join(process.env.DSH_HOME ?? '/data/dsh', 'browser-panel')
const PROFILE_DIR = join(DATA_DIR, 'chromium')
const LOG_LIMIT = 40
const START_TIMEOUT_MILLISECONDS = Number(process.env.DSH_BROWSER_START_TIMEOUT ?? 20000)
const AUTOSTART = (process.env.DSH_BROWSER_PANEL_AUTOSTART ?? '0') === '1'
// 桌面空闲一段时间后回收 CPU 与内存；0 表示只在手动停止时才停。
const IDLE_STOP_MINUTES = Number(process.env.DSH_BROWSER_PANEL_IDLE_MINUTES ?? 30)
const NOVNC_DIR = process.env.DSH_BROWSER_NOVNC_DIR ?? '/usr/share/novnc'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tail(list, line) {
  list.push(line)
  if (list.length > LOG_LIMIT) list.shift()
  return line
}

// 端口就绪探测：x11vnc 从启动到接受 RFB 连接之间存在空窗，因此等到 accept 成功
// 才报告 running。
function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    const finish = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1000, () => finish(false))
  })
}

async function waitFor(check, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(100)
  }
  return false
}

const X_SOCKET = `/tmp/.X11-unix/X${DISPLAY.replace(/^:/, '')}`
const X_LOCK = `/tmp/.X${DISPLAY.replace(/^:/, '')}-lock`

class BrowserPanel {
  constructor() {
    this.state = 'stopped'
    this.error = null
    this.startedAt = null
    this.lastUsedAt = Date.now()
    this.log = []
    this.children = { xvfb: null, windowManager: null, vnc: null, web: null, chromium: null }
    this.cdpClient = createCdp({ port: CDP_PORT })
    this.queue = Promise.resolve()
    this.stopping = false
  }

  run(operation) {
    // 启停必须串行：两个 start 同时进来会各自 spawn 一份 Xvfb 与 Chromium。
    this.queue = this.queue.then(operation, operation)
    return this.queue
  }

  touch() {
    this.lastUsedAt = Date.now()
  }

  status() {
    return {
      ok: true,
      state: this.state,
      error: this.error,
      display: DISPLAY,
      screen: { width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
      ports: { rfb: RFB_PORT, web: WEB_PORT, cdp: CDP_PORT },
      profile: PROFILE_DIR,
      startedAt: this.startedAt,
      uptimeSeconds: this.startedAt === null ? 0 : Math.round((Date.now() - this.startedAt) / 1000),
      pid: this.children.chromium?.pid ?? null,
      novnc: existsSync(novncEntry()),
      log: [...this.log],
    }
  }

  spawnChild(key, command, args, options = {}) {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DISPLAY, HOME: options.home ?? process.env.HOME },
      ...options.spawn,
    })
    const tag = key
    child.stdout?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') tail(this.log, `[${tag}] ${line.trim()}`)
      }
    })
    child.stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') tail(this.log, `[${tag}] ${line.trim()}`)
      }
    })
    child.once('error', (error) => {
      tail(this.log, `[${tag}] ${error.message}`)
      if (this.state === 'running') this.fail(`${command} 无法执行：${error.message}`)
    })
    child.once('exit', (code, signal) => {
      if (this.children[key] === child) this.children[key] = null
      // 停止流程里退出是预期内的，只有「运行中被拆掉」才需要把状态改回 stopped。
      if (this.stopping || this.state !== 'running') return
      if (key === 'chromium' || key === 'vnc' || key === 'web' || key === 'xvfb') {
        this.state = 'stopped'
        this.startedAt = null
        this.error = `${command} 已退出（code ${code ?? '-'}${signal === null ? '' : `, signal ${signal}`}）`
      }
    })
    this.children[key] = child
    return child
  }

  fail(message) {
    this.state = 'error'
    this.error = message
    tail(this.log, `[error] ${message}`)
  }

  async start() {
    if (this.state === 'running') return this.status()
    if (this.state === 'starting') return this.status()
    this.state = 'starting'
    this.error = null
    try {
      mkdirSync(PROFILE_DIR, { recursive: true })
      this.clearStaleDisplay()

      this.spawnChild('xvfb', 'Xvfb', [
        DISPLAY, '-screen', '0', `${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24`, '-nolisten', 'tcp', '-ac',
      ])
      // -nolisten tcp 之后 X 只开 unix socket，所以只能等这个 socket 出现，不能探端口。
      const displayReady = await waitFor(() => existsSync(X_SOCKET), 8000)
      if (!displayReady) throw new Error(`Xvfb 在 8s 内没有就绪（${X_SOCKET}）`)

      // openbox 只是让「最大化、对话框、窗口位置」符合预期；缺了它浏览器仍能跑。
      this.spawnChild('windowManager', 'openbox', ['--sm-disable'])
      await sleep(200)

      // 只用 x11vnc 的纯 RFB：noVNC 需要的网页与 WebSocket 交给 websockify（novnc 包的依赖），
      // 不依赖 x11vnc 自带 http 服务的版本差异。
      this.spawnChild('vnc', 'x11vnc', [
        '-display', DISPLAY, '-localhost', '-nopw', '-shared', '-forever', '-repeat',
        '-noxdamage', '-rfbport', String(RFB_PORT), '-desktop', 'DSH browser',
      ])
      const vncReady = await waitFor(() => portOpen(RFB_PORT), 8000)
      if (!vncReady) throw new Error(`x11vnc 在 8s 内没有就绪（127.0.0.1:${RFB_PORT}）`)

      if (!existsSync(NOVNC_ENTRY())) throw new Error(`镜像里缺少 noVNC（${NOVNC_ENTRY()}）`)
      this.spawnChild('web', this.websockifyCommand(), [
        '--web', NOVNC_DIR,
        `127.0.0.1:${WEB_PORT}`,
        `127.0.0.1:${RFB_PORT}`,
      ])
      const webReady = await waitFor(() => portOpen(WEB_PORT), 8000)
      if (!webReady) throw new Error(`websockify 在 8s 内没有就绪（127.0.0.1:${WEB_PORT}）`)

      this.spawnChild('chromium', this.chromiumCommand(), [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        '--hide-crash-restore-bubble',
        `--user-data-dir=${PROFILE_DIR}`,
        `--remote-debugging-address=127.0.0.1`,
        `--remote-debugging-port=${CDP_PORT}`,
        `--window-position=0,0`,
        `--window-size=${SCREEN_WIDTH},${SCREEN_HEIGHT}`,
        '--start-maximized',
        'about:blank',
      ])

      this.state = 'running'
      this.startedAt = Date.now()
      this.lastUsedAt = Date.now()
      tail(this.log, `[dsh-browser-panel] 启动完成：${SCREEN_WIDTH}x${SCREEN_HEIGHT}, rfb ${RFB_PORT}, http ${WEB_PORT}`)
      return this.status()
    } catch (error) {
      this.stopping = true
      await this.terminate()
      this.stopping = false
      this.fail(error instanceof Error ? error.message : String(error))
      return this.status()
    }
  }

  chromiumCommand() {
    return process.env.DSH_BROWSER_CHROMIUM ?? 'chromium'
  }

  websockifyCommand() {
    return process.env.DSH_BROWSER_WEBSOCKIFY ?? 'websockify'
  }

  // 上一次容器被强杀时，X socket 与 lock 会留在 /tmp 里，新 Xvfb 于是拒绝启动。
  clearStaleDisplay() {
    try {
      rmSync(X_LOCK, { force: true })
      rmSync(X_SOCKET, { force: true })
    } catch {}
  }

  async terminate() {
    this.cdpClient.dispose()
    const order = ['chromium', 'web', 'vnc', 'windowManager', 'xvfb']
    const pending = []
    for (const key of order) {
      const child = this.children[key]
      if (child === null || child === undefined) continue
      this.children[key] = null
      pending.push(new Promise((resolve) => {
        const done = () => resolve()
        child.once('exit', done)
        try {
          child.kill('SIGTERM')
        } catch {
          return done()
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {}
          resolve()
        }, 2000)
      }))
    }
    await Promise.all(pending)
  }

  async stop(reason = '手动停止') {
    if (this.state === 'stopped') return this.status()
    this.state = 'stopping'
    this.stopping = true
    try {
      await this.terminate()
    } finally {
      this.stopping = false
      this.state = 'stopped'
      this.startedAt = null
      this.error = null
      tail(this.log, `[dsh-browser-panel] 已停止（${reason}）`)
      this.clearStaleDisplay()
    }
    return this.status()
  }

  async restart() {
    await this.stop('重启')
    return this.start()
  }

  // 空闲回收：停止前写一行日志，便于对照时间点。
  eventualIdleStop() {
    if (IDLE_STOP_MINUTES <= 0) return null
    const timer = setInterval(() => {
      if (this.state !== 'running') return
      if (Date.now() - this.lastUsedAt < IDLE_STOP_MINUTES * 60_000) return
      void this.run(() => this.stop(`空闲 ${IDLE_STOP_MINUTES} 分钟`))
    }, 60_000)
    timer.unref?.()
    return timer
  }
}

function novncEntry() {
  return join(NOVNC_DIR, 'vnc.html')
}

const panel = new BrowserPanel()

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

// 这些接口能启停容器里的进程，所以只认「经 nginx 进来的回环请求」：nginx 会把 Host
// 改写成 127.0.0.1:3081（见 nginx/dsh-nginx.conf 的 location /），而直连 3081 的
// 请求不会带这个 Host。写接口再要求一个自定义头，跨站表单无法伪造。
function trustedIngress(request) {
  const remote = request.socket?.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const host = String(request.headers.host ?? '')
  return loopback && host.startsWith('127.0.0.1')
}

function readMethod(request, response, method) {
  if (request.method === method) return true
  response.writeHead(405, { allow: method })
  response.end()
  return false
}

function readJsonBody(request, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    request.on('error', reject)
  })
}

// 地址栏输入可能缺少协议：缺失时补齐，并拒绝 javascript:/data:/file: 这类会在宿主
// 页面上下文里执行或被当成脚本的 scheme。
export function normalizeUrl(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') throw new Error('地址为空')
  // `localhost:3000` 形如 `scheme:`，实为无协议的主机:端口。
  const schemaLike = /^[a-z][a-z0-9+.-]*:/i.test(value)
  const hostWithPort = /^[a-z][a-z0-9+.-]*:\d+/i.test(value)
  if (!schemaLike || hostWithPort) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(value)
    return normalizeUrl(`${local ? 'http' : 'https'}://${value}`)
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('地址无法解析')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`不支持的协议 ${url.protocol}`)
  return url.toString()
}

export function apply(ctx) {
  const webServer = ctx.webServer
  const register = (path, handler) => {
    const route = { kind: 'exact', path, handler }
    return typeof ctx.effect === 'function'
      ? ctx.effect(() => webServer.register(route), `dsh-browser-panel: ${path}`)
      : webServer.register(route)
  }

  register('/dsh-browser-panel/status', (request, response) => {
    if (!readMethod(request, response, 'GET')) return
    if (!trustedIngress(request)) {
      sendJson(response, 403, { ok: false, error: '仅允许已认证的回环请求 / loopback only' })
      return
    }
    panel.touch()
    sendJson(response, 200, panel.status())
  })

  register('/dsh-browser-panel/start', (request, response) => {
    if (!readMethod(request, response, 'POST')) return
    if (!trustedIngress(request) || request.headers['x-dsh-browser-panel'] !== '1') {
      sendJson(response, 403, { ok: false, error: '仅允许已认证的回环请求 / loopback only' })
      return
    }
    panel.touch()
    panel.run(() => panel.start()).then(
      (status) => sendJson(response, 200, status),
      (error) => sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }),
    )
  })

  register('/dsh-browser-panel/stop', (request, response) => {
    if (!readMethod(request, response, 'POST')) return
    if (!trustedIngress(request) || request.headers['x-dsh-browser-panel'] !== '1') {
      sendJson(response, 403, { ok: false, error: '仅允许已认证的回环请求 / loopback only' })
      return
    }
    panel.run(() => panel.stop()).then(
      (status) => sendJson(response, 200, status),
      (error) => sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }),
    )
  })

  register('/dsh-browser-panel/restart', (request, response) => {
    if (!readMethod(request, response, 'POST')) return
    if (!trustedIngress(request) || request.headers['x-dsh-browser-panel'] !== '1') {
      sendJson(response, 403, { ok: false, error: '仅允许已认证的回环请求 / loopback only' })
      return
    }
    panel.touch()
    panel.run(() => panel.restart()).then(
      (status) => sendJson(response, 200, status),
      (error) => sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }),
    )
  })

  const guarded = (request, response) => {
    if (!trustedIngress(request) || request.headers['x-dsh-browser-panel'] !== '1') {
      sendJson(response, 403, { ok: false, error: '仅允许已认证的回环请求 / loopback only' })
      return false
    }
    return true
  }

  const running = (response) => {
    if (panel.state === 'running') return true
    sendJson(response, 409, { ok: false, error: '浏览器没有运行 / browser is not running', state: panel.state })
    return false
  }

  const failed = (response) => (error) => {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }

  register('/dsh-browser-panel/navigate', (request, response) => {
    if (!readMethod(request, response, 'POST')) return
    if (!guarded(request, response) || !running(response)) return
    readJsonBody(request).then(async (body) => {
      const url = normalizeUrl(body.url)
      panel.touch()
      await panel.cdpClient.navigate(url)
      sendJson(response, 200, { ok: true, url })
    }).catch(failed(response))
  })

  for (const [direction, method] of [['back', 'history'], ['forward', 'history']]) {
    register(`/dsh-browser-panel/${direction}`, (request, response) => {
      if (!readMethod(request, response, 'POST')) return
      if (!guarded(request, response) || !running(response)) return
      panel.touch()
      panel.cdpClient[method](direction).then(
        (length) => sendJson(response, 200, { ok: true, entries: typeof length === 'number' ? length : null }),
        failed(response),
      )
    })
  }

  register('/dsh-browser-panel/reload', (request, response) => {
    if (!readMethod(request, response, 'POST')) return
    if (!guarded(request, response) || !running(response)) return
    panel.touch()
    panel.cdpClient.reload().then(
      () => sendJson(response, 200, { ok: true }),
      failed(response),
    )
  })

  // 中文输入法进不了 X，粘字走 CDP 的 Input.insertText：命中当前焦点元素，
  // 不经过 X 的键盘事件，因此也不受输入法影响。
  register('/dsh-browser-panel/insert-text', (request, response) => {
    if (!readMethod(request, response, 'POST')) return
    if (!guarded(request, response) || !running(response)) return
    readJsonBody(request, 65536).then(async (body) => {
      const text = String(body.text ?? '')
      if (text === '') throw new Error('没有要插入的文本')
      panel.touch()
      await panel.cdpClient.insertText(text)
      sendJson(response, 200, { ok: true, length: text.length })
    }).catch(failed(response))
  })

  register('/dsh-browser-panel/url', (request, response) => {
    if (!readMethod(request, response, 'GET')) return
    if (!trustedIngress(request)) {
      sendJson(response, 403, { ok: false, error: '仅允许已认证的回环请求 / loopback only' })
      return
    }
    if (!running(response)) return
    panel.touch()
    panel.cdpClient.url().then(
      (url) => sendJson(response, 200, { ok: true, url }),
      failed(response),
    )
  })

  register('/dsh-browser-panel/screenshot', (request, response) => {
    if (!readMethod(request, response, 'GET')) return
    if (!trustedIngress(request)) {
      sendJson(response, 403, { ok: false, error: '仅允许已认证的回环请求 / loopback only' })
      return
    }
    if (!running(response)) return
    panel.touch()
    panel.cdpClient.screenshot().then((png) => {
      response.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-length': png.length,
      })
      response.end(png)
    }, failed(response))
  })

  const idleTimer = panel.eventualIdleStop()
  // 插件卸载或 DSH 退出时把四个子进程一起收掉，否则下一次启动会撞上残留的 X socket。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (idleTimer !== null) clearInterval(idleTimer)
      void panel.stop('DSH 退出')
    }, 'dsh-browser-panel: process lifecycle')
  }

  if (AUTOSTART) {
    void panel.run(() => panel.start())
  }
}
