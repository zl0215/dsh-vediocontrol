/**
 * Offline smoke test for the push-to-talk client module.
 *
 * Loads the browser artifact with a stub module loader, a minimal React
 * stand-in, a fake window event registry and a fake localStorage. It proves:
 *   - the module parses, activates and registers its three slots;
 *   - the microphone, the status dock and the shortcut settings row render;
 *   - holding the bound single key starts the camera path (here it fails with
 *     the localized browser-unsupported message because Node has no
 *     MediaRecorder, which still exercises the keyboard entry point);
 *   - the settings row captures a new single key and persists it.
 * It is not a visual check.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.resolve(here, '..', 'client.js')

const windowListeners = new Map()
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(config) {
      captured = config
    },
  },
  addEventListener(type, listener) {
    const list = windowListeners.get(type) ?? []
    list.push(listener)
    windowListeners.set(type, list)
  },
  removeEventListener(type, listener) {
    const list = windowListeners.get(type) ?? []
    const index = list.indexOf(listener)
    if (index !== -1) list.splice(index, 1)
  },
}
const dispatchWindow = (type, event) => {
  for (const listener of windowListeners.get(type) ?? []) listener(event)
}
const documentListeners = new Map()
globalThis.document = {
  addEventListener(type, listener) {
    const list = documentListeners.get(type) ?? []
    list.push(listener)
    documentListeners.set(type, list)
  },
  removeEventListener(type, listener) {
    const list = documentListeners.get(type) ?? []
    const index = list.indexOf(listener)
    if (index !== -1) list.splice(index, 1)
  },
  hidden: false,
}
const storage = new Map()
globalThis.localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null
  },
  setItem(key, value) {
    storage.set(key, String(value))
  },
}

await import(pathToFileURL(clientPath).href)
if (captured === null) throw new Error('module loader was not called')
if (captured.id !== 'dsh-push-to-talk') throw new Error('unexpected module id: ' + captured.id)

const effects = []
const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: props === null ? { children } : Object.assign({}, props, { children }) }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect(effect) {
    effects.push(effect)
  },
  useCallback(fn) {
    return fn
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    if (typeof subscribe !== 'function') throw new Error('useSyncExternalStore received a non-function subscribe')
    if (typeof getSnapshot !== 'function') throw new Error('useSyncExternalStore received a non-function getSnapshot')
    return getSnapshot()
  },
}

const registrations = []
const localeDictionaries = []
const fakeCtx = {
  effect(callback) {
    const disposer = callback()
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
  locale: {
    register(namespace, locale, dict) {
      localeDictionaries.push({ namespace, locale, keys: Object.keys(dict).length })
      return () => {}
    },
    subscribe() {
      return () => {}
    },
    getSnapshot() {
      return { active: 'zh' }
    },
    bind() {
      return (key) => key
    },
  },
  slots: {
    inject(owner, callback) {
      registrations.push({ owner, ...callback() })
      return () => {}
    },
    register(options, component) {
      if (typeof options.name !== 'string' || typeof options.id !== 'string') {
        throw new Error('register() needs a slot name and an id')
      }
      return { options, component, dispose() {} }
    },
  },
}

const status = {
  ok: true,
  providers: [
    {
      id: 'sensevoice-local',
      name: 'SenseVoiceSmall (INT8)',
      location: 'host-local',
      languages: ['auto', 'zh', 'en'],
      setupEstimate: { recommendedDiskBytes: 1_000_000_000, expectedMemoryBytes: 1_000_000_000, minimumMinutes: 1, maximumMinutes: 10 },
      preparation: { phase: 'unprepared' },
    },
  ],
  selection: { providerId: 'sensevoice-local', language: 'auto' },
  limits: { maxAudioBytes: 4_194_304, maxDurationSeconds: 120 },
}
const fetchCalls = []
let hotkeyPollCount = 0
const hotkeyEvents = [
  { seq: 1, type: 'down', key: 'main' },
  { seq: 2, type: 'up', key: 'main' },
  { seq: 3, type: 'down', key: 'shot' },
  { seq: 4, type: 'up', key: 'shot' },
]
globalThis.fetch = async (url, options) => {
  const target = String(url)
  fetchCalls.push({ url: target, body: options?.body })
  return {
    ok: true,
    status: 200,
    json: async () => {
      if (target.includes('/status')) return status
      if (target.includes('/hotkey/bind')) {
        const payload = options?.body ? JSON.parse(options.body) : {}
        return {
          ok: true,
          enabled: payload.enabled === true,
          code: payload.code,
          shotCode: payload.shotCode ?? '',
          ready: true,
          error: '',
        }
      }
      if (target.includes('/hotkey/poll')) {
        const events = hotkeyEvents.slice(hotkeyPollCount, hotkeyPollCount + 1)
        hotkeyPollCount += 1
        return {
          ok: true,
          events,
          state: { enabled: true, code: 'F2', shotCode: 'F3', ready: true, error: '' },
          seq: hotkeyPollCount,
        }
      }
      if (target.includes('/speech/config')) {
        const payload = options?.body ? JSON.parse(options.body) : {}
        if (typeof payload.providerId === 'string') status.selection.providerId = payload.providerId
        if (typeof payload.language === 'string') status.selection.language = payload.language
        return status
      }
      if (target.includes('/screenshot/capture')) {
        // 1x1 transparent PNG.
        return {
          ok: true,
          imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          mediaType: 'image/png',
          width: 1,
          height: 1,
          bytes: 70,
        }
      }
      return { ok: true }
    },
  }
}

const plugin = captured.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error('unexpected require: ' + specifier)
})
if (typeof plugin.apply !== 'function') throw new Error('client plugin has no apply()')
if (!Array.isArray(plugin.inject)) throw new Error('client plugin has no inject list')

plugin.apply(fakeCtx)

if (localeDictionaries.length !== 2) throw new Error('expected zh + en dictionaries, got ' + localeDictionaries.length)
const byOwner = new Map(registrations.map((entry) => [entry.owner, entry]))
for (const expected of ['conversation.input.right', 'conversation.composer.dock']) {
  if (!byOwner.has(expected)) throw new Error('missing slot registration for ' + expected)
}
if (!registrations.some((entry) => entry.owner === 'settings.general.item')) {
  throw new Error('missing slot registration for settings.general.item')
}

const inputActions = {
  captureInsertion() {
    return { draftRev: 1 }
  },
  insertText() {
    return true
  },
  submit() {
    submitted += 1
  },
}
let submitted = 0
const props = { sessionId: 'smoke-session', inputActions }

const mic = registrations.find((entry) => entry.owner === 'conversation.input.right' && entry.options.id === 'push-to-talk-mic')
const quick = registrations.find((entry) => entry.owner === 'conversation.input.right' && entry.options.id === 'push-to-talk-quick')
const dock = registrations.find((entry) => entry.owner === 'conversation.composer.dock' && entry.options.id === 'push-to-talk-status')
const panel = registrations.find((entry) => entry.owner === 'conversation.composer.dock' && entry.options.id === 'push-to-talk-panel')
if (!mic || !quick || !dock || !panel) throw new Error('composer components are not all registered')
const shortcut = registrations.find((entry) => entry.options.id === 'push-to-talk-shortcut')
const keepWarm = registrations.find((entry) => entry.options.id === 'push-to-talk-keep-warm')
const globalRow = registrations.find((entry) => entry.options.id === 'push-to-talk-global')
const screenshotRow = registrations.find((entry) => entry.options.id === 'push-to-talk-screenshot')
const wechatRow = registrations.find((entry) => entry.options.id === 'push-to-talk-wechat')
const overlayRow = registrations.find((entry) => entry.options.id === 'push-to-talk-overlay')
if (!shortcut || !keepWarm || !globalRow || !screenshotRow || !overlayRow || !wechatRow) {
  throw new Error('settings rows are not all registered')
}

const micTree = mic.component(props)
if (!micTree) throw new Error('microphone rendered nothing')

// Run mount effects: they fetch /status and publish the slot context. Cleanups
// are intentionally not invoked here — they belong to unmount.
for (const effect of effects.splice(0)) effect()
await new Promise((resolve) => setTimeout(resolve, 150))

const dockTree = dock.component(props)
if (dockTree === null) throw new Error('dock rendered nothing for an unprepared provider')

const shortcutTree = shortcut.component({})
if (!shortcutTree) throw new Error('shortcut settings row rendered nothing')
const keepWarmTree = keepWarm.component({})
if (!keepWarmTree) throw new Error('keep-warm settings row rendered nothing')
const globalTree = globalRow.component({})
if (!globalTree) throw new Error('global shortcut settings row rendered nothing')
const screenshotTree = screenshotRow.component({})
if (!screenshotTree) throw new Error('screenshot settings row rendered nothing')
const overlayTree = overlayRow.component({})
if (!overlayTree) throw new Error('overlay settings row rendered nothing')
const wechatTree = wechatRow.component({})
if (!wechatTree) throw new Error('wechat settings row rendered nothing')

const flatten = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join(' ')
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
  return children.map(flatten).join(' ')
}
if (!flatten(shortcutTree).includes('F2')) throw new Error('shortcut row does not show the default F2 binding')

const findButtons = (node, found = []) => {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findButtons(child, found)
    return found
  }
  if (node.type === 'button') found.push(node)
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
  for (const child of children) findButtons(child, found)
  return found
}

// Let the capture path reach getUserMedia; Node has no microphone stack, so the
// start still fails, which is exactly the failure the retry action covers.
status.providers[0].preparation = { phase: 'ready' }

const keydownHandlers = windowListeners.get('keydown') ?? []
if (keydownHandlers.length === 0) throw new Error('no global keydown listener registered')

// Holding the bound key enters the capture path; Node has no MediaRecorder, so
// the path settles on the localized "browser cannot record" notice.
const press = (code, key) => {
  const event = {
    code,
    key,
    isComposing: false,
    repeat: false,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true
    },
    stopPropagation() {
      this.stopped = true
    },
  }
  dispatchWindow('keydown', event)
  return event
}
const boundPress = press('F2', 'F2')
if (!boundPress.prevented) throw new Error('the bound key was not intercepted')
await new Promise((resolve) => setTimeout(resolve, 20))

// Settings row: click Change, then press F4 to rebind.
const buttons = findButtons(shortcutTree)
const changeButton = buttons.find((button) => flatten(button).trim() === '修改')
if (!changeButton) throw new Error('shortcut row has no change button')
changeButton.props.onClick()
const capturePress = press('F4', 'F4')
if (!capturePress.prevented || !capturePress.stopped) throw new Error('key capture did not intercept F4')
if (storage.get('dsh.push-to-talk.key') !== 'F4') throw new Error('new binding was not persisted')
const reboundTree = shortcut.component({})
if (!flatten(reboundTree).includes('F4')) throw new Error('shortcut row did not show the new binding')

// Keep-warm switch: toggling persists the preference and flips the label.
const switchButton = findButtons(keepWarmTree).find((button) => button.props?.['role'] === 'switch')
if (!switchButton) throw new Error('keep-warm row has no switch')
switchButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
if (storage.get('dsh.push-to-talk.keep-warm') !== '1') throw new Error('keep-warm preference was not persisted')
const warmTree = keepWarm.component({})
if (!flatten(warmTree).includes('已开启')) throw new Error('keep-warm row did not show the enabled state')

// Global shortcut is ON by default: the page binds the Host helper on load, and
// a delivered down/up pair drives the capture path without a local key.
const initialBind = fetchCalls.find((call) => call.url.includes('/hotkey/bind') && call.body !== undefined)
if (!initialBind) throw new Error('the Host helper was never bound on load')
if (JSON.parse(initialBind.body).enabled !== true) throw new Error('the default global shortcut did not bind the helper')
if (!flatten(globalTree).includes('已开启')) throw new Error('global row does not show the default enabled state')
if (!fetchCalls.some((call) => call.url.includes('/hotkey/poll'))) throw new Error('global event polling never started')

const globalSwitch = findButtons(globalTree).find((button) => button.props?.['role'] === 'switch')
if (!globalSwitch) throw new Error('global shortcut row has no switch')
globalSwitch.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 120))
if (storage.get('dsh.push-to-talk.global') !== '0') throw new Error('disabling the global shortcut was not persisted')
const offBind = fetchCalls.filter((call) => call.url.includes('/hotkey/bind')).pop()
if (!offBind || JSON.parse(offBind.body).enabled !== false) throw new Error('disabling did not stop the helper')
const offTree = globalRow.component({})
if (!flatten(offTree).includes('已关闭')) throw new Error('global row did not show the disabled state')
findButtons(offTree)
  .find((button) => button.props?.['role'] === 'switch')
  .props.onClick()
await new Promise((resolve) => setTimeout(resolve, 120))
const onBind = fetchCalls.filter((call) => call.url.includes('/hotkey/bind')).pop()
if (!onBind || JSON.parse(onBind.body).enabled !== true) throw new Error('re-enabling did not bind the helper')
if (JSON.parse(onBind.body).code !== 'F4') throw new Error('bind used the wrong key: ' + JSON.parse(onBind.body).code)
if (JSON.parse(onBind.body).shotCode !== 'F3') {
  throw new Error('bind did not pass the screenshot key: ' + JSON.parse(onBind.body).shotCode)
}

// Screenshot row: F3 by default, enabled; clicking the key name rebinds it.
if (!flatten(screenshotTree).includes('F3')) throw new Error('screenshot row does not show the default F3 key')
const screenshotSwitch = findButtons(screenshotTree).find((button) => button.props?.['role'] === 'switch')
if (!screenshotSwitch) throw new Error('screenshot row has no switch')
if (screenshotSwitch.props['aria-checked'] !== 'true') throw new Error('screenshot row should default to enabled')
const screenshotKeyButton = findButtons(screenshotTree).find((button) => button.props?.['role'] !== 'switch')
if (!screenshotKeyButton) throw new Error('screenshot row has no key button')
screenshotKeyButton.props.onClick()
const shotCapturePress = press('F5', 'F5')
if (!shotCapturePress.prevented || !shotCapturePress.stopped) throw new Error('screenshot key capture did not intercept F5')
if (storage.get('dsh.push-to-talk.screenshot-key') !== 'F5') throw new Error('screenshot key was not persisted')
const reboundScreenshotTree = screenshotRow.component({})
if (!flatten(reboundScreenshotTree).includes('F5')) throw new Error('screenshot row did not show the new key')
await new Promise((resolve) => setTimeout(resolve, 150))
const shotBind = fetchCalls.filter((call) => call.url.includes('/hotkey/bind')).pop()
if (!shotBind || JSON.parse(shotBind.body).shotCode !== 'F5') {
  throw new Error('rebinding the screenshot key did not reach the helper')
}
// A Host-delivered screenshot press requests one capture through the loopback API.
await new Promise((resolve) => setTimeout(resolve, 900))
if (!fetchCalls.some((call) => call.url.includes('/screenshot/capture'))) {
  throw new Error('the global screenshot press did not request a capture')
}

// Reply overlay switch: experimental and OFF by default; toggling persists both ways.
if (!flatten(overlayTree).includes('已关闭')) throw new Error('overlay row does not show the default disabled state')
const overlaySwitch = findButtons(overlayTree).find((button) => button.props?.['role'] === 'switch')
if (!overlaySwitch) throw new Error('overlay row has no switch')
overlaySwitch.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 20))
if (storage.get('dsh.push-to-talk.overlay') !== '1') throw new Error('enabling the overlay was not persisted')
const overlayOnTree = overlayRow.component({})
if (!flatten(overlayOnTree).includes('已开启')) throw new Error('overlay row did not show the enabled state')
findButtons(overlayOnTree)
  .find((button) => button.props?.['role'] === 'switch')
  .props.onClick()
await new Promise((resolve) => setTimeout(resolve, 20))
if (storage.get('dsh.push-to-talk.overlay') !== '0') throw new Error('disabling the overlay was not persisted')
const overlayOffTree = overlayRow.component({})
if (!flatten(overlayOffTree).includes('已关闭')) throw new Error('overlay row did not show the disabled state')

// WeChat mirror switch: off by default; enabling persists and reaches the Host.
if (!flatten(wechatTree).includes('已关闭')) throw new Error('wechat row does not show the default disabled state')
const wechatSwitch = findButtons(wechatTree).find((button) => button.props?.['role'] === 'switch')
if (!wechatSwitch) throw new Error('wechat row has no switch')
wechatSwitch.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 30))
if (storage.get('dsh.push-to-talk.wechat') !== '1') throw new Error('enabling the WeChat mirror was not persisted')
const wechatConfigCall = fetchCalls.filter((call) => call.url.includes('/wechat/config')).pop()
if (!wechatConfigCall || JSON.parse(wechatConfigCall.body).enabled !== true) {
  throw new Error('enabling the WeChat mirror did not reach the Host')
}
const wechatOnTree = wechatRow.component({})
if (!flatten(wechatOnTree).includes('已开启')) throw new Error('wechat row did not show the enabled state')

// Quick settings: the gear button opens a dock row with the live switches.
if (panel.component({}) !== null) throw new Error('quick panel should start collapsed')
const quickTree = quick.component({})
const gearButton = findButtons(quickTree)[0]
if (!gearButton) throw new Error('quick settings button rendered nothing')
gearButton.props.onClick()
const openPanel = panel.component({})
if (openPanel === null) throw new Error('quick panel did not open')
const panelText = flatten(openPanel)
if (!panelText.includes('回复同步到微信')) throw new Error('quick panel is missing the WeChat switch')
if (!panelText.includes('识别语言')) throw new Error('quick panel is missing the language dropdown')
const panelSelects = []
const collectSelects = (node) => {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) collectSelects(child)
    return
  }
  if (node.type === 'select') panelSelects.push(node)
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
  for (const child of children) collectSelects(child)
}
collectSelects(openPanel)
if (panelSelects.length < 2) throw new Error('quick panel should render provider and language selects: ' + panelSelects.length)
const languageSelect = panelSelects[1]
languageSelect.props.onChange({ target: { value: 'en' } })
await new Promise((resolve) => setTimeout(resolve, 40))
const speechCall = fetchCalls.filter((call) => call.url.includes('/speech/config')).pop()
if (!speechCall || JSON.parse(speechCall.body).language !== 'en') throw new Error('language change did not reach the Host')
// Collapse again; the row disappears (re-render first: the handler closes over state).
const quickTreeOpen = quick.component({})
findButtons(quickTreeOpen)[0].props.onClick()
if (panel.component({}) !== null) throw new Error('quick panel did not collapse')

// A failed microphone start keeps a retry action in the dock. Press the mic
// button directly so the path does not depend on poll timing; Node has no
// microphone stack, so the start fails with the localized error notice.
const micButtonNode = findButtons(micTree)[0]
micButtonNode.props.onPointerDown({
  pointerType: 'touch',
  pointerId: 1,
  clientY: 0,
  button: 0,
  preventDefault() {},
  currentTarget: { setPointerCapture() {} },
})
await new Promise((resolve) => setTimeout(resolve, 250))
const failedDock = dock.component(props)
const retryButtons = findButtons(failedDock).filter((button) => flatten(button).trim() === '重试')
if (retryButtons.length === 0) throw new Error('a failed microphone start did not offer a retry action')

console.log('smoke ok')
console.log('  injections:', plugin.inject.join(', '))
console.log('  dictionaries:', localeDictionaries.map((entry) => entry.namespace + ':' + entry.locale + '=' + entry.keys).join(' '))
console.log('  slots:', registrations.map((entry) => entry.owner + '#' + entry.options.id + '@' + entry.options.order).join(' '))
console.log('  default key: F2, rebound to:', storage.get('dsh.push-to-talk.key'))
process.exit(0)
