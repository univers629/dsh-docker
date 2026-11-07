/*
 * 插件开关面板：单管理员模式里，登录之后、进入工作台之前的一块页面。
 *
 * 它改的是 profile 的补丁层（cordis.patch.yml 与 package.json 的 bundles），
 * 不经过 DSH 进程，所以插件把启动搞崩、页面打不开时这里仍然是可用的开关。
 */
(() => {
  const CSRF_COOKIE = 'dsh_auth_csrf'

  const I18N = {
    zh: {
      enabled: '已启用',
      disabled: '已禁用',
      fixedOn: '启用',
      fixedOff: '禁用',
      locked: '不可开关',
      reasonMissing: '没有加载行：客户端插件，开关在 profile 之外',
      reasonOfficial: '官方组件，随镜像提供',
      reasonManaged: '市场自管行，改这里会被覆盖',
      safeMode: '禁用第三方插件',
      safeModeDone: '已禁用 {count} 个第三方插件',
      restart: '重启工作台',
      restartDone: '已请求重启，Supervisor 会在几秒内重新拉起 DSH',
      refresh: '刷新',
      readOnly: '补丁层不可写，请检查 data/dsh 的挂载与属主',
      empty: '这个 profile 里没有可开关的插件',
      failed: '操作失败：{message}',
      pending: '处理中…',
      restartPending: '已请求重启，等待 Supervisor 拉起',
      unchanged: '补丁层里没有需要改的行，状态已经是目标值',
    },
    en: {
      enabled: 'Enabled',
      disabled: 'Disabled',
      fixedOn: 'Enable',
      fixedOff: 'Disable',
      locked: 'Not switchable',
      reasonMissing: 'No loader entry: client-side plugin, switched elsewhere',
      reasonOfficial: 'Shipped with the image',
      reasonManaged: 'Managed by the market, edits here get overwritten',
      safeMode: 'Disable third-party plugins',
      safeModeDone: 'Disabled {count} third-party plugins',
      restart: 'Restart workspace',
      restartDone: 'Restart requested; the supervisor will bring DSH back shortly',
      refresh: 'Refresh',
      readOnly: 'The patch layer is not writable; check the data/dsh mount and its owner',
      empty: 'No switchable plugins in this profile',
      failed: 'Failed: {message}',
      pending: 'Working…',
      restartPending: 'Restart requested, waiting for the supervisor',
      unchanged: 'Nothing to change in the patch layer; the state already matches',
    },
  }

  /** HTML 转义：插件名、版本、说明都来自 profile 里的第三方包。 */
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  }

  function readCookie(name) {
    const hit = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : ''
  }

  function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (all, key) => (key in values ? String(values[key]) : all))
  }

  window.DSHPluginsPanel = {
    mount(root, options = {}) {
      const lang = options.lang === 'en' ? 'en' : 'zh'
      const t = (key, values) => fill(I18N[lang][key] ?? key, values ?? {})
      let state = null
      let busy = false

      const card = document.createElement('div')
      card.className = 'plugins-card'
      const alert = document.createElement('div')
      alert.className = 'inline-alert inline-alert--danger'
      alert.style.display = 'none'
      const list = document.createElement('div')
      list.style.marginTop = '10px'
      const toolbar = document.createElement('div')
      toolbar.className = 'plugins-toolbar'
      card.append(alert, list, toolbar)
      root.appendChild(card)

      function setError(message) {
        alert.className = 'inline-alert inline-alert--danger'
        if (!message) {
          alert.style.display = 'none'
          alert.textContent = ''
          return
        }
        alert.textContent = message
        alert.style.display = 'block'
      }

      function button(label, kind, onClick, disabled = false) {
        const el = document.createElement('button')
        el.className = kind === 'primary' ? 'button button--primary' : 'button button--secondary'
        el.type = 'button'
        el.textContent = label
        el.disabled = disabled || busy
        el.addEventListener('click', onClick)
        return el
      }

      function render() {
        list.replaceChildren()
        toolbar.replaceChildren()

        if (state && state.writable === false) {
          const notice = document.createElement('div')
          notice.className = 'inline-alert inline-alert--info'
          notice.textContent = t('readOnly')
          list.appendChild(notice)
        }

        const plugins = state?.plugins ?? []
        if (state && plugins.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'muted-text'
          empty.textContent = t('empty')
          list.appendChild(empty)
        }

        for (const plugin of plugins) {
          const row = document.createElement('div')
          row.className = 'plugins-row'

          const main = document.createElement('div')
          main.className = 'plugins-row__main'

          const name = document.createElement('div')
          name.className = 'plugins-row__name'
          name.textContent = plugin.name
          if (plugin.version) {
            const version = document.createElement('span')
            version.className = 'plugins-row__meta'
            version.style.marginLeft = '8px'
            version.textContent = plugin.version
            name.appendChild(version)
          }

          const badge = document.createElement('span')
          if (!plugin.toggleable) {
            badge.className = 'plugins-row__badge plugins-row__badge--locked'
            badge.textContent = t('locked')
          } else {
            badge.className = plugin.enabled ? 'plugins-row__badge' : 'plugins-row__badge plugins-row__badge--off'
            badge.textContent = plugin.enabled ? t('enabled') : t('disabled')
          }
          name.appendChild(badge)

          const info = document.createElement('div')
          info.className = 'plugins-row__meta'
          info.textContent = plugin.toggleable
            ? (plugin.description || plugin.spec || '')
            : reasonText(plugin.reason)

          main.append(name, info)
          row.appendChild(main)

          if (plugin.toggleable) {
            row.appendChild(button(plugin.enabled ? t('fixedOff') : t('fixedOn'), plugin.enabled ? 'danger' : 'primary', () => toggle(plugin)))
          }
          list.appendChild(row)
        }

        if (state) {
          if (state.restartAt) {
            const note = document.createElement('div')
            note.className = 'muted-text'
            note.style.marginTop = '10px'
            note.textContent = t('restartPending')
            list.appendChild(note)
          }
          toolbar.append(
            button(t('safeMode'), 'danger', safeMode),
            button(t('restart'), 'secondary', restart),
            button(t('refresh'), 'link', load),
          )
        }
      }

      function reasonText(reason) {
        if (reason === 'official') return t('reasonOfficial')
        if (reason === 'managed') return t('reasonManaged')
        return t('reasonMissing')
      }

      async function call(path, body) {
        const headers = { 'content-type': 'application/json' }
        const csrf = readCookie(CSRF_COOKIE)
        if (csrf) headers['x-csrf-token'] = csrf
        const response = await fetch(path, {
          method: body === undefined ? 'GET' : 'POST',
          credentials: 'same-origin',
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.message || payload.code || `HTTP ${response.status}`)
        }
        return payload
      }

      async function run(task) {
        if (busy) return
        busy = true
        setError('')
        render()
        try {
          await task()
        } catch (error) {
          setError(t('failed', { message: error?.message ?? error }))
        } finally {
          busy = false
          render()
        }
      }

      async function load() {
        await run(async () => { state = await call('/api/auth/plugins') })
      }

      async function toggle(plugin) {
        await run(async () => {
          const payload = await call('/api/auth/plugins/toggle', { name: plugin.name, enabled: !plugin.enabled })
          state = payload
          if (payload.changed === false) {
            setError('')
            alert.className = 'inline-alert inline-alert--info'
            alert.textContent = t('unchanged')
            alert.style.display = 'block'
          }
        })
      }

      async function safeMode() {
        await run(async () => {
          const payload = await call('/api/auth/plugins/safe-mode', {})
          state = payload
          setError('')
          alert.className = 'inline-alert inline-alert--info'
          alert.textContent = t('safeModeDone', { count: (payload.disabled ?? []).length })
          alert.style.display = 'block'
        })
      }

      async function restart() {
        await run(async () => {
          const payload = await call('/api/auth/plugins/restart', {})
          if (state) state.restartAt = payload.restartAt
        })
      }

      render()
      load()
    },
  }
})()
