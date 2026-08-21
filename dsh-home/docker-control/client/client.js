window.__ModuleLoader__.load({
  id: 'dsh-docker-control',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, Toast, IconRefreshOutline14 } = primitives

    const NS = 'dsh-docker-control'
    const h = React.createElement
    const inject = ['slots', 'locale']

    const zh = {
      restart: '重启 DSH',
      confirm: '确认重启 DSH？当前进行中的请求可能会短暂中断。',
      requesting: '正在安排重启…',
      scheduled: '已安排 DSH 重启，等待服务恢复…',
      restored: 'DSH 已重新启动',
      failed: '重启失败',
      timeout: '服务未在 60 秒内完成新一轮启动',
    }

    const en = {
      restart: 'Restart DSH',
      confirm: 'Restart DSH? Active requests may be briefly interrupted.',
      requesting: 'Scheduling restart…',
      scheduled: 'DSH restart scheduled; waiting for the service…',
      restored: 'DSH restarted',
      failed: 'Restart failed',
      timeout: 'The service did not report a new boot within 60 seconds',
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

    function apply(ctx) {
      const fail = (phase, error) => {
        console.error(`[dsh-docker-control] ${phase} failed:`, error)
      }

      try {
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
          id: 'dsh-docker-control-restart',
          order: 10,
          locale: NS,
        }, SafeRestartAction))
      } catch (error) {
        fail('load', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
