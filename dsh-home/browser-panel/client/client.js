window.__ModuleLoader__.load({
  id: 'dsh-browser-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    const h = React.createElement
    // 侧边栏右列的类型注册与 slot 座位都是宿主提供的官方原语，插件这边只负责
    // 「注册一个类型」+「填两个座位」。这样不依赖 better-sidebar 之类的第三方侧栏。
    const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']
    const ID = 'dsh-browser-panel'
    const KIND = 'dsh-browser-panel'
    const STATUS_PATH = '/dsh-browser-panel/status'
    const ACTION_HEADER = { 'x-dsh-browser-panel': '1' }
    const POLL_MILLISECONDS = 2000

    const zh = {
      title: '浏览器',
      description: '真实 Chromium，可用鼠标和键盘直接操作',
      start: '启动',
      stop: '停止',
      restart: '重启',
      starting: '启动中…',
      running: '运行中',
      stopped: '未启动',
      stopping: '停止中…',
      error: '出错',
      failed: '操作失败',
      hint: '画面来自容器里的 Chromium，滚动、拖拽和键盘都走同一条 RFB 连接。中文输入走粘贴，快捷键由浏览器自己接管。',
      log: '日志',
      loading: '读取状态…',
      unavailable: '这个镜像没有装 noVNC / noVNC is missing from the image',
      back: '后退',
      forward: '前进',
      reload: '重载',
      addressPlaceholder: '输入网址，回车打开',
      paste: '粘贴',
      pasted: '已粘贴',
      clipboardEmpty: '剪贴板是空的',
      clipboardDenied: '读不到剪贴板，请在画面里直接粘贴',
    }

    const en = {
      title: 'Browser',
      description: 'A real Chromium driven by the mouse and keyboard',
      start: 'Start',
      stop: 'Stop',
      restart: 'Restart',
      starting: 'Starting…',
      running: 'Running',
      stopped: 'Stopped',
      stopping: 'Stopping…',
      error: 'Error',
      failed: 'Action failed',
      hint: 'The picture comes from Chromium inside the container; scrolling, dragging and the keyboard share one RFB connection. Chinese input goes through paste; shortcuts stay with the page.',
      log: 'Log',
      loading: 'Reading state…',
      unavailable: 'noVNC is missing from this image',
      back: 'Back',
      forward: 'Forward',
      reload: 'Reload',
      addressPlaceholder: 'Type a URL and press Enter',
      paste: 'Paste',
      pasted: 'Pasted',
      clipboardEmpty: 'The clipboard is empty',
      clipboardDenied: 'Clipboard is unreadable here; paste inside the screen',
    }

    function text() {
      const language = typeof document === 'undefined' ? 'en' : document.documentElement.lang
      return language && language.toLowerCase().startsWith('zh') ? zh : en
    }

    async function readJson(response) {
      const raw = await response.text()
      if (raw.length === 0) return {}
      try {
        return JSON.parse(raw)
      } catch {
        return { ok: false, error: raw.slice(0, 200) }
      }
    }

    async function post(path) {
      const response = await fetch(path, { method: 'POST', headers: ACTION_HEADER, cache: 'no-store' })
      return readJson(response)
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { ...ACTION_HEADER, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      })
      return readJson(response)
    }

    async function getJson(path) {
      const response = await fetch(path, { cache: 'no-store' })
      return readJson(response)
    }

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error, info) {
        console.error('[dsh-browser-panel] panel render failed:', error, info && info.componentStack)
      }

      render() {
        return this.state.failed ? null : this.props.children
      }
    }

    function statusLabel(status, t) {
      const state = status?.state ?? 'stopped'
      if (state === 'running') return { text: t.running, tone: 'ok' }
      if (state === 'starting') return { text: t.starting, tone: 'busy' }
      if (state === 'stopping') return { text: t.stopping, tone: 'busy' }
      if (state === 'error') return { text: t.error, tone: 'bad' }
      return { text: t.stopped, tone: 'idle' }
    }

    const TONES = {
      ok: { background: 'var(--dsw-success-bg, rgba(22, 163, 74, .14))', color: 'var(--dsw-success-fg, #16a34a)' },
      busy: { background: 'var(--dsw-warning-bg, rgba(217, 119, 6, .14))', color: 'var(--dsw-warning-fg, #b45309)' },
      bad: { background: 'var(--dsw-danger-bg, rgba(220, 38, 38, .14))', color: 'var(--dsw-danger-fg, #dc2626)' },
      idle: { background: 'var(--dsw-fill-quaternary, rgba(120, 120, 120, .14))', color: 'var(--dsw-text-secondary, #6b7280)' },
    }

    function ToolbarButton({ label, onClick, disabled, primary }) {
      return h('button', {
        type: 'button',
        onClick,
        disabled,
        style: {
          appearance: 'none',
          border: '1px solid var(--dsw-border-strong, rgba(120, 120, 120, .35))',
          background: primary ? 'var(--dsw-fill-primary, #2563eb)' : 'transparent',
          color: primary ? 'var(--dsw-text-on-primary, #fff)' : 'var(--dsw-text-primary, inherit)',
          borderRadius: 6,
          padding: '4px 10px',
          fontSize: 12,
          lineHeight: '18px',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
        },
      }, label)
    }

    function BrowserPanel() {
      const t = text()
      const [status, setStatus] = React.useState(null)
      const [phase, setPhase] = React.useState('loading')
      const [error, setError] = React.useState(null)
      // 启动或重启后换一个 key，iframe 因此重新建立连接，而不是沿用已断开的连接。
      const [frameKey, setFrameKey] = React.useState(0)
      // 地址栏同步页面当前的 location；输入框获得焦点时不覆盖其内容。
      const [address, setAddress] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const inputRef = React.useRef(null)

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(STATUS_PATH, { cache: 'no-store' })
          const next = await readJson(response)
          setStatus(next)
          setPhase('idle')
          if (next.ok === false) setError(next.error ?? t.failed)
          if (next.state === 'running') {
            const located = await getJson('/dsh-browser-panel/url')
            const focused = typeof document !== 'undefined' && document.activeElement === inputRef.current
            if (located.ok === true && typeof located.url === 'string' && !focused) setAddress(located.url)
          }
        } catch (loadError) {
          setPhase('idle')
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        }
      }, [t])

      React.useEffect(() => {
        let disposed = false
        const tick = () => { if (!disposed) void load() }
        tick()
        const timer = setInterval(tick, POLL_MILLISECONDS)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [load])

      const run = React.useCallback(async (path) => {
        setError(null)
        setPhase('busy')
        try {
          const next = await post(path)
          setStatus(next)
          if (next.ok === false) setError(next.error ?? t.failed)
          if (path !== '/dsh-browser-panel/stop') setFrameKey((key) => key + 1)
        } catch (actionError) {
          setError(actionError instanceof Error ? actionError.message : String(actionError))
        } finally {
          setPhase('idle')
        }
      }, [t])

      const state = status?.state ?? 'stopped'
      const label = statusLabel(status, t)
      const running = state === 'running'
      const busy = phase === 'busy' || state === 'starting' || state === 'stopping'
      const novncReady = status?.novnc !== false
      const frameSource = `/dsh-browser-panel/vnc/vnc.html?autoconnect=1&resize=scale&reconnect=1&view_only=0&path=dsh-browser-panel/vnc/websockify`

      // 工具栏动作共用这一条出口：失败时把错误显示在按钮下方。
      const act = React.useCallback(async (path, body) => {
        setError(null)
        setNotice(null)
        try {
          const next = body === undefined ? await post(path) : await postJson(path, body)
          if (next.ok === false) {
            setError(next.error ?? t.failed)
            return null
          }
          if (typeof next.url === 'string') setAddress(next.url)
          return next
        } catch (actionError) {
          setError(actionError instanceof Error ? actionError.message : String(actionError))
          return null
        }
      }, [t])

      const navigate = React.useCallback(async () => {
        const target = address.trim()
        if (target === '') return
        await act('/dsh-browser-panel/navigate', { url: target })
      }, [act, address])

      // 中文输入法在容器的 X 里不工作；粘贴按钮把剪贴板内容交给 CDP 插入焦点元素。
      const pasteText = React.useCallback(async () => {
        setError(null)
        setNotice(null)
        let clip = ''
        try {
          clip = await navigator.clipboard.readText()
        } catch {
          setError(t.clipboardDenied)
          return
        }
        if (clip === '') {
          setError(t.clipboardEmpty)
          return
        }
        const next = await act('/dsh-browser-panel/insert-text', { text: clip })
        if (next !== null) setNotice(`${t.pasted} ${clip.length}`)
      }, [act, t])

      const controls = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', flexWrap: 'wrap' },
      },
      h('span', {
        style: {
          ...TONES[label.tone],
          borderRadius: 999,
          padding: '1px 8px',
          fontSize: 11,
          lineHeight: '18px',
          fontWeight: 500,
        },
      }, label.text),
      h(ToolbarButton, {
        label: running ? t.restart : t.start,
        primary: !running,
        disabled: busy,
        onClick: () => void run(running ? '/dsh-browser-panel/restart' : '/dsh-browser-panel/start'),
      }),
      h(ToolbarButton, {
        label: t.stop,
        disabled: busy || !running,
        onClick: () => void run('/dsh-browser-panel/stop'),
      }),
      status?.pid === null || status?.pid === undefined
        ? null
        : h('span', { style: { fontSize: 11, color: 'var(--dsw-text-tertiary, #9ca3af)' } }, `pid ${status.pid}`),
      )

      const navButton = (label, path) => h(ToolbarButton, {
        label,
        disabled: busy || !running,
        onClick: () => void act(path),
      })

      const nav = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 4, padding: '0 8px 6px', flexWrap: 'wrap' },
      },
      navButton(t.back, '/dsh-browser-panel/back'),
      navButton(t.forward, '/dsh-browser-panel/forward'),
      navButton(t.reload, '/dsh-browser-panel/reload'),
      h('input', {
        ref: inputRef,
        value: address,
        placeholder: t.addressPlaceholder,
        spellCheck: false,
        disabled: !running,
        onChange: (event) => setAddress(event.target.value),
        onKeyDown: (event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          void navigate()
        },
        style: {
          flex: 1,
          minWidth: 120,
          border: '1px solid var(--dsw-border-strong, rgba(120, 120, 120, .35))',
          background: 'transparent',
          color: 'var(--dsw-text-primary, inherit)',
          borderRadius: 6,
          padding: '4px 8px',
          fontSize: 12,
          lineHeight: '18px',
          outline: 'none',
        },
      }),
      h(ToolbarButton, { label: t.paste, disabled: !running, onClick: () => void pasteText() }),
      )

      const strip = error === null && notice === null ? null : h('div', {
        style: {
          padding: '0 10px 6px',
          fontSize: 11,
          lineHeight: '16px',
          wordBreak: 'break-word',
          color: error === null ? 'var(--dsw-text-tertiary, #9ca3af)' : 'var(--dsw-danger-fg, #dc2626)',
        },
      }, error ?? notice)

      const body = () => {
        if (error !== null && status === null) {
          return h('div', { style: { padding: 12, fontSize: 12, color: 'var(--dsw-danger-fg, #dc2626)' } }, error)
        }
        if (!running) {
          const detail = error !== null
            ? error
            : status?.error ?? (state === 'starting' ? t.starting : state === 'stopping' ? t.stopping : t.hint)
          return h('div', {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              alignItems: 'center',
              justifyContent: 'center',
              padding: 16,
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--dsw-text-secondary, #6b7280)',
              height: '100%',
              boxSizing: 'border-box',
            },
          },
          h(ToolbarButton, {
            label: t.start,
            primary: true,
            disabled: busy,
            onClick: () => void run('/dsh-browser-panel/start'),
          }),
          h('div', { style: { maxWidth: 260, lineHeight: '18px' } }, detail))
        }
        if (!novncReady) {
          return h('div', { style: { padding: 12, fontSize: 12, color: 'var(--dsw-danger-fg, #dc2626)' } }, t.unavailable)
        }
        return h('iframe', {
          key: frameKey,
          title: 'Chromium',
          src: frameSource,
          style: { border: 0, width: '100%', height: '100%', display: 'block', background: '#0b0b0b' },
          allow: 'clipboard-read; clipboard-write',
        })
      }

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          minHeight: 0,
          background: 'var(--dsw-fill-primary-quaternary, transparent)',
        },
      },
      controls,
      nav,
      strip,
      h('div', { style: { flex: 1, minHeight: 0, position: 'relative' } }, body()))
    }

    function PanelTitle() {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, text().title)
    }

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          // 切换 tab 时保持挂载：卸载会关闭 iframe，重开等于重新建立 RFB 连接。
          keepMounted: true,
          priority: 'extension',
          title: () => text().title,
          guide: [{
            id: 'open',
            order: 60,
            title: () => text().title,
            description: () => text().description,
          }],
        }), 'dsh-browser-panel: tab type')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
          inject: (sessionId) => ({ sessionId }),
        }, (props) => h(PanelBoundary, null, h(BrowserPanel, props)))), 'dsh-browser-panel: tab body')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: ID,
        }, PanelTitle)), 'dsh-browser-panel: tab title')
      } catch (error) {
        console.error('[dsh-browser-panel] registration failed:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
