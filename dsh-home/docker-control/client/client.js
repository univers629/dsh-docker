window.__ModuleLoader__.load({
  id: 'dsh-docker-control',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, Modal, Toast, IconRefreshOutline14 } = primitives

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
      const modal = typeof Modal === 'function'
        ? h(Modal, {
            open,
            onClose: close,
            title: translate(t, 'configTitle'),
            description: translate(t, 'configDescription'),
            footer,
            contentClassName: 'dsh-docker-control-config-editor',
          }, body, notice)
        : open ? h('div', { role: 'dialog', 'aria-modal': 'true' }, body, notice, footer) : null
      return h(React.Fragment, null, button, modal)
    }

    function SafeConfigEditor(props) {
      return h(RestartActionBoundary, null, h(ConfigEditor, props))
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
      } catch (error) {
        fail('load', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
