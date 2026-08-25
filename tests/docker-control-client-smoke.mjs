import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../dsh-home/docker-control/client/client.js', import.meta.url), 'utf8')
let registration
const errors = []
const fetches = []

class Component {
  constructor(props) {
    this.props = props
    this.state = {}
  }
}

function createElement(type, props, ...children) {
  return {
    type,
    props: {
      ...(props ?? {}),
      children: children.length <= 1 ? children[0] : children,
    },
  }
}

const React = {
  Component,
  Fragment: Symbol('Fragment'),
  createElement,
  useCallback: callback => callback,
  useEffect: () => {},
  useRef: value => ({ current: value }),
  useState: value => [value, () => {}],
}
const primitives = {
  Button: function Button() {},
  Toast: function Toast() {},
  IconRefreshOutline14: function IconRefreshOutline14() {},
}
const ReactDOM = { createPortal: element => element }

// Minimal DOM + storage surface: enough for the layout mode to attach its
// attribute and stylesheet exactly once.
const appended = []
const byId = new Map()
const rootAttributes = new Map()
const documentStub = {
  documentElement: {
    lang: 'zh-CN',
    setAttribute(name, value) { rootAttributes.set(name, value) },
  },
  head: {
    appendChild(node) {
      appended.push(node)
      if (typeof node.id === 'string' && node.id.length > 0) byId.set(node.id, node)
      return node
    },
  },
  createElement: tag => ({ tag, id: '', textContent: '' }),
  getElementById: id => byId.get(id) ?? null,
}
const storage = new Map()
const localStorageStub = {
  getItem: key => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
}

vm.runInNewContext(source, {
  console: { error: (...args) => { errors.push(args) }, log() {}, warn() {} },
  fetch: async (path, options) => {
    fetches.push({ path, options })
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ ok: true, dsh: { version: '1.2.3' } }) },
    }
  },
  document: documentStub,
  navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36' },
  window: {
    innerWidth: 412,
    localStorage: localStorageStub,
    __ModuleLoader__: {
      load(value) { registration = value },
    },
  },
}, { filename: 'dsh-docker-control/client.js' })

