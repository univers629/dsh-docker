window.__ModuleLoader__.load({ id: 'dsh-docker-control', factory: (require) => {
  const React = require('react')
  const { Button, Toast, IconRefreshOutline14 } = require('@deepseek-ai/dsh-client-ui-primitives')

  const NS = 'dsh-docker-control'
  const h = React.createElement
  const inject = ['slots', 'locale']

  const text = {
    zh: {
      restart: '重启 DSH',
      confirm: '确认重启 DSH？当前进行中的请求可能会短暂中断。',
      requesting: '正在安排重启…',
      scheduled: '已安排 DSH 重启，等待服务恢复…',
      restored: 'DSH 已重新启动',
      failed: '重启失败',
    },
    en: {
      restart: 'Restart DSH',
      confirm: 'Restart DSH? Active requests may be briefly interrupted.',
      requesting: 'Scheduling restart…',
      scheduled: 'DSH restart scheduled; waiting for the service…',
      restored: 'DSH restarted',
      failed: 'Restart failed',
    },
  }

  function localeText(t, key) {
    try { return t(key) } catch { return text.zh[key] }
  }

  function RestartAction({ t }) {
    const [state, setState] = React.useState('idle')
    const [toast, setToast] = React.useState(null)
    const seq = React.useRef(0)

    const show = React.useCallback((message) => {
      seq.current += 1
      setToast({ key: seq.current, message })
    }, [])

    const waitForBoot = React.useCallback((previous) => {
      const deadline = Date.now() + 60000
      const poll = () => {
        if (Date.now() > deadline) {
          setState('idle')
          show(localeText(t, 'failed') + ': service did not report a new boot within 60 seconds')
          return
        }
        fetch('/dsh-docker-control/status', { cache: 'no-store' })
          .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            return res.json()
          })
          .then((body) => {
            if (typeof body.boot === 'string' && body.boot !== previous) {
              setState('idle')
              show(localeText(t, 'restored'))
              window.setTimeout(() => window.location.reload(), 900)
              return
            }
            window.setTimeout(poll, 1000)
          })
          .catch(() => window.setTimeout(poll, 1000))
      }
      poll()
    }, [show, t])

    const restart = React.useCallback(() => {
      if (state !== 'idle') return
      if (typeof window.confirm === 'function' && !window.confirm(localeText(t, 'confirm'))) return
      setState('requesting')
      fetch('/dsh-docker-control/status', { cache: 'no-store' })
        .then(res => res.json())
        .then((before) => {
          show(localeText(t, 'requesting'))
          return fetch('/dsh-docker-control/restart', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }).then(async (res) => {
            const body = await res.json().catch(() => ({}))
            if (!res.ok || body.ok !== true) throw new Error(body.error || `HTTP ${res.status}`)
            setState('waiting')
            show(localeText(t, 'scheduled'))
            waitForBoot(typeof before.boot === 'string' ? before.boot : '')
          })
        })
        .catch((error) => {
          setState('idle')
          show(localeText(t, 'failed') + ': ' + String(error.message || error))
        })
    }, [state, t, show, waitForBoot])

    return h(React.Fragment, null,
      h(Button, {
        variant: 'outline',
        size: 'sm',
        icon: h(IconRefreshOutline14, { size: 14 }),
        disabled: state !== 'idle',
        onClick: restart,
      }, state === 'requesting' ? localeText(t, 'requesting') : state === 'waiting' ? localeText(t, 'scheduled') : localeText(t, 'restart')),
      toast && h(Toast, { key: toast.key, text: toast.message, onDone: () => setToast(null) }),
    )
  }

  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh: text.zh, en: text.en }), 'dsh-docker-control: dictionaries')
    const t = ctx.locale.bind(NS)
    ctx.slots.inject('settings.action', () => ctx.slots.register({
      name: 'settings.action',
      id: 'dsh-docker-control-restart',
      order: 10,
      locale: NS,
      inject: () => ({ t }),
    }, RestartAction))
  }

  return { apply, inject }
} })
