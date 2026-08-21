import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import net from 'node:net'

const cdpPort = Number(process.env.DSH_CDP_PORT ?? 19222)
const url = process.env.DSH_TEST_URL ?? 'http://127.0.0.1:13080/'
const origin = new URL(url).origin

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function newPage(targetUrl) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' })
  if (!response.ok) throw new Error(`CDP new page failed: HTTP ${response.status}`)
  return response.json()
}

async function readStatus() {
  const response = await fetch(`${origin}/dsh-docker-control/status`, { cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.ok !== true) throw new Error(`status failed: HTTP ${response.status}`)
  return body
}

async function waitForBoot(previous) {
  const deadline = Date.now() + 75000
  let lastError
  while (Date.now() < deadline) {
    try {
      const body = await readStatus()
      if (typeof body.boot === 'string' && body.boot !== previous) return body
    } catch (error) {
      lastError = error
    }
    await sleep(1000)
  }
  throw new Error(`service did not report a new boot${lastError ? `: ${lastError.message}` : ''}`)
}

function connectWebSocket(webSocketUrl) {
  const parsed = new URL(webSocketUrl)
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(parsed.port), parsed.hostname)
    let input = Buffer.alloc(0)
    let connected = false
    const listeners = new Set()
    const pending = new Map()
    let id = 0

    const emit = message => {
      for (const listener of listeners) listener(message)
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    }

    const consume = () => {
      while (connected && input.length >= 2) {
        const first = input[0]
        const second = input[1]
        let length = second & 0x7f
        let offset = 2
        if (length === 126) {
          if (input.length < 4) return
          length = input.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (input.length < 10) return
          const longLength = Number(input.readBigUInt64BE(2))
          if (!Number.isSafeInteger(longLength)) throw new Error('CDP frame too large')
          length = longLength
          offset = 10
        }
        const masked = (second & 0x80) !== 0
        const total = offset + (masked ? 4 : 0) + length
        if (input.length < total) return
        let payload = input.subarray(offset + (masked ? 4 : 0), total)
        if (masked) {
          const mask = input.subarray(offset, offset + 4)
          payload = Buffer.from(payload)
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
        }
        input = input.subarray(total)
        const opcode = first & 0x0f
        if (opcode === 1) emit(JSON.parse(payload.toString('utf8')))
        else if (opcode === 8) socket.end()
      }
    }

    socket.on('connect', () => {
      const key = crypto.randomBytes(16).toString('base64')
      socket.write(
        `GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\n`
        + `Host: ${parsed.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk])
      if (!connected) {
        const headerEnd = input.indexOf(Buffer.from('\r\n\r\n'))
        if (headerEnd === -1) return
        const header = input.subarray(0, headerEnd).toString('utf8')
        if (!header.startsWith('HTTP/1.1 101')) {
          reject(new Error(`CDP WebSocket handshake failed: ${header.split('\r\n')[0]}`))
          socket.destroy()
          return
        }
        input = input.subarray(headerEnd + 4)
        connected = true
        resolve({
          on(listener) { listeners.add(listener); return () => listeners.delete(listener) },
          send(method, params = {}) {
            const commandId = ++id
            const payload = Buffer.from(JSON.stringify({ id: commandId, method, params }))
            const mask = crypto.randomBytes(4)
            let header
            if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length])
            else if (payload.length <= 0xffff) header = Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 0xff])
            else throw new Error('CDP command too large')
            const maskedPayload = Buffer.from(payload)
            for (let i = 0; i < maskedPayload.length; i++) maskedPayload[i] ^= mask[i % 4]
            socket.write(Buffer.concat([header, mask, maskedPayload]))
            return new Promise((resolveCommand, rejectCommand) => {
              pending.set(commandId, message => {
                if (message.error) rejectCommand(new Error(JSON.stringify(message.error)))
                else resolveCommand(message.result)
              })
            })
          },
          close() { socket.end() },
        })
      }
      consume()
    })
    socket.on('error', reject)
  })
}

const target = await newPage(url)
const cdp = await connectWebSocket(target.webSocketDebuggerUrl)
const errors = []
const exceptions = []
const consoleErrors = []
cdp.on(message => {
  if (message.method === 'Page.javascriptDialogOpening') {
    void cdp.send('Page.handleJavaScriptDialog', { accept: true })
  }
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails?.text ?? 'exception')
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args?.map(arg => arg.value ?? arg.description ?? '').join(' ') ?? 'console error')
  }
})
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.send('Log.enable')
await cdp.send('Page.navigate', { url })
await evaluate(`new Promise(resolve => {
  const started = Date.now()
  const check = () => {
    const text = document.body?.innerText ?? ''
    if (document.readyState === 'complete' && !text.includes('Loading plugins')) {
      resolve(true)
      return
    }
    if (Date.now() - started > 55000) {
      resolve(false)
      return
    }
    window.setTimeout(check, 500)
  }
  check()
})`)

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) {
    const details = result.exceptionDetails
    throw new Error(details.exception?.description || details.exception?.value || details.text || 'browser evaluation failed')
  }
  return result.result?.value
}

const initial = JSON.parse(await evaluate(`JSON.stringify({
  title: document.title,
  ready: document.readyState,
  bodyText: document.body?.innerText?.slice(0, 1200) ?? '',
  htmlLength: document.documentElement?.outerHTML?.length ?? 0,
  buttons: [...document.querySelectorAll('button')].map(button => button.innerText.trim()).filter(Boolean).slice(0, 80),
  buttonDetails: [...document.querySelectorAll('button')].map(button => ({
    text: button.innerText.trim(),
    aria: button.getAttribute('aria-label'),
    title: button.getAttribute('title'),
    testid: button.getAttribute('data-testid'),
  })).slice(0, 120),
})`))
console.log(JSON.stringify({ phase: 'initial', initial, exceptions, consoleErrors }, null, 2))
assert.ok(initial.htmlLength > 1000, 'the SPA rendered no meaningful HTML')
assert.equal(exceptions.length, 0, `page exceptions: ${exceptions.join('; ')}`)

const opened = await evaluate(`(() => {
  const direct = [...document.querySelectorAll('button')].find(item => /设置|Settings/i.test(item.innerText + ' ' + (item.getAttribute('aria-label') ?? '')))
  const button = direct ?? [...document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === '打开侧边栏')
  if (!button) return false
  button.click()
  return true
})()`)
if (opened) {
  await sleep(2500)
  const side = JSON.parse(await evaluate(`JSON.stringify({
    buttons: [...document.querySelectorAll('button')].map(button => ({ text: button.innerText.trim(), aria: button.getAttribute('aria-label'), title: button.getAttribute('title') })).slice(0, 160),
  })`))
  console.log(JSON.stringify({ phase: 'after-sidebar', side, exceptions, consoleErrors }, null, 2))
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => /设置|Settings/i.test(item.innerText + ' ' + (item.getAttribute('aria-label') ?? '') + ' ' + (item.getAttribute('title') ?? '')))
    if (button) button.click()
    return Boolean(button)
  })()`)
  await sleep(1500)
  const settings = JSON.parse(await evaluate(`JSON.stringify({
    dialog: Boolean(document.querySelector('[role="dialog"]')),
    buttons: [...document.querySelectorAll('[role="dialog"] button')].map(button => button.innerText.trim()).filter(Boolean),
    restart: [...document.querySelectorAll('[role="dialog"] button')].some(button => /重启 DSH|Restart DSH/i.test(button.innerText)),
    config: [...document.querySelectorAll('[role="dialog"] button')].some(button => /打开配置文件|Open configuration file/i.test(button.innerText)),
  })`))
  console.log(JSON.stringify({ phase: 'settings', settings, exceptions, consoleErrors }, null, 2))
  assert.equal(settings.dialog, true, 'settings dialog did not open')
  assert.equal(settings.restart, true, 'restart button did not render in settings action row')
  assert.equal(settings.config, true, 'WebUI configuration editor button did not render in settings action row')

  const configClicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find(item => /打开配置文件|Open configuration file/i.test(item.innerText))
    if (!button) return false
    button.click()
    return true
  })()`)
  assert.equal(configClicked, true, 'WebUI configuration editor button could not be clicked')
  await evaluate(`new Promise(resolve => {
    const started = Date.now()
    const check = () => {
      if (document.querySelector('textarea[aria-label="编辑配置文件"], textarea[aria-label="Edit configuration file"]')
        || document.querySelector('[data-dsh-config-editor-layer] [role="alert"]')) {
        resolve(true)
        return
      }
      if (Date.now() - started > 30000) {
        resolve(false)
        return
      }
      window.setTimeout(check, 100)
    }
    check()
  })`)
  const configEditor = JSON.parse(await evaluate(`JSON.stringify({
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    textarea: Boolean(document.querySelector('textarea[aria-label="编辑配置文件"], textarea[aria-label="Edit configuration file"]')),
    save: [...document.querySelectorAll('[role="dialog"] button')].some(button => /保存配置|Save configuration/i.test(button.innerText)),
    editorLayer: Boolean(document.querySelector('[data-dsh-config-editor-layer]')),
    backdropFilters: [...document.querySelectorAll('[data-dsh-config-editor-layer], [data-dsh-config-editor-layer] *')]
      .filter(node => getComputedStyle(node).backdropFilter && getComputedStyle(node).backdropFilter !== 'none').length,
    viewportBackdropFilters: [...document.querySelectorAll('*')].filter(node => {
      const style = getComputedStyle(node)
      if (!style.backdropFilter || style.backdropFilter === 'none') return false
      const rect = node.getBoundingClientRect()
      return rect.width >= innerWidth * 0.9 && rect.height >= innerHeight * 0.9
    }).length,
    bodyText: document.body?.innerText?.slice(-1600) ?? '',
  })`))
  console.log(JSON.stringify({ phase: 'config-editor', configEditor, exceptions, consoleErrors }, null, 2))
  assert.ok(configEditor.dialogs >= 2, 'configuration editor dialog did not open over settings')
  assert.equal(configEditor.textarea, true, 'configuration editor textarea did not render')
  assert.equal(configEditor.save, true, 'configuration editor save action did not render')
  assert.equal(configEditor.editorLayer, true, 'configuration editor layer did not render')
  assert.equal(configEditor.backdropFilters, 0, 'configuration editor introduced a nested backdrop filter')
  assert.equal(configEditor.viewportBackdropFilters, 1, 'configuration editor must preserve exactly the settings backdrop')

  const scrollProbe = JSON.parse(await evaluate(`(() => {
    const layer = document.querySelector('[data-dsh-config-editor-layer]')
    const textarea = layer?.querySelector('textarea')
    const settings = [...document.querySelectorAll('[role="dialog"]')].find(dialog => !dialog.closest('[data-dsh-config-editor-layer]'))
    if (!layer || !textarea || !settings) return { ok: false }
    window.__dshConfigScrollProbe = {
      layer,
      textarea,
      settings,
      disconnected: 0,
      frames: 0,
      hiddenFrames: 0,
      maxScrollTop: 0,
      observer: new MutationObserver(() => {
        if (!layer.isConnected || !textarea.isConnected || !settings.isConnected) window.__dshConfigScrollProbe.disconnected += 1
      }),
    }
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    valueSetter?.call(textarea, textarea.value + '\\n' + 'scroll-probe: true\\n'.repeat(240))
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    window.__dshConfigScrollProbe.onScroll = () => {
      const probe = window.__dshConfigScrollProbe
      if (probe) probe.maxScrollTop = Math.max(probe.maxScrollTop, textarea.scrollTop)
    }
    textarea.addEventListener('scroll', window.__dshConfigScrollProbe.onScroll)
    window.__dshConfigScrollProbe.observer.observe(document.body, { childList: true, subtree: true })
    const sampleFrame = () => {
      const probe = window.__dshConfigScrollProbe
      if (!probe) return
      probe.frames += 1
      if (!probe.layer.isConnected || !probe.textarea.isConnected || !probe.settings.isConnected
        || getComputedStyle(probe.layer).visibility !== 'visible'
        || getComputedStyle(probe.settings).visibility !== 'visible') probe.hiddenFrames += 1
      if (probe.frames < 90) requestAnimationFrame(sampleFrame)
    }
    requestAnimationFrame(sampleFrame)
    const rect = textarea.getBoundingClientRect()
    return JSON.stringify({
      ok: true,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      scrollable: textarea.scrollHeight > textarea.clientHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    })
  })()`))
  assert.equal(scrollProbe.ok, true, 'configuration editor scroll target was unavailable')
  assert.equal(scrollProbe.scrollable, true, 'configuration editor did not contain scrollable test content')
  for (let index = 0; index < 24; index += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: scrollProbe.x,
      y: scrollProbe.y,
      deltaX: 0,
      deltaY: index < 16 ? 240 : -240,
    })
    await sleep(25)
  }
  const compactHeight = Math.max(480, scrollProbe.viewportHeight - 120)
  for (let index = 0; index < 10; index += 1) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: scrollProbe.viewportWidth,
      height: index % 2 === 0 ? compactHeight : scrollProbe.viewportHeight,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(35)
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await sleep(1200)
  const scrollStability = JSON.parse(await evaluate(`(() => {
    const probe = window.__dshConfigScrollProbe
    if (!probe) return JSON.stringify({ ok: false })
    probe.observer.disconnect()
    probe.textarea.removeEventListener('scroll', probe.onScroll)
    const result = {
      ok: true,
      layer: probe.layer.isConnected,
      textarea: probe.textarea.isConnected,
      settings: probe.settings.isConnected,
      disconnected: probe.disconnected,
      frames: probe.frames,
      hiddenFrames: probe.hiddenFrames,
      maxScrollTop: probe.maxScrollTop,
      filters: [...document.querySelectorAll('[data-dsh-config-editor-layer], [data-dsh-config-editor-layer] *')]
        .filter(node => getComputedStyle(node).backdropFilter && getComputedStyle(node).backdropFilter !== 'none').length,
    }
    delete window.__dshConfigScrollProbe
    return JSON.stringify(result)
  })()`))
  assert.equal(scrollStability.ok, true, 'configuration editor scroll target was unavailable')
  assert.equal(scrollStability.layer, true, 'editor layer disappeared during scrolling')
  assert.equal(scrollStability.textarea, true, 'editor textarea disappeared during scrolling')
  assert.equal(scrollStability.settings, true, 'settings dialog disappeared during scrolling')
  assert.equal(scrollStability.disconnected, 0, 'settings or editor DOM remounted during scrolling')
  assert.equal(scrollStability.hiddenFrames, 0, 'settings or editor became hidden during scrolling')
  assert.ok(scrollStability.maxScrollTop > 0, 'real wheel events did not scroll the configuration content')
  assert.ok(scrollStability.frames >= 30, 'scroll stability probe did not sample enough animation frames')
  assert.equal(scrollStability.filters, 0, 'nested backdrop filter appeared during scrolling')
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find(item => /取消|Cancel/i.test(item.innerText))
    if (button) button.click()
    return Boolean(button)
  })()`)
  await sleep(300)

  if (process.env.DSH_TEST_RESTART === '1') {
    const beforeRestart = await readStatus()
    const restartClicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll('[role="dialog"] button')].find(item => /重启 DSH|Restart DSH/i.test(item.innerText))
      if (!button) return false
      button.click()
      return true
    })()`)
    assert.equal(restartClicked, true, 'restart button could not be clicked')
    cdp.close()
    const afterBoot = await waitForBoot(beforeRestart.boot)
    const restoredTarget = await newPage(url)
    const restored = await connectWebSocket(restoredTarget.webSocketDebuggerUrl)
    const restoredExceptions = []
    const restoredConsoleErrors = []
    restored.on(message => {
      if (message.method === 'Runtime.exceptionThrown') restoredExceptions.push(message.params.exceptionDetails?.text ?? 'exception')
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        restoredConsoleErrors.push(message.params.args?.map(arg => arg.value ?? arg.description ?? '').join(' ') ?? 'console error')
      }
    })
    await restored.send('Runtime.enable')
    await restored.send('Page.enable')
    await restored.send('Page.navigate', { url })
    const restoredReady = await (async () => {
      const deadline = Date.now() + 55000
      while (Date.now() < deadline) {
        const result = await restored.send('Runtime.evaluate', {
          expression: `JSON.stringify({ ready: document.readyState, text: document.body?.innerText ?? '', htmlLength: document.documentElement?.outerHTML?.length ?? 0 })`,
          returnByValue: true,
        })
        const value = JSON.parse(result.result?.value ?? '{}')
        if (value.ready === 'complete' && !value.text.includes('Loading plugins')) return value
        await sleep(500)
      }
      throw new Error('restored page did not finish rendering')
    })()
    console.log(JSON.stringify({ phase: 'after-restart', boot: afterBoot.boot, restoredReady, restoredExceptions, restoredConsoleErrors }, null, 2))
    assert.ok(restoredReady.htmlLength > 1000, 'page lost rendered HTML after restart')
    assert.equal(restoredExceptions.length, 0, `page exceptions after restart: ${restoredExceptions.join('; ')}`)
    assert.equal(restoredConsoleErrors.length, 0, `console errors after restart: ${restoredConsoleErrors.join('; ')}`)
    restored.close()
  }
}

assert.equal(exceptions.length, 0, `page exceptions after settings: ${exceptions.join('; ')}`)
cdp.close()
console.log('browser cdp smoke: ok')