assert.equal(registration.id, 'dsh-docker-control')
const requests = []
const client = registration.factory((request) => {
  requests.push(request)
  if (request === 'react') return React
  if (request === 'react-dom') return ReactDOM
  if (request === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected module request: ${request}`)
})

assert.deepEqual(requests, ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'])
assert.equal(typeof client.apply, 'function')
assert.deepEqual(Array.from(client.inject), ['slots', 'locale', 'layout'])

const dictionaries = []
const effects = []
const slots = []
const injected = []
const layoutCalls = []
const ctx = {
  layout: { toggleSidebar() { layoutCalls.push('toggleSidebar') } },
  effect(factory, label) {
    effects.push({ label, dispose: factory() })
  },
  locale: {
    register(namespace, language, dictionary) {
      dictionaries.push({ namespace, language, dictionary })
      return () => {}
    },
  },
  slots: {
    inject(name, factory) {
      injected.push(name)
      return factory()
    },
    register(options, component) {
      slots.push({ options, component })
      return () => {}
    },
  },
}

client.apply(ctx)

// Opening the app must not talk to the network on this plugin's behalf: the
// version card loads on mount and the remote check only on a button press.
assert.equal(fetches.length, 0)
assert.deepEqual(dictionaries.map(({ namespace, language }) => [namespace, language]), [
  ['dsh-docker-control', 'zh'],
  ['dsh-docker-control', 'en'],
])
assert.equal(effects[0].label, 'dsh-docker-control: dictionaries')

// Phone user agent, no stored choice: the phone layout is live before paint.
assert.equal(rootAttributes.get('data-dsh-ui-mode'), 'mobile')
assert.equal(appended.length, 1)
assert.equal(appended[0].id, 'dsh-docker-control-ui-mode')
assert.equal(appended[0].textContent.includes('data-dsh-ui-mode="mobile"'), true)
assert.equal(appended[0].textContent.includes('[data-shell-overlay]'), true)
// The collapsed drawer is clipped by the zero-width track, never display:none:
// the settings dialog is a position: fixed descendant of that column.
assert.equal(appended[0].textContent.includes('[data-sidebar-collapsed] > :first-child {\n  border-right: none;'), true)
assert.equal(appended[0].textContent.includes('[data-dsh-mobile-sidebar-toggle] {\n  display: none;'), true)

assert.deepEqual(injected, ['settings.action', 'settings.action', 'settings.section', 'shell.overlay'])
assert.equal(slots.length, 4)
const configSlot = slots.find(({ options }) => options.id === 'open-document')
const restartSlot = slots.find(({ options }) => options.id === 'dsh-docker-control-restart')
const sectionSlot = slots.find(({ options }) => options.id === 'dsh-environment')
assert.deepEqual(JSON.parse(JSON.stringify(configSlot.options)), {
  name: 'settings.action',
  id: 'open-document',
  priority: -10,
  order: 0,
  locale: 'dsh-docker-control',
})
assert.deepEqual(JSON.parse(JSON.stringify(restartSlot.options)), {
  name: 'settings.action',
  id: 'dsh-docker-control-restart',
  order: 10,
  locale: 'dsh-docker-control',
})
assert.equal(Object.hasOwn(restartSlot.options, 'inject'), false)
assert.equal(slots.some(({ options }) => options.id === 'dsh-docker-control-update'), false)
assert.deepEqual(JSON.parse(JSON.stringify({ ...sectionSlot.options, label: undefined })), {
  name: 'settings.section',
  id: 'dsh-environment',
  order: 60,
  locale: 'dsh-docker-control',
})
assert.equal(typeof sectionSlot.options.label, 'function')
assert.equal(sectionSlot.options.label(), 'DSH 环境')

// The floating opener drives the shell's own panel action, and it must not
// carry an inline display — the stylesheet is what gates it to the phone layout.
const overlaySlot = slots.find(({ options }) => options.id === 'dsh-docker-control-sidebar-toggle')
assert.deepEqual(JSON.parse(JSON.stringify(overlaySlot.options)), {
  name: 'shell.overlay',
  id: 'dsh-docker-control-sidebar-toggle',
  order: 0,
  locale: 'dsh-docker-control',
})
const toggleSafeTree = overlaySlot.component({ t: key => ({ openSidebar: 'Open the sidebar' })[key] ?? key })
const toggleTree = toggleSafeTree.props.children
const toggleRendered = toggleTree.type(toggleTree.props)
assert.equal(toggleRendered.props['aria-label'], 'Open the sidebar')
assert.equal(Object.hasOwn(toggleRendered.props, 'data-dsh-mobile-sidebar-toggle'), true)
assert.equal(Object.hasOwn(toggleRendered.props.style, 'display'), false)
assert.equal(toggleRendered.props.style.position, 'fixed')
toggleRendered.props.onClick()
assert.deepEqual(layoutCalls, ['toggleSidebar'])

const safeTree = restartSlot.component({ t: key => ({ restart: 'Restart DSH' })[key] ?? key })
const actionTree = safeTree.props.children
const rendered = actionTree.type(actionTree.props)
const button = rendered.props.children[0]
assert.equal(button.type, primitives.Button)
assert.equal(button.props.children, 'Restart DSH')

const configSafeTree = configSlot.component({ t: key => ({ openConfig: 'Open configuration file' })[key] ?? key })
const configActionTree = configSafeTree.props.children
const configRendered = configActionTree.type(configActionTree.props)
const configButton = configRendered.props.children[0]
assert.equal(configButton.type, primitives.Button)
assert.equal(configButton.props.children, 'Open configuration file')

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node.props === undefined) return
  visit(node)
  walk(node.props.children, visit)
}

const sectionSafeTree = sectionSlot.component({ t: key => key })
const sectionTree = sectionSafeTree.props.children
const sectionRendered = sectionTree.type(sectionTree.props)
const texts = []
const modeOptions = []
walk(sectionRendered, (node) => {
  if (typeof node.props.children === 'string') texts.push(node.props.children)
  const mode = node.props['data-dsh-ui-mode-option']
  if (typeof mode === 'string') modeOptions.push({ mode, checked: node.props['aria-checked'] })
})

// The page shows both versions and never claims a verdict before a check.
assert.equal(texts.includes('currentVersion'), true)
assert.equal(texts.includes('latestVersion'), true)
assert.equal(texts.includes('notChecked'), true)
assert.equal(texts.includes('checkUpdate'), true)
assert.equal(texts.includes('updateDsh'), true)
assert.equal(texts.includes('upToDate'), false)
assert.equal(texts.includes('updateAvailableText'), false)
assert.deepEqual(modeOptions, [
  { mode: 'desktop', checked: 'false' },
  { mode: 'mobile', checked: 'true' },
])

assert.doesNotThrow(() => {
  client.apply({
    layout: { toggleSidebar() {} },
    effect(factory) { factory() },
    locale: { register() { throw new Error('locale unavailable') } },
    slots: { inject() { throw new Error('must not reach slots after locale failure') } },
  })
})
assert.equal(errors.some(args => String(args[0]).includes('[dsh-docker-control] load failed')), true)

const pkg = JSON.parse(await readFile(new URL('../dsh-home/docker-control/package.json', import.meta.url), 'utf8'))
assert.deepEqual(pkg.dsh.client.inject, [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-layout',
])

console.log('docker-control client smoke: ok')
