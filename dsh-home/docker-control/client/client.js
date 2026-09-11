window.__ModuleLoader__.load({
  id: 'dsh-docker-control',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { createPortal } = require('react-dom')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, Toast, IconRefreshOutline14 } = primitives

    const NS = 'dsh-docker-control'
    const h = React.createElement
    const inject = ['slots', 'locale', 'layout']
    let dshInfoCache = null
    let dshInfoRequest = null
    let dshLatestCache = null
    // Set by apply(): the shell's own sidebar toggle lives in ctx.layout, and
    // the floating opener is rendered by a module-scope component.
    let toggleSidebar = null

    // 重启和更新等的是同一件事：DSH 换进程之后 boot 标识才会变化，所以两处必须共用
    // 一个预算。原先重启路径写 60 秒、更新路径写 90 秒，重启稍慢一点（Supervisor 要
    // 先跑 prepare_dsh，再冷启动 DSH）就会误报「重启失败」——而进程其实已经换掉了。
    // 90 秒与 /usr/local/bin/restart-dsh wait-ready 的默认值一致。
    const BOOT_WAIT_MILLISECONDS = 90000

    const UI_MODE_STORAGE_KEY = 'dsh-docker-control.ui-mode'
    const UI_MODE_STYLE_ID = 'dsh-docker-control-ui-mode'
    // The container metrics card: a live cpu / memory / network / disk readout
    // pinned to the empty strip at the bottom of the sidebar, above Settings.
    const METRICS_PATH = '/dsh-docker-control/metrics'
    // nginx 只把固定白名单里的插件路径改写成回环请求，老镜像的白名单里没有
    // /metrics，但 /info 在。第一次采样若被拒就改用这条已放行的路径，并记住
    // 结果，之后不再重试第一条，免得每 2 秒多打一次 403。
    const METRICS_FALLBACK_PATH = '/dsh-docker-control/info?metrics=1'
    let metricsPath = METRICS_PATH
    const METRICS_STORAGE_KEY = 'dsh-docker-control.container-metrics'
    const METRICS_POLL_MILLISECONDS = 2000
    // 30 samples at the default interval is a one minute window.
    const METRICS_HISTORY = 30
    // Below this the rail is the collapsed icon strip and a card cannot fit.
    const METRICS_MIN_SIDEBAR_WIDTH = 140
    const UI_MODE_CSS = `/* Phone layout: the shipped shell is desktop-first (a fixed 800px settings
   panel with a 188px nav rail, and a sidebar that squeezes the center column).
   These overrides use structural selectors only, because the app's own class
   names are CSS-module hashes: the settings panel is the only dialog with a
   direct <nav> child, and the three-column frame is the only element with a
   direct [data-shell-overlay] child. */

/* --- Settings panel: full screen, nav rail becomes a top tab strip --- */
html[data-dsh-ui-mode="mobile"] div[role="dialog"][aria-modal="true"]:has(> nav) {
  flex-direction: column;
  width: 100vw;
  max-width: 100vw;
  height: 100dvh;
  max-height: 100dvh;
  border-radius: 0;
}

html[data-dsh-ui-mode="mobile"] div[role="dialog"][aria-modal="true"]:has(> nav) > nav {
  width: 100%;
  flex: none;
  gap: 10px;
  padding: 14px 8px 0;
}

/* The nav heading stays in the tree: the dialog's accessible name points at
   it through aria-labelledby. */
html[data-dsh-ui-mode="mobile"] div[role="dialog"][aria-modal="true"]:has(> nav) > nav > :first-child {
  padding: 0 8px;
}

html[data-dsh-ui-mode="mobile"] div[role="dialog"][aria-modal="true"]:has(> nav) > nav > :last-child {
  flex-direction: row;
  gap: 6px;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 4px;
  scroll-padding-inline: 8px;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
  /* The strip always overflows a phone width, so the bar stays visible: it is
     the only hint that the pages past the fold are reachable by swiping.
     A declared ::-webkit-scrollbar height also opts Blink/WebKit out of
     touch overlay bars, which are invisible until the finger moves. */
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, rgba(0, 0, 0, .2)) transparent;
}

html[data-dsh-ui-mode="mobile"] div[role="dialog"][aria-modal="true"]:has(> nav) > nav > :last-child::-webkit-scrollbar {
  height: 4px;
}

html[data-dsh-ui-mode="mobile"] div[role="dialog"][aria-modal="true"]:has(> nav) > nav > :last-child::-webkit-scrollbar-track {
  background: transparent;
}

html[data-dsh-ui-mode="mobile"] div[role="dialog"][aria-modal="true"]:has(> nav) > nav > :last-child::-webkit-scrollbar-thumb {
  border-radius: 2px;
  background: var(--dsw-alias-scrollbar-bg-l2, rgba(0, 0, 0, .2));
}

html[data-dsh-ui-mode="mobile"] div[role="dialog"][aria-modal="true"]:has(> nav) > nav > :last-child > button {
  flex: none;
  height: 36px;
  padding: 7px 14px;
}

html[data-dsh-ui-mode="mobile"] div[role="dialog"][aria-modal="true"]:has(> nav) > div {
  min-height: 0;
}

html[data-dsh-ui-mode="mobile"] div[role="dialog"][aria-modal="true"]:has(> nav) > div > :first-child {
  padding: 12px 12px 4px;
  height: auto;
}

html[data-dsh-ui-mode="mobile"] div[role="dialog"][aria-modal="true"]:has(> nav) > div > :last-child {
  padding: 0 12px 20px;
}

/* --- App frame: the sidebar is a drawer, never a layout column --- */
html[data-dsh-ui-mode="mobile"] div:has(> [data-shell-overlay]) {
  grid-template-columns: 0 minmax(0, 1fr) 0 !important;
}

/* Pin the three columns to their tracks. Lifting the sidebar out of flow (the
   drawer rule below) otherwise lets grid auto-placement slide the remaining
   items one track left, which hands the conversation's track to the details
   panel — the frame's child order is sidebar, conversation, details, then the
   absolutely positioned overlay layer and drag handles. */
html[data-dsh-ui-mode="mobile"] div:has(> [data-shell-overlay]) > :nth-child(1) {
  grid-area: 1 / 1;
}

html[data-dsh-ui-mode="mobile"] div:has(> [data-shell-overlay]) > :nth-child(2) {
  grid-area: 1 / 2;
}

html[data-dsh-ui-mode="mobile"] div:has(> [data-shell-overlay]) > :nth-child(3) {
  grid-area: 1 / 3;
}

/* Open: the panel floats over the conversation instead of squeezing it. Its
   own inline width (the shell freezes the expanded layout) decides the
   drawer width. */
html[data-dsh-ui-mode="mobile"] div:has(> [data-shell-overlay]):not([data-sidebar-collapsed]) > :first-child {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: auto;
  z-index: 15;
  overflow: visible;
  box-shadow: var(--dsw-shadow-lv3, 0 16px 48px rgba(0, 0, 0, .22));
}

/* Closed: the shell's 56px control rail would spend a seventh of a phone
   screen on icons, so the zero-width track clips it away and the floating
   opener below takes over. The column keeps its box (its subtree hosts the
   position: fixed settings dialog, which must survive the collapse) — only
   the 1px column seam has to go. */
html[data-dsh-ui-mode="mobile"] div:has(> [data-shell-overlay])[data-sidebar-collapsed] > :first-child {
  border-right: none;
}

/* Column resize handles are pointer-only affordances. */
html[data-dsh-ui-mode="mobile"] div:has(> [data-shell-overlay]) > [data-side] {
  display: none;
}

/* --- The floating drawer opener. It is mounted on every layout (the frame's
   own overlay seat) and paints only while the phone layout has the drawer
   closed, because the shell's toggle is inside the rail that just went away.
   The display property is owned here, never inline, so these rules stay in
   charge. --- */
[data-dsh-mobile-sidebar-toggle] {
  display: none;
}

html[data-dsh-ui-mode="mobile"] div:has(> [data-shell-overlay])[data-sidebar-collapsed] [data-dsh-mobile-sidebar-toggle] {
  display: inline-flex;
}

/* --- The container metrics card. It sits in the sidebar's empty bottom strip,
   directly above the settings entry, and paints only while the rail is
   expanded: a collapsed rail is a ~56px icon strip with no room for it. As
   with the drawer opener, the display property is owned here rather than
   inline, so the measurement in JS and these rules cannot disagree. --- */
[data-dsh-container-metrics] {
  display: none;
}

div:has(> [data-shell-overlay]):not([data-sidebar-collapsed]) [data-dsh-container-metrics] {
  display: flex;
}
`

    function hasDom() {
      return typeof document !== 'undefined' && document !== null && document.documentElement != null
    }

    // No stored choice yet: the browser that opened the page decides. Phone
    // user agents pick the phone layout; a narrow window does too, which is
    // what catches iPadOS (it reports a desktop user agent).
    function detectUiMode() {
      const agent = typeof navigator === 'undefined' || navigator === null ? '' : String(navigator.userAgent || '')
      if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Silk/i.test(agent)) return 'mobile'
      const width = typeof window !== 'undefined' && window !== null ? window.innerWidth : undefined
      return typeof width === 'number' && width > 0 && width < 900 ? 'mobile' : 'desktop'
    }

    function storedUiMode() {
      try {
        const value = window.localStorage.getItem(UI_MODE_STORAGE_KEY)
        return value === 'mobile' || value === 'desktop' ? value : null
      } catch {
        return null
      }
    }

    function resolveUiMode() {
      return storedUiMode() ?? detectUiMode()
    }

    function applyUiMode(mode) {
      if (!hasDom()) return mode
      document.documentElement.setAttribute('data-dsh-ui-mode', mode)
      if (document.getElementById(UI_MODE_STYLE_ID) === null) {
        const style = document.createElement('style')
        style.id = UI_MODE_STYLE_ID
        style.textContent = UI_MODE_CSS
        document.head.appendChild(style)
      }
      return mode
    }

    // The layout is a property of the device in front of the user, not of the
    // account, so it stays in this browser's storage.
    function storeUiMode(mode) {
      try { window.localStorage.setItem(UI_MODE_STORAGE_KEY, mode) } catch {}
      return applyUiMode(mode)
    }

    const zh = {
      restart: '重启 DSH',
      confirm: '确认重启 DSH？当前进行中的请求可能会短暂中断。',
      requesting: '正在安排重启…',
      scheduled: '已安排 DSH 重启，等待服务恢复…',
      restored: 'DSH 已重新启动',
      failed: '重启失败',
      timeout: '服务未在 60 秒内完成新一轮启动',
      openConfig: '打开配置文件',
      configTitle: '编辑配置文件',
      configDescription: '修改后保存会写入 DSH 的 settings.yaml；配置语法错误不会保存。',
      configLoading: '正在读取配置文件…',
      configSave: '保存配置',
      configCancel: '取消',
      configSaving: '正在保存…',
      configSaved: '配置已保存',
      configLoadFailed: '读取配置文件失败',
      configSaveFailed: '保存配置文件失败',
      configConflict: '配置文件已在其他地方修改，请重新打开后再保存。',
      navTitle: 'DSH 环境',
      versionTitle: 'DSH 版本',
      currentVersion: '当前版本',
      latestVersion: '最新版本',
      packageLabel: 'npm 包',
      notChecked: '未检查',
      loading: '正在读取…',
      checkUpdate: '检查更新',
      checking: '正在检查…',
      upToDate: '已是最新版本',
      updateAvailableText: '有新版本可用',
      checkFailed: '检查更新失败',
      updateHint: '打开本页不会自动联网检查；更新会在容器内从 npm 安装上游预构建包并重新打上本项目的补丁，完成后只重启 DSH 进程，容器和你 apt 装的工具链都保留。',
      layoutTitle: '界面布局',
      layoutDesktop: '电脑 UI',
      layoutMobile: '手机 UI',
      layoutHint: '首次访问按浏览器 UA 自动选择；这里的选择只对当前浏览器生效。',
      openSidebar: '展开侧边栏',
      metricsTitle: '容器监控',
      metricsToggle: '在侧边栏显示实时监控',
      metricsHint: '只读取本容器的 cgroup 统计（CPU、内存、网络上下行、磁盘读写），每 2 秒采样一次，画在侧边栏底部、设置按钮上方。关掉后不再显示也不再轮询，开关按浏览器保存。',
      metricsCpu: 'CPU',
      metricsMemory: '内存',
      metricsNet: '网络',
      metricsDisk: '磁盘',
      metricsDown: '下行',
      metricsUp: '上行',
      metricsRead: '读',
      metricsWrite: '写',
      metricsWarming: '正在采样…',
      metricsUnavailable: '读不到',
      systemTitle: '容器环境',
      updateDsh: '立即更新',
      confirmUpdate: '确认更新 DSH？安装完成后 DSH 进程会重启。',
      updateQueued: '正在准备更新…',
      updateInstalling: '正在从 npm 安装预构建包并打补丁…',
      updateSwapping: '正在替换运行时并校验 Nginx 配置…',
      updateRestarting: '正在重启 DSH…',
      updateSuccess: 'DSH 已更新并重启',
      updateFailed: 'DSH 更新失败',
      updateTimeout: 'DSH 未在 90 秒内完成重启',
      dshInfoFailed: '读取 DSH 版本失败',
    }

    const en = {
      restart: 'Restart DSH',
      confirm: 'Restart DSH? Active requests may be briefly interrupted.',
      requesting: 'Scheduling restart…',
      scheduled: 'DSH restart scheduled; waiting for the service…',
      restored: 'DSH restarted',
      failed: 'Restart failed',
      timeout: 'The service did not report a new boot within 60 seconds',
      openConfig: 'Open configuration file',
      configTitle: 'Edit configuration file',
      configDescription: 'Saving writes DSH settings.yaml; invalid configuration is rejected.',
      configLoading: 'Reading configuration file…',
      configSave: 'Save configuration',
      configCancel: 'Cancel',
      configSaving: 'Saving…',
      configSaved: 'Configuration saved',
      configLoadFailed: 'Could not read configuration file',
      configSaveFailed: 'Could not save configuration file',
      configConflict: 'The configuration changed elsewhere. Reopen it before saving.',
      navTitle: 'DSH environment',
      versionTitle: 'DSH version',
      currentVersion: 'Installed',
      latestVersion: 'Latest',
      packageLabel: 'npm package',
      notChecked: 'Not checked',
      loading: 'Reading…',
      checkUpdate: 'Check for updates',
      checking: 'Checking…',
      upToDate: 'Up to date',
      updateAvailableText: 'A newer version is available',
      checkFailed: 'Update check failed',
      updateHint: 'Opening this page never checks online. An update installs the upstream prebuilt packages from npm inside the container, re-applies this project\'s patches, and restarts only the DSH process — the container and the toolchains you installed with apt are kept.',
      layoutTitle: 'Interface layout',
      layoutDesktop: 'Desktop UI',
      layoutMobile: 'Phone UI',
      layoutHint: 'The first visit picks a layout from the browser user agent; this choice applies to this browser only.',
      openSidebar: 'Open the sidebar',
      metricsTitle: 'Container metrics',
      metricsToggle: 'Show live metrics in the sidebar',
      metricsHint: 'Reads only this container\'s cgroup accounting (CPU, memory, network up/down, disk read/write), sampled every 2 seconds into the sidebar strip above the settings entry. Turning it off hides the strip and stops the polling. Stored per browser.',
      metricsCpu: 'CPU',
      metricsMemory: 'Memory',
      metricsNet: 'Network',
      metricsDisk: 'Disk',
      metricsDown: 'down',
      metricsUp: 'up',
      metricsRead: 'read',
      metricsWrite: 'write',
      metricsWarming: 'Sampling…',
      metricsUnavailable: 'unavailable',
      systemTitle: 'Container environment',
      updateDsh: 'Update now',
      confirmUpdate: 'Update DSH? The DSH process restarts once the install completes.',
      updateQueued: 'Preparing the update…',
      updateInstalling: 'Installing the prebuilt packages from npm and applying patches…',
      updateSwapping: 'Swapping the runtime and validating the Nginx configuration…',
      updateRestarting: 'Restarting DSH…',
      updateSuccess: 'DSH updated and restarted',
      updateFailed: 'DSH update failed',
      updateTimeout: 'DSH did not restart within 90 seconds',
      dshInfoFailed: 'Could not read DSH version',
    }

    function fallbackText(key) {
      const language = typeof document === 'undefined' ? 'en' : document.documentElement.lang
      return (language && language.toLowerCase().startsWith('zh') ? zh : en)[key] || key
    }

    function translate(t, key) {
      try {
        const value = typeof t === 'function' ? t(key) : undefined
        return typeof value === 'string' && value.length > 0 ? value : fallbackText(key)
      } catch {
        return fallbackText(key)
      }
    }

    async function readJson(response) {
      const raw = await response.text()
      if (raw.length === 0) return {}
      try {
        return JSON.parse(raw)
      } catch {
        const summary = raw.replace(/\s+/g, ' ').trim().slice(0, 180)
        throw new Error(`HTTP ${response.status}: ${summary || 'invalid response'}`)
      }
    }

    function requestDshInfo(force = false) {
      if (!force && dshInfoCache !== null) return Promise.resolve(dshInfoCache)
      if (!force && dshInfoRequest !== null) return dshInfoRequest
      const request = fetch('/dsh-docker-control/info', { cache: 'no-store' })
        .then(async response => {
          const body = await readJson(response)
          if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`)
          dshInfoCache = body
          return body
        })
      dshInfoRequest = request
      request.finally(() => {
        if (dshInfoRequest === request) dshInfoRequest = null
      }).catch(() => {})
      return request
    }

    function requestDshLatest() {
      // Always force: the button IS the user's explicit request for fresh data.
      return fetch('/dsh-docker-control/update/latest?force=1', { cache: 'no-store' })
        .then(async response => {
          const body = await readJson(response)
          if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`)
          dshLatestCache = body
          return body
        })
    }

    function describeError(cause) {
      return String(cause && cause.message ? cause.message : cause)
    }

    function formatVersion(version) {
      return typeof version === 'string' && version.length > 0 ? version : 'unknown'
    }

    /** 运行时是哪个 npm 包、跟哪个 dist-tag。检查前 tag 未知，只显示包名。 */
    function formatPackage(name, tag) {
      const label = typeof name === 'string' && name.length > 0 ? name : '@deepseek-ai/dsh'
      return typeof tag === 'string' && tag.length > 0 ? `${label} (${tag})` : label
    }

    const cardStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      margin: 0,
      padding: 0,
      border: 'none',
    }

    const cardTitleStyle = {
      margin: 0,
      fontSize: '14px',
      lineHeight: '22px',
      fontWeight: 500,
      color: 'var(--dsw-alias-label-primary, #111827)',
    }

    const fieldLabelStyle = {
      margin: 0,
      fontSize: '13px',
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary, #6b7280)',
    }

    const fieldValueStyle = {
      margin: 0,
      fontSize: '13px',
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary, #111827)',
      wordBreak: 'break-word',
    }

    const hintStyle = {
      margin: 0,
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary, #6b7280)',
    }

    function renderButton(variant, disabled, onClick, label) {
      return typeof Button === 'function'
        ? h(Button, { key: label, variant, size: 'sm', disabled, onClick }, label)
        : h('button', { key: label, type: 'button', disabled, onClick }, label)
    }

    // The two-cell selector: the chosen cell is the lit surface inside the box.
    function renderModeOption(mode, active, select, label) {
      const selected = active === mode
      return h('button', {
        key: mode,
        type: 'button',
        role: 'radio',
        'aria-checked': selected ? 'true' : 'false',
        'data-dsh-ui-mode-option': mode,
        onClick: () => { select(mode) },
        style: {
          minWidth: '96px',
          padding: '7px 16px',
          border: 'none',
          borderRadius: '10px',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: '13px',
          lineHeight: '20px',
          fontWeight: selected ? 500 : 400,
          color: selected ? 'var(--dsw-alias-label-primary, #111827)' : 'var(--dsw-alias-label-secondary, #6b7280)',
          background: selected ? 'var(--dsw-alias-bg-layer-2, #fff)' : 'transparent',
          boxShadow: selected ? 'var(--dsw-shadow-lv1, 0 1px 3px rgba(0, 0, 0, .12))' : 'none',
        },
      }, label)
    }

    class RestartActionBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error, info) {
        console.error('[dsh-docker-control] action render failed:', error, info && info.componentStack)
      }

      render() {
        return this.state.failed ? null : this.props.children
      }
    }

    function RestartAction({ t }) {
      const [state, setState] = React.useState('idle')
      const [toast, setToast] = React.useState(null)
      const sequence = React.useRef(0)

      const show = React.useCallback((message) => {
        sequence.current += 1
        setToast({ key: sequence.current, message })
      }, [])

      const dismissToast = React.useCallback(() => { setToast(null) }, [])

      const waitForBoot = React.useCallback((previous) => {
        const deadline = Date.now() + BOOT_WAIT_MILLISECONDS
        const poll = () => {
          if (Date.now() > deadline) {
            setState('idle')
            show(`${translate(t, 'failed')}: ${translate(t, 'timeout')}`)
            return
          }
          fetch('/dsh-docker-control/status', { cache: 'no-store' })
            .then(async (response) => {
              const body = await readJson(response)
              if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
              return body
            })
            .then((body) => {
              if (typeof body.boot === 'string' && body.boot !== previous) {
                setState('idle')
                show(translate(t, 'restored'))
                window.setTimeout(() => { window.location.reload() }, 900)
                return
              }
              window.setTimeout(poll, 1000)
            })
            .catch(() => { window.setTimeout(poll, 1000) })
        }
        poll()
      }, [show, t])

      const restart = React.useCallback(() => {
        if (state !== 'idle') return
        if (typeof window.confirm === 'function' && !window.confirm(translate(t, 'confirm'))) return
        setState('requesting')
        fetch('/dsh-docker-control/status', { cache: 'no-store' })
          .then(async (response) => {
            const body = await readJson(response)
            if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
            return body
          })
          .then((before) => {
            show(translate(t, 'requesting'))
            return fetch('/dsh-docker-control/restart', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            }).then(async (response) => {
              const body = await readJson(response)
              if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`)
              setState('waiting')
              show(translate(t, 'scheduled'))
              waitForBoot(typeof before.boot === 'string' ? before.boot : '')
            })
          })
          .catch((error) => {
            setState('idle')
            show(`${translate(t, 'failed')}: ${String(error && error.message ? error.message : error)}`)
          })
      }, [state, t, show, waitForBoot])

      const label = state === 'requesting'
        ? translate(t, 'requesting')
        : state === 'waiting'
          ? translate(t, 'scheduled')
          : translate(t, 'restart')
      const icon = typeof IconRefreshOutline14 === 'function' ? h(IconRefreshOutline14, { size: 14 }) : undefined
      const button = typeof Button === 'function'
        ? h(Button, {
            variant: 'outline',
            size: 'sm',
            icon,
            disabled: state !== 'idle',
            onClick: restart,
          }, label)
        : h('button', {
            type: 'button',
            disabled: state !== 'idle',
            onClick: restart,
          }, label)
      const notice = toast === null
        ? null
        : typeof Toast === 'function'
          ? h(Toast, { key: toast.key, text: toast.message, onDone: dismissToast })
          : h('span', { key: toast.key, role: 'status' }, toast.message)

      return h(React.Fragment, null, button, notice)
    }

    function SafeRestartAction(props) {
      return h(RestartActionBoundary, null, h(RestartAction, props))
    }

    function DshEnvironmentSection({ t }) {
      const [info, setInfo] = React.useState(dshInfoCache)
      const [infoPhase, setInfoPhase] = React.useState(dshInfoCache === null ? 'loading' : 'idle')
      const [infoError, setInfoError] = React.useState(null)
      const [latest, setLatest] = React.useState(dshLatestCache)
      const [checking, setChecking] = React.useState(false)
      const [checkError, setCheckError] = React.useState(null)
      const [phase, setPhase] = React.useState('idle')
      const [error, setError] = React.useState(null)
      const [uiMode, setUiMode] = React.useState(resolveUiMode())

      // The local build metadata is a file read inside the container, so the
      // current version loads with the page. The remote check is NOT run here:
      // it reaches github, and settings must never do that unasked.
      const loadInfo = React.useCallback((force = false) => {
        if (dshInfoCache === null) setInfoPhase('loading')
        return requestDshInfo(force)
          .then(body => {
            setInfo(body)
            setInfoPhase('idle')
            setInfoError(null)
          })
          .catch(cause => {
            setInfoPhase('idle')
            setInfoError(`${translate(t, 'dshInfoFailed')}: ${describeError(cause)}`)
          })
      }, [t])

      React.useEffect(() => { loadInfo() }, [loadInfo])

      const check = React.useCallback(() => {
        if (checking) return
        setChecking(true)
        setCheckError(null)
        requestDshLatest()
          .then(body => {
            setLatest(body)
            setChecking(false)
          })
          .catch(cause => {
            setChecking(false)
            setCheckError(`${translate(t, 'checkFailed')}: ${describeError(cause)}`)
          })
      }, [checking, t])

      const waitForBoot = React.useCallback(previousBoot => {
        const deadline = Date.now() + BOOT_WAIT_MILLISECONDS
        const poll = () => {
          if (Date.now() > deadline) {
            setPhase('idle')
            setError(translate(t, 'updateTimeout'))
            return
          }
          fetch('/dsh-docker-control/status', { cache: 'no-store' })
            .then(async response => {
              const body = await readJson(response)
              if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
              return body
            })
            .then(body => {
              if (typeof body.boot === 'string' && body.boot !== previousBoot) {
                setPhase('idle')
                setError(null)
                loadInfo(true)
                window.setTimeout(() => { window.location.reload() }, 900)
                return
              }
              window.setTimeout(poll, 1000)
            })
            .catch(() => { window.setTimeout(poll, 1000) })
        }
        poll()
      }, [loadInfo, t])

      const pollUpdate = React.useCallback(previousBoot => {
        const poll = () => {
          fetch('/dsh-docker-control/update/status', { cache: 'no-store' })
            .then(async response => {
              const body = await readJson(response)
              if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
              return body
            })
            .then(body => {
              if (body.state === 'failed') {
                setPhase('idle')
                setError(`${translate(t, 'updateFailed')}: ${body.message || ''}`)
                return
              }
              if (body.state === 'success') {
                setPhase('restarting')
                waitForBoot(previousBoot)
                return
              }
              // update-dsh 的状态文案就是进度来源：安装阶段最长，替换阶段最短。
              const message = typeof body.message === 'string' ? body.message : ''
              if (message.startsWith('正在安装')) setPhase('installing')
              else if (message.startsWith('正在原子替换')) setPhase('swapping')
              else setPhase('running')
              window.setTimeout(poll, 1000)
            })
            .catch(() => { window.setTimeout(poll, 1000) })
        }
        poll()
      }, [t, waitForBoot])

      const update = React.useCallback(() => {
        if (phase !== 'idle') return
        if (typeof window.confirm === 'function' && !window.confirm(translate(t, 'confirmUpdate'))) return
        setPhase('starting')
        setError(null)
        fetch('/dsh-docker-control/status', { cache: 'no-store' })
          .then(async response => {
            const body = await readJson(response)
            if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
            return body
          })
          .then(before => fetch('/dsh-docker-control/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }).then(async response => {
            const body = await readJson(response)
            if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`)
            pollUpdate(typeof before.boot === 'string' ? before.boot : '')
          }))
          .catch(cause => {
            setPhase('idle')
            setError(`${translate(t, 'updateFailed')}: ${describeError(cause)}`)
          })
      }, [phase, pollUpdate, t])

      const selectUiMode = React.useCallback(mode => { setUiMode(storeUiMode(mode)) }, [])

      const currentVersion = infoPhase === 'loading'
        ? translate(t, 'loading')
        : formatVersion(info?.dsh?.version)
      const latestVersion = checking
        ? translate(t, 'checking')
        : latest === null
          ? translate(t, 'notChecked')
          : formatVersion(latest.latest?.version)
      const verdict = latest === null || checking
        ? null
        : latest.updateAvailable === true
          ? translate(t, 'updateAvailableText')
          : latest.updateAvailable === false
            ? translate(t, 'upToDate')
            : null
      const progress = phase === 'starting' || phase === 'running'
        ? translate(t, 'updateQueued')
        : phase === 'installing'
          ? translate(t, 'updateInstalling')
          : phase === 'swapping'
            ? translate(t, 'updateSwapping')
            : phase === 'restarting'
              ? translate(t, 'updateRestarting')
              : null
      const notice = error ?? checkError ?? infoError ?? null

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '20px' } },
        h('section', { style: cardStyle },
          h('h3', { style: cardTitleStyle }, translate(t, 'versionTitle')),
          h('dl', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, max-content) minmax(0, 1fr)', columnGap: '16px', rowGap: '8px', margin: 0 } },
            h('dt', { key: 'ck', style: fieldLabelStyle }, translate(t, 'currentVersion')),
            h('dd', { key: 'cv', style: fieldValueStyle }, currentVersion),
            h('dt', { key: 'lk', style: fieldLabelStyle }, translate(t, 'latestVersion')),
            h('dd', { key: 'lv', style: fieldValueStyle }, latestVersion),
            h('dt', { key: 'rk', style: fieldLabelStyle }, translate(t, 'packageLabel')),
            h('dd', { key: 'rv', style: fieldValueStyle }, formatPackage(info?.dsh?.package, latest?.tag)),
          ),
          verdict === null ? null : h('p', { role: 'status', style: { margin: 0, fontSize: '13px', color: latest?.updateAvailable === true ? 'var(--dsw-alias-label-primary, #111827)' : 'var(--dsw-alias-label-secondary, #6b7280)' } }, verdict),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
            renderButton('outline', checking, check, checking ? translate(t, 'checking') : translate(t, 'checkUpdate')),
            renderButton('primary', phase !== 'idle', update, translate(t, 'updateDsh')),
          ),
          progress === null ? null : h('p', { role: 'status', style: hintStyle }, progress),
          notice === null ? null : h('p', { role: 'alert', style: { margin: 0, fontSize: '13px', color: '#b42318' } }, notice),
          h('p', { style: hintStyle }, translate(t, 'updateHint')),
        ),
        h('section', { style: cardStyle },
          h('h3', { style: cardTitleStyle }, translate(t, 'layoutTitle')),
          h('div', { role: 'radiogroup', 'aria-label': translate(t, 'layoutTitle'), style: {
            display: 'inline-flex',
            // The section is a stretch column: without this the two-cell box
            // would be pulled to the full page width.
            alignSelf: 'flex-start',
            gap: '4px',
            padding: '4px',
            borderRadius: '12px',
            border: '1px solid var(--dsw-alias-border-l2, #d9dde3)',
            background: 'var(--dsw-alias-bg-layer-1, #f5f6f8)',
          } },
            renderModeOption('desktop', uiMode, selectUiMode, translate(t, 'layoutDesktop')),
            renderModeOption('mobile', uiMode, selectUiMode, translate(t, 'layoutMobile')),
          ),
          h('p', { style: hintStyle }, translate(t, 'layoutHint')),
        ),
        h('section', { style: cardStyle },
          h('h3', { style: cardTitleStyle }, translate(t, 'systemTitle')),
          h('dl', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, max-content) minmax(0, 1fr)', columnGap: '16px', rowGap: '8px', margin: 0 } },
            h('dt', { key: 'dk', style: fieldLabelStyle }, 'Debian'),
            h('dd', { key: 'dv', style: fieldValueStyle }, info?.system?.debianVersion || '-'),
            h('dt', { key: 'nk', style: fieldLabelStyle }, 'Node.js'),
            h('dd', { key: 'nv', style: fieldValueStyle }, info?.system?.nodeVersion || '-'),
            h('dt', { key: 'pk', style: fieldLabelStyle }, 'Python'),
            h('dd', { key: 'pv', style: fieldValueStyle }, info?.system?.pythonVersion || '-'),
          ),
        ),
        h('section', { style: cardStyle },
          h('h3', { style: cardTitleStyle }, translate(t, 'metricsTitle')),
          h(MetricsSwitch, { t }),
          h('p', { style: hintStyle }, translate(t, 'metricsHint')),
        ),
      )
    }

    function SafeDshEnvironmentSection(props) {
      return h(RestartActionBoundary, null, h(DshEnvironmentSection, props))
    }

    // --- Container metrics ---------------------------------------------------
    // The switch lives on the DSH environment page, but the card is painted by
    // the shell overlay seat, so the preference is shared through this tiny
    // store instead of through component props.
    const metricsListeners = new Set()

    function metricsEnabled() {
      try {
        return window.localStorage.getItem(METRICS_STORAGE_KEY) !== 'off'
      } catch {
        return true
      }
    }

    function storeMetricsEnabled(enabled) {
      try {
        window.localStorage.setItem(METRICS_STORAGE_KEY, enabled ? 'on' : 'off')
      } catch {}
      for (const listener of metricsListeners) {
        try {
          listener(enabled)
        } catch {}
      }
      return enabled
    }

    function useMetricsEnabled() {
      const [enabled, setEnabled] = React.useState(metricsEnabled)
      React.useEffect(() => {
        metricsListeners.add(setEnabled)
        // Another tab may have flipped it while this one sat idle.
        setEnabled(metricsEnabled())
        return () => { metricsListeners.delete(setEnabled) }
      }, [])
      return [enabled, storeMetricsEnabled]
    }

    function formatAmount(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
      const units = ['B', 'K', 'M', 'G', 'T']
      let value = Math.abs(bytes)
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)}${units[unit]}`
    }

    function formatPerSecond(bytesPerSecond) {
      if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond)) return '—'
      return `${formatAmount(bytesPerSecond)}/s`
    }
    function formatPercent(percent) {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return '—'
      return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`
    }

    // One sample per poll, oldest first, so the sparkline scrolls away.
    function pushSample(values, value) {
      const next = values.slice(-(METRICS_HISTORY - 1))
      const usable = typeof value === 'number' && Number.isFinite(value)
      next.push(usable ? value : values.length > 0 ? values[values.length - 1] : 0)
      return next
    }

    // 一次采样。第一条路径被 Web 层拒掉时改用白名单里的那条，并把选择记在
    // 会话里：能直接答 /metrics 的部署不会为此多付一次探测请求。
    async function sampleMetrics() {
      const read = async path => {
        const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' })
        const body = await readJson(response)
        if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`)
        return body
      }
      if (metricsPath === METRICS_FALLBACK_PATH) return read(metricsPath)
      try {
        return await read(METRICS_PATH)
      } catch (error) {
        metricsPath = METRICS_FALLBACK_PATH
        console.info('[dsh-docker-control] metrics route refused, using the whitelisted path instead:', describeError(error))
        return read(METRICS_FALLBACK_PATH)
      }
    }

    function useContainerMetrics(enabled) {
      const [state, setState] = React.useState({
        data: null,
        failed: false,
        history: { cpu: [], memory: [], rx: [], tx: [], read: [], write: [] },
      })
      React.useEffect(() => {
        if (!enabled) return undefined
        let stopped = false
        const tick = async () => {
          // A hidden tab is not being watched: skip the sample rather than
          // filling the window with a flat line.
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          try {
            const body = await sampleMetrics()
            if (stopped) return
            setState(before => ({
              data: body,
              failed: false,
              history: {
                cpu: pushSample(before.history.cpu, body.cpu && body.cpu.percent),
                memory: pushSample(before.history.memory, body.memory && body.memory.usedBytes),
                // One series per direction: the network and disk quadrants
                // draw both lines, not a single summed one.
                rx: pushSample(before.history.rx, body.network && body.network.rxBytesPerSec),
                tx: pushSample(before.history.tx, body.network && body.network.txBytesPerSec),
                read: pushSample(before.history.read, body.disk && body.disk.readBytesPerSec),
                write: pushSample(before.history.write, body.disk && body.disk.writeBytesPerSec),
              },
            }))
          } catch (error) {
            if (stopped) return
            console.warn('[dsh-docker-control] metrics sample failed:', describeError(error))
            setState(before => ({ ...before, failed: true }))
          }
        }
        tick()
        const timer = window.setInterval(tick, METRICS_POLL_MILLISECONDS)
        // A hidden tab skips its samples, so re-read the moment it is watched
        // again: otherwise a sample that failed while the tab was in the
        // background keeps the card on its failure text.
        const onVisibilityChange = () => {
          if (document.visibilityState === 'visible') tick()
        }
        document.addEventListener('visibilitychange', onVisibilityChange)
        return () => {
          stopped = true
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibilityChange)
        }
      }, [enabled])
      return state
    }

    /**
     * Where the card belongs: the sidebar column's empty bottom strip, just
     * above the settings entry. The frame, the rail and that entry are found
     * structurally, because the app's own class names are CSS-module hashes —
     * the same reason the stylesheet only uses structural selectors.
     */
    function metricsGeometry() {
      if (!hasDom()) return null
      // The settings panel is a modal dialog (the same structural marker the
      // stylesheet uses). On a phone it opens from the drawer while the drawer
      // itself stays mounted, so the card steps aside instead of floating over
      // the panel it is configured on.
      if (document.querySelector('div[role="dialog"][aria-modal="true"]') !== null) return null
      const frame = document.querySelector('div:has(> [data-shell-overlay])')
      if (frame === null || frame.hasAttribute('data-sidebar-collapsed')) return null
      const sidebar = frame.firstElementChild
      if (sidebar === null || sidebar === undefined) return null
      const rect = sidebar.getBoundingClientRect()
      if (rect.width < METRICS_MIN_SIDEBAR_WIDTH || !(rect.height > 0)) return null
      const rail = sidebar.firstElementChild === null ? null : sidebar.firstElementChild.firstElementChild
      const settingsRow = rail === null ? null : rail.lastElementChild
      const settingsRect = settingsRow === null ? null : settingsRow.getBoundingClientRect()
      // A wider side inset than the vertical one: the card is as wide as the
      // rail allows, and hugging the rail's borders looked cramped.
      const insetX = 16
      const insetY = 8
      return {
        left: Math.round(rect.left + insetX),
        width: Math.round(rect.width - insetX * 2),
        // Fall back to the rail's own bottom edge when the settings entry
        // cannot be measured: a fixed strip above the bottom is still correct.
        bottom: settingsRect !== null && settingsRect.height > 0
          ? Math.round(window.innerHeight - settingsRect.top + insetY)
          : Math.round(window.innerHeight - rect.bottom + 64),
      }
    }

    function useMetricsGeometry() {
      const [geometry, setGeometry] = React.useState(metricsGeometry)
      React.useEffect(() => {
        let handle = 0
        let stopped = false
        const measure = () => {
          handle = 0
          if (stopped) return
          const next = metricsGeometry()
          setGeometry(before => {
            const same = before === null || next === null
              ? before === next
              : before.left === next.left && before.width === next.width && before.bottom === next.bottom
            return same ? before : next
          })
        }
        const schedule = () => { if (handle === 0) handle = window.requestAnimationFrame(measure) }
        schedule()
        window.addEventListener('resize', schedule)
        // The drawer opens and closes without a resize event, so the geometry
        // is re-read on a slow timer too. It is one rect read per second.
        const timer = window.setInterval(schedule, 1000)
        return () => {
          stopped = true
          window.removeEventListener('resize', schedule)
          window.clearInterval(timer)
          if (handle !== 0) window.cancelAnimationFrame(handle)
        }
      }, [])
      return geometry
    }

    // A quadrant may carry one line (cpu, memory) or two (network: down and
    // up; disk: read and write). Both lines share one scale so they stay
    // comparable, and the SVG stretches to the cell so it can never run under
    // the numbers next to it.
    function MetricsSparkline({ series, height = 18 }) {
      const width = 56
      const max = series.reduce((top, line) => line.values.reduce((inner, value) => (value > inner ? value : inner), top), 0)
      const scale = max > 0 ? max : 1
      const step = line => (line.values.length > 1 ? width / (line.values.length - 1) : width)
      const points = line => line.values.map((value, index) => {
        const y = height - 1.5 - (value / scale) * (height - 3)
        return `${(index * step(line)).toFixed(1)},${Math.min(height - 1, Math.max(1, y)).toFixed(1)}`
      }).join(' ')
      return h('svg', {
        width: '100%',
        height,
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: 'none',
        'aria-hidden': 'true',
        style: { display: 'block', width: '100%', height: `${height}px`, flex: 'none', overflow: 'hidden' },
      }, series.map((line, index) => (line.values.length > 1
        ? h('polyline', {
          key: index,
          points: points(line),
          fill: 'none',
          stroke: line.color,
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        })
        : null)))
    }

    // One cell of the 2x2 grid: label and current value on the first line, the
    // second direction's value (when there is one) on the second, chart below.
    function MetricsQuadrant({ label, primary, secondary, series }) {
      const labelStyle = { fontSize: '10px', lineHeight: '14px', color: 'var(--dsw-alias-label-secondary, #6b7280)', flex: 'none' }
      const valueStyle = {
        fontSize: '11.5px',
        lineHeight: '14px',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-primary, #111827)',
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '6px', minWidth: 0 } },
          h('span', { style: labelStyle }, label),
          h('span', { style: valueStyle }, primary)),
        // Reserved even when empty, so the charts of all four cells line up.
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', minHeight: '14px', minWidth: 0 } },
          secondary === null || secondary === undefined ? null : h('span', { style: valueStyle }, secondary)),
        h(MetricsSparkline, { series }),
      )
    }

    function ContainerMetrics({ t }) {
      const [enabled] = useMetricsEnabled()
      const geometry = useMetricsGeometry()
      const metrics = useContainerMetrics(enabled)
      if (!enabled || geometry === null) return null
      const data = metrics.data
      const cpu = data === null ? {} : data.cpu
      const memory = data === null ? {} : data.memory
      const network = data === null ? {} : data.network
      const disk = data === null ? {} : data.disk
      const memoryValue = typeof memory.percent === 'number' && Number.isFinite(memory.percent)
        ? formatPercent(memory.percent)
        : formatAmount(memory.usedBytes)
      const status = metrics.failed
        ? translate(t, 'metricsUnavailable')
        : data === null ? translate(t, 'metricsWarming') : null
      return h('div', {
        'data-dsh-container-metrics': '',
        'aria-hidden': 'true',
        style: {
          position: 'fixed',
          left: `${geometry.left}px`,
          bottom: `${geometry.bottom}px`,
          width: `${geometry.width}px`,
          zIndex: 13,
          // Purely a readout: never swallow a click meant for the workspace
          // list that scrolls behind it.
          pointerEvents: 'none',
          flexDirection: 'column',
          gap: '6px',
          padding: '8px 10px',
          boxSizing: 'border-box',
          borderRadius: '12px',
          border: '1px solid var(--dsw-alias-border-l2, #d9dde3)',
          background: 'var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, .94))',
          boxShadow: 'var(--dsw-shadow-lv2, 0 4px 16px rgba(0, 0, 0, .12))',
          backdropFilter: 'blur(6px)',
        },
      },
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            fontSize: '11px',
            lineHeight: '14px',
            color: 'var(--dsw-alias-label-secondary, #6b7280)',
          },
        },
          h('span', null, translate(t, 'metricsTitle')),
          status === null ? null : h('span', null, status)),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '12px', rowGap: '10px' } },
          h(MetricsQuadrant, {
            label: translate(t, 'metricsCpu'),
            primary: data === null ? '—' : formatPercent(cpu.percent),
            series: [{ values: metrics.history.cpu, color: '#2f6feb' }],
          }),
          h(MetricsQuadrant, {
            label: translate(t, 'metricsMemory'),
            primary: data === null ? '—' : memoryValue,
            series: [{ values: metrics.history.memory, color: '#8b5cf6' }],
          }),
          h(MetricsQuadrant, {
            label: translate(t, 'metricsNet'),
            primary: data === null ? '—' : `↓${formatPerSecond(network.rxBytesPerSec)}`,
            secondary: data === null ? null : `↑${formatPerSecond(network.txBytesPerSec)}`,
            series: [
              { values: metrics.history.rx, color: '#10b981' },
              { values: metrics.history.tx, color: '#0d9488' },
            ],
          }),
          h(MetricsQuadrant, {
            label: translate(t, 'metricsDisk'),
            primary: data === null ? '—' : `${translate(t, 'metricsRead')} ${formatPerSecond(disk.readBytesPerSec)}`,
            secondary: data === null ? null : `${translate(t, 'metricsWrite')} ${formatPerSecond(disk.writeBytesPerSec)}`,
            series: [
              { values: metrics.history.read, color: '#f59e0b' },
              { values: metrics.history.write, color: '#ea580c' },
            ],
          }),
        ),
      )
    }

    function SafeContainerMetrics(props) {
      return h(RestartActionBoundary, null, h(ContainerMetrics, props))
    }

    function MetricsSwitch({ t }) {
      const [enabled, setEnabled] = useMetricsEnabled()
      const label = translate(t, 'metricsToggle')
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': enabled ? 'true' : 'false',
        title: label,
        onClick: () => { setEnabled(!enabled) },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          alignSelf: 'flex-start',
          gap: '10px',
          margin: 0,
          padding: '6px 14px 6px 6px',
          borderRadius: '999px',
          border: '1px solid var(--dsw-alias-border-l2, #d9dde3)',
          background: enabled ? 'var(--dsw-alias-bg-layer-1, #f5f6f8)' : 'transparent',
          color: 'var(--dsw-alias-label-primary, #111827)',
          font: 'inherit',
          fontSize: '13px',
          lineHeight: '20px',
          cursor: 'pointer',
        },
      },
        h('span', {
          style: {
            flex: 'none',
            position: 'relative',
            width: '34px',
            height: '20px',
            borderRadius: '999px',
            background: enabled ? '#2f6feb' : 'var(--dsw-alias-border-inverted, #c9ced6)',
            transition: 'background .15s ease',
          },
        }, h('span', {
          style: {
            position: 'absolute',
            top: '2px',
            left: enabled ? '16px' : '2px',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 2px rgba(0, 0, 0, .3)',
            transition: 'left .15s ease',
          },
        })),
        h('span', null, label),
      )
    }

    // Phone layout only (the stylesheet owns that gate): the drawer replaced
    // the shell's control rail, which is where the expand button used to live.
    function MobileSidebarToggle({ t }) {
      const label = translate(t, 'openSidebar')
      const open = React.useCallback(() => {
        try {
          if (typeof toggleSidebar === 'function') toggleSidebar()
        } catch (error) {
          console.error('[dsh-docker-control] sidebar toggle failed:', error)
        }
      }, [])
      return h('button', {
        type: 'button',
        'data-dsh-mobile-sidebar-toggle': '',
        'aria-label': label,
        title: label,
        onClick: open,
        style: {
          position: 'fixed',
          top: 'calc(8px + env(safe-area-inset-top, 0px))',
          left: 'calc(8px + env(safe-area-inset-left, 0px))',
          zIndex: 14,
          alignItems: 'center',
          justifyContent: 'center',
          width: '36px',
          height: '36px',
          padding: 0,
          borderRadius: '10px',
          border: '1px solid var(--dsw-alias-border-l2, #d9dde3)',
          background: 'var(--dsw-alias-button-floating-fill, rgba(255, 255, 255, .92))',
          color: 'var(--dsw-alias-label-primary, #111827)',
          boxShadow: 'var(--dsw-shadow-lv2, 0 4px 16px rgba(0, 0, 0, .16))',
          cursor: 'pointer',
        },
      }, h('svg', {
        width: 18,
        height: 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('rect', { key: 'r', x: 3, y: 3, width: 18, height: 18, rx: 2 }),
        h('path', { key: 'l', d: 'M9 3v18' }),
      ))
    }

    function SafeMobileSidebarToggle(props) {
      return h(RestartActionBoundary, null, h(MobileSidebarToggle, props))
    }

    function ConfigEditor({ t }) {
      const [open, setOpen] = React.useState(false)
      const [text, setText] = React.useState('')
      const [revision, setRevision] = React.useState(null)
      const [phase, setPhase] = React.useState('idle')
      const [error, setError] = React.useState(null)

      const load = React.useCallback(() => {
        setOpen(true)
        setPhase('loading')
        setError(null)
        fetch('/dsh-docker-control/config', { cache: 'no-store' })
          .then(async (response) => {
            const body = await readJson(response)
            if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`)
            return body
          })
          .then((body) => {
            setText(typeof body.text === 'string' ? body.text : '')
            setRevision(typeof body.revision === 'string' ? body.revision : null)
            setPhase('ready')
          })
          .catch((cause) => {
            setPhase('error')
            setError(String(cause && cause.message ? cause.message : cause))
          })
      }, [])

      const close = React.useCallback(() => {
        if (phase !== 'saving') setOpen(false)
      }, [phase])

      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = event => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopImmediatePropagation()
          close()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [close, open])

      const save = React.useCallback(() => {
        if (phase !== 'ready' || revision === null) return
        setPhase('saving')
        setError(null)
        fetch('/dsh-docker-control/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, revision }),
        })
          .then(async (response) => {
            const body = await readJson(response)
            if (!response.ok || body.ok !== true) {
              const cause = new Error(body.error || `HTTP ${response.status}`)
              cause.code = body.conflict === true ? 'CONFIG_CONFLICT' : undefined
              throw cause
            }
            return body
          })
          .then((body) => {
            setRevision(typeof body.revision === 'string' ? body.revision : revision)
            setPhase('ready')
            setError(translate(t, 'configSaved'))
          })
          .catch((cause) => {
            setPhase('ready')
            setError(cause && cause.code === 'CONFIG_CONFLICT'
              ? translate(t, 'configConflict')
              : `${translate(t, 'configSaveFailed')}: ${String(cause && cause.message ? cause.message : cause)}`)
          })
      }, [phase, revision, t, text])

      const button = typeof Button === 'function'
        ? h(Button, { variant: 'outline', size: 'sm', onClick: load }, translate(t, 'openConfig'))
        : h('button', { type: 'button', onClick: load }, translate(t, 'openConfig'))
      const body = phase === 'loading'
        ? h('p', { role: 'status' }, translate(t, 'configLoading'))
        : phase === 'error'
          ? h('p', { role: 'alert' }, `${translate(t, 'configLoadFailed')}: ${error || ''}`)
          : h('textarea', {
              value: text,
              onChange: event => setText(event.target.value),
              spellCheck: false,
              'aria-label': translate(t, 'configTitle'),
              style: {
                display: 'block',
                boxSizing: 'border-box',
                width: '100%',
                minHeight: 'min(58vh, 520px)',
                resize: 'vertical',
                padding: '10px 12px',
                border: '1px solid var(--dsw-alias-border-l2, #d9dde3)',
                borderRadius: '8px',
                background: 'var(--dsw-alias-bg-layer-1, #fff)',
                color: 'var(--dsw-alias-label-primary, #1f2328)',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: '12px',
                lineHeight: '1.5',
              },
            })
      const notice = error === null || phase === 'error'
        ? null
        : h('p', { role: 'status', style: { margin: '8px 0 0', color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, error)
      const footer = h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
        typeof Button === 'function'
          ? h(Button, { variant: 'outline', size: 'sm', onClick: close, disabled: phase === 'saving' }, translate(t, 'configCancel'))
          : h('button', { type: 'button', onClick: close, disabled: phase === 'saving' }, translate(t, 'configCancel')),
        typeof Button === 'function'
          ? h(Button, { variant: 'primary', size: 'sm', onClick: save, disabled: phase !== 'ready' }, phase === 'saving' ? translate(t, 'configSaving') : translate(t, 'configSave'))
          : h('button', { type: 'button', onClick: save, disabled: phase !== 'ready' }, phase === 'saving' ? translate(t, 'configSaving') : translate(t, 'configSave')),
      )
      // The settings page already owns a full-viewport backdrop-filter layer.
      // Do not nest the generic Modal here: two composited masks fight while
      // the textarea scrolls and make both dialogs visibly blink. This layer
      // is a fixed, opaque editor surface with no second backdrop; the
      // settings dialog remains stable behind it until the editor closes.
      const editor = open
        ? h('div', {
            'data-dsh-config-editor-layer': 'true',
            role: 'presentation',
            onClick: event => { if (event.target === event.currentTarget) close() },
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 1100,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '16px',
              boxSizing: 'border-box',
              background: 'transparent',
            },
          }, h('div', {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': translate(t, 'configTitle'),
            onClick: event => event.stopPropagation(),
            style: {
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              width: 'min(880px, 100%)',
              height: 'min(760px, calc(100vh - 32px))',
              minHeight: 'min(420px, calc(100vh - 32px))',
              overflow: 'hidden',
              border: '1px solid var(--dsw-alias-border-inverted, #d9dde3)',
              borderRadius: '16px',
              background: 'var(--dsw-alias-bg-layer-2, #fff)',
              boxShadow: 'var(--dsw-shadow-lv3, 0 16px 48px rgba(0, 0, 0, .22))',
            },
          }, h('div', {
            style: {
              flex: 'none',
              padding: '18px 24px 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l2, #d9dde3)',
            },
          }, h('h2', { style: { margin: 0, fontSize: '16px', lineHeight: '24px', fontWeight: 500 } }, translate(t, 'configTitle')),
          h('p', { style: { margin: '4px 0 0', fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, translate(t, 'configDescription'))),
          h('div', { style: { flex: 1, minHeight: 0, padding: '16px 24px 0', display: 'flex', flexDirection: 'column' } }, body, notice),
          h('div', { style: { flex: 'none', display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '12px 24px 18px' } }, footer)))
        : null
      return h(React.Fragment, null, button, editor === null ? null : createPortal(editor, document.body))
    }

    function SafeConfigEditor(props) {
      return h(RestartActionBoundary, null, h(ConfigEditor, props))
    }

    function apply(ctx) {
      const fail = (phase, error) => {
        console.error(`[dsh-docker-control] ${phase} failed:`, error)
      }

      try {
        // The saved (or user-agent derived) layout must be live before the
        // shell paints, so it is applied at load time rather than by the
        // settings page that only *changes* it.
        applyUiMode(resolveUiMode())
        // The floating opener is a module-scope component, so the panel action
        // reaches it through this seam rather than a per-render closure.
        toggleSidebar = () => { ctx.layout.toggleSidebar() }
        ctx.effect(() => {
          const offZh = ctx.locale.register(NS, 'zh', zh)
          const offEn = ctx.locale.register(NS, 'en', en)
          return () => {
            offEn()
            offZh()
          }
        }, 'dsh-docker-control: dictionaries')

        ctx.slots.inject('settings.action', () => ctx.slots.register({
          name: 'settings.action',
          id: 'open-document',
          priority: -10,
          order: 0,
          locale: NS,
        }, SafeConfigEditor))

        ctx.slots.inject('settings.action', () => ctx.slots.register({
          name: 'settings.action',
          id: 'dsh-docker-control-restart',
          order: 10,
          locale: NS,
        }, SafeRestartAction))

        // A settings page of its own, beside General / Models / Plugins /
        // Agent presets — the version and update controls used to sit in the
        // panel header, where they refetched on every settings open.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-environment',
          order: 60,
          label: () => fallbackText('navTitle'),
          locale: NS,
        }, SafeDshEnvironmentSection))

        // Always mounted, painted only by the phone layout: the drawer hides
        // the shell's rail, and with it the shell's own expand button.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-docker-control-sidebar-toggle',
          order: 0,
          locale: NS,
        }, SafeMobileSidebarToggle))

        // The metrics card rides that same overlay seat: it is positioned
        // against the sidebar column and paints only while the rail is
        // expanded, which is the one place the shell leaves empty.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-docker-control-container-metrics',
          order: 1,
          locale: NS,
        }, SafeContainerMetrics))
      } catch (error) {
        fail('load', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
