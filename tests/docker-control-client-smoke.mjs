import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../dsh-home/docker-control/client/client.js', import.meta.url), 'utf8')
let registration
const errors = []

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
  useRef: value => ({ current: value }),
  useState: value => [value, () => {}],
}
const primitives = {
  Button: function Button() {},
  Toast: function Toast() {},
  IconRefreshOutline14: function IconRefreshOutline14() {},
}

vm.runInNewContext(source, {
  console: { error: (...args) => { errors.push(args) }, log() {}, warn() {} },
  window: {
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
  if (request === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected module request: ${request}`)
})

assert.deepEqual(requests, ['react', '@deepseek-ai/dsh-client-ui-primitives'])
assert.equal(typeof client.apply, 'function')
assert.deepEqual(Array.from(client.inject), ['slots', 'locale'])

const dictionaries = []
const effects = []
let slot
const ctx = {
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
      assert.equal(name, 'settings.action')
      return factory()
    },
    register(options, component) {
      slot = { options, component }
      return () => {}
    },
  },
}

client.apply(ctx)
assert.deepEqual(dictionaries.map(({ namespace, language }) => [namespace, language]), [
  ['dsh-docker-control', 'zh'],
  ['dsh-docker-control', 'en'],
])
assert.equal(effects[0].label, 'dsh-docker-control: dictionaries')
assert.deepEqual(JSON.parse(JSON.stringify(slot.options)), {
  name: 'settings.action',
  id: 'dsh-docker-control-restart',
  order: 10,
  locale: 'dsh-docker-control',
})
assert.equal(Object.hasOwn(slot.options, 'inject'), false)

const safeTree = slot.component({ t: key => ({ restart: 'Restart DSH' })[key] ?? key })
const actionTree = safeTree.props.children
const rendered = actionTree.type(actionTree.props)
const button = rendered.props.children[0]
assert.equal(button.type, primitives.Button)
assert.equal(button.props.children, 'Restart DSH')

assert.doesNotThrow(() => {
  client.apply({
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
])

console.log('docker-control client smoke: ok')
