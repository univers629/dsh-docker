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

    const UI_MODE_STORAGE_KEY = 'dsh-docker-control.ui-mode'
    const UI_MODE_STYLE_ID = 'dsh-docker-control-ui-mode'
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
        const deadline = Date.now() + 60000
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
        const deadline = Date.now() + 90000
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
      )
    }

    function SafeDshEnvironmentSection(props) {
      return h(RestartActionBoundary, null, h(DshEnvironmentSection, props))
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
      } catch (error) {
        fail('load', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
