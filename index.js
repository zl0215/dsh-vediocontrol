/**
 * Push-to-talk — Host half.
 *
 * Bridges the browser's press-and-hold recording to the Host `speechToText`
 * service. The voice-input bundle already provides that service (SenseVoice
 * local model or a cloud provider), so this plugin only exposes a small
 * loopback-only JSON API on the existing Web server:
 *
 *   GET  /push-to-talk/api/status          → selected provider, readiness, limits
 *   POST /push-to-talk/api/transcribe      → { audioBase64 } → { text }
 *   POST /push-to-talk/api/prepare         → start provider preparation
 *   POST /push-to-talk/api/hotkey/bind     → start/stop the global key helper
 *   GET  /push-to-talk/api/hotkey/state    → helper status
 *   GET  /push-to-talk/api/hotkey/poll     → long-poll for down/up events
 *   POST /push-to-talk/api/screenshot/capture → { imageBase64, width, height, bytes }
 *
 * The global key helper is a small Windows PowerShell script (`hotkey.ps1`)
 * that installs a low-level keyboard hook for two keys: the push-to-talk key
 * (hold to dictate) and the screenshot key (press to capture and send). The
 * browser cannot see those keys, so the Host forwards the down/up events to the
 * page over the poll route and the page records, transcribes and submits as
 * usual. A second helper (`screenshot.ps1`) captures the virtual desktop on
 * demand and hands the PNG back through the loopback route only.
 *
 * Audio stays transient: nothing here writes a Session event or attachment.
 */

import { spawn } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const ROUTE_PREFIX = '/push-to-talk/api'
/** Matches the voice-input bundle's default advertised recording limits. */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024
const MAX_DURATION_SECONDS = 120
const MAX_BODY_BYTES = 8 * 1024 * 1024
const TRANSCRIBE_TIMEOUT_MS = 180_000

const HOTKEY_SCRIPT = fileURLToPath(new URL('./hotkey.ps1', import.meta.url))
const OVERLAY_SCRIPT = fileURLToPath(new URL('./overlay.ps1', import.meta.url))
const SCREENSHOT_SCRIPT = fileURLToPath(new URL('./screenshot.ps1', import.meta.url))
const HOTKEY_READY_TIMEOUT_MS = 10_000
const HOTKEY_POLL_TIMEOUT_MS = 20_000
const HOTKEY_EVENT_HISTORY = 32
const SCREENSHOT_READY_TIMEOUT_MS = 20_000
const SCREENSHOT_CAPTURE_TIMEOUT_MS = 20_000
const SCREENSHOT_MAX_WIDTH = 1920
const SCREENSHOT_MAX_BYTES = 32 * 1024 * 1024
const OVERLAY_READY_TIMEOUT_MS = 20_000
const OVERLAY_MAX_CHARS = 1200
const OVERLAY_SECONDS = 10
const OVERLAY_DEFAULT_OPACITY = 92
const OVERLAY_DEFAULT_FONT = 'Microsoft YaHei UI'
const OVERLAY_DEFAULT_FONT_SIZE = 20
const OVERLAY_STREAM_FLUSH_MS = 120
const HOTKEY_KEYS = new Set([
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight',
])

export const name = 'dsh-push-to-talk'

/** The Web carrier and the shared speech registry are both optional services. */
export const inject = ['webServer']

function send(res, status, body) {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/** The classic Windows PowerShell that hosts both helper scripts. */
function powershellPath() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** Only the local machine may drive the microphone bridge. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { code: 'tooLarge' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('请求格式无效'), { code: 'badRequest' }))
      }
    })
    req.on('error', reject)
  })
}

function describe(snapshot) {
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : []
  return {
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      location: provider.location,
      languages: provider.languages,
      setupEstimate: provider.setupEstimate,
      downloadSources: provider.downloadSources,
      preparation: provider.preparation,
    })),
    selection: snapshot?.selection,
    limits: { maxAudioBytes: MAX_AUDIO_BYTES, maxDurationSeconds: MAX_DURATION_SECONDS },
  }
}

/**
 * One spawned PowerShell helper, its event ring and the long-poll waiters.
 * Reports the push-to-talk key and the screenshot key; the hook never swallows
 * either key.
 */
function createHotkeyBridge(ctx) {
  let child = null
  let enabled = false
  let code = ''
  let shotCode = ''
  let ready = false
  let error = ''
  let seq = 0
  const history = []
  const waiters = new Set()

  const state = () => ({ enabled, code, shotCode, ready, error })

  function notify() {
    for (const waiter of [...waiters]) {
      try {
        waiter()
      } catch {}
    }
  }

  function push(type, key) {
    seq += 1
    history.push({ seq, type, key })
    if (history.length > HOTKEY_EVENT_HISTORY) history.shift()
    notify()
  }

  function stop() {
    enabled = false
    ready = false
    const current = child
    child = null
    if (current !== null) {
      try {
        current.kill()
      } catch {}
    }
    notify()
  }

  function start(nextCode, nextShotCode) {
    stop()
    enabled = true
    code = nextCode
    shotCode = nextShotCode
    ready = false
    error = ''
    if (process.platform !== 'win32') {
      enabled = false
      error = '全局快捷键目前仅支持 Windows'
      notify()
      return
    }
    let proc
    try {
      proc = spawn(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOTKEY_SCRIPT],
        {
          env: {
            ...process.env,
            DSH_PTT_KEY: nextCode,
            ...(nextShotCode === '' ? {} : { DSH_PTT_SHOT_KEY: nextShotCode }),
          },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
    } catch (failure) {
      enabled = false
      error = failure instanceof Error ? failure.message : String(failure)
      notify()
      return
    }
    child = proc
    const readyTimer = setTimeout(() => {
      if (child === proc && !ready) {
        error = '全局快捷键助手未就绪'
        notify()
      }
    }, HOTKEY_READY_TIMEOUT_MS)

    let buffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line === '') continue
        if (line === 'ready') {
          clearTimeout(readyTimer)
          ready = true
          error = ''
          notify()
        } else if (line === 'down') {
          push('down', 'main')
        } else if (line === 'up') {
          push('up', 'main')
        } else if (line === 'down main' || line === 'down shot') {
          push('down', line.slice(5).trim())
        } else if (line === 'up main' || line === 'up shot') {
          push('up', line.slice(3).trim())
        } else if (line.startsWith('error')) {
          error = line.slice(5).trim() || '全局快捷键助手出错'
          notify()
        }
      }
    })

    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-500)
    })

    proc.on('error', (failure) => {
      error = failure instanceof Error ? failure.message : String(failure)
      notify()
    })
    proc.on('exit', (exitCode) => {
      clearTimeout(readyTimer)
      if (child !== proc) return
      child = null
      ready = false
      if (enabled) {
        const detail = stderr.trim()
        error = detail.length > 0 ? detail : `全局快捷键助手已退出（${exitCode ?? '?'}）`
      }
      notify()
    })
  }

  function bind(nextEnabled, nextCode, nextShotCode) {
    const wanted = typeof nextCode === 'string' && HOTKEY_KEYS.has(nextCode) ? nextCode : code || 'F2'
    const wantedShot =
      typeof nextShotCode === 'string' && (nextShotCode === '' || HOTKEY_KEYS.has(nextShotCode))
        ? nextShotCode
        : shotCode
    if (nextEnabled === true) {
      // Reuse a live helper; a repeated bind from the page (for example on
      // window focus) must not restart it and reopen the compile/hook cost.
      const reusable = enabled && child !== null && code === wanted && shotCode === wantedShot
      if (!reusable) start(wanted, wantedShot)
    } else {
      stop()
      code = wanted
      shotCode = wantedShot
      error = ''
    }
    return state()
  }

  /** Resolve immediately with pending events, or on the next event/state change. */
  function poll(since, timeoutMs) {
    const immediate = history.filter((event) => event.seq > since)
    if (immediate.length > 0) return Promise.resolve({ events: immediate, state: state() })
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waiters.delete(waiter)
        resolve({ events: history.filter((event) => event.seq > since), state: state() })
      }
      const timer = setTimeout(finish, timeoutMs)
      const waiter = () => finish()
      waiters.add(waiter)
    })
  }

  function dispose() {
    stop()
    for (const waiter of [...waiters]) {
      try {
        waiter()
      } catch {}
    }
  }

  return { bind, poll, state, dispose, platform: process.platform }
}

/**
 * One spawned screenshot helper (`screenshot.ps1`). Captures are serialized:
 * one `capture` command at a time, answered by one `ok <path> <w> <h> <bytes>`
 * line. The helper keeps running between captures.
 */
function createScreenshotBridge(ctx) {
  let child = null
  let ready = false
  let error = ''
  let buffer = ''
  let queue = Promise.resolve()
  let pending = null
  const waiters = new Set()

  const state = () => ({ ready, error })

  function notify() {
    for (const waiter of [...waiters]) {
      try {
        waiter()
      } catch {}
    }
  }

  function finishCapture(method) {
    const current = pending
    pending = null
    if (current !== null) {
      try {
        current[method]()
      } catch {}
    }
  }

  function handleLine(line) {
    if (line === 'ready') {
      ready = true
      error = ''
      notify()
      return
    }
    if (line.startsWith('ok ')) {
      const parts = line.split(' ')
      // ok <path> <width> <height> <bytes>; a path may theoretically contain
      // spaces, so parse from the right.
      if (parts.length >= 5) {
        const rest = parts.slice(1)
        const bytes = Number(rest[rest.length - 1])
        const height = Number(rest[rest.length - 2])
        const width = Number(rest[rest.length - 3])
        const path = rest.slice(0, rest.length - 3).join(' ')
        if (pending !== null) {
          const resolve = pending.resolve
          pending = null
          resolve({ path, width, height, bytes })
        }
        return
      }
      error = '截图助手返回了无效结果'
      finishCapture('rejectWithError')
      return
    }
    if (line.startsWith('error')) {
      error = line.slice(5).trim() || '截图助手出错'
      finishCapture('rejectWithError')
    }
  }

  function spawnHelper() {
    if (child !== null) return
    if (process.platform !== 'win32') {
      error = '截图目前仅支持 Windows'
      notify()
      return
    }
    let proc
    try {
      proc = spawn(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCREENSHOT_SCRIPT],
        {
          env: { ...process.env, DSH_SCREENSHOT_MAX_WIDTH: String(SCREENSHOT_MAX_WIDTH) },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
      notify()
      return
    }
    child = proc
    ready = false
    error = ''

    let stderr = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line !== '') handleLine(line)
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-500)
    })
    proc.on('error', (failure) => {
      error = failure instanceof Error ? failure.message : String(failure)
      finishCapture('rejectWithError')
      notify()
    })
    proc.on('exit', (exitCode) => {
      if (child !== proc) return
      child = null
      ready = false
      if (error === '') {
        const detail = stderr.trim()
        error = detail.length > 0 ? detail : `截图助手已退出（${exitCode ?? '?'}）`
      }
      notify()
    })
  }

  function ensureStarted() {
    if (ready && child !== null) return Promise.resolve(true)
    spawnHelper()
    if (child === null) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waiters.delete(waiter)
        resolve(value)
      }
      const waiter = () => {
        if (ready) finish(true)
        else if (child === null) finish(false)
      }
      const timer = setTimeout(() => finish(ready), SCREENSHOT_READY_TIMEOUT_MS)
      waiters.add(waiter)
    })
  }

  /** Capture one PNG; resolves { path, width, height, bytes }. */
  function capture() {
    const run = () =>
      new Promise((resolve, reject) => {
        spawnHelper()
        if (child === null) {
          reject(new Error(error || '截图助手不可用'))
          return
        }
        ensureStarted().then((started) => {
          if (!started) {
            reject(new Error(error || '截图助手未就绪'))
            return
          }
          const timer = setTimeout(() => {
            if (pending !== null) {
              pending = null
              reject(new Error('截图超时'))
            }
          }, SCREENSHOT_CAPTURE_TIMEOUT_MS)
          pending = {
            resolve: (value) => {
              clearTimeout(timer)
              resolve(value)
            },
            rejectWithError: () => {
              clearTimeout(timer)
              reject(new Error(error || '截图失败'))
            },
          }
          try {
            child.stdin.write('capture\n')
          } catch (failure) {
            pending = null
            clearTimeout(timer)
            reject(failure instanceof Error ? failure : new Error(String(failure)))
          }
        })
      })
    const next = queue.then(run, run)
    queue = next.catch(() => {})
    return next
  }

  function dispose() {
    const current = child
    child = null
    ready = false
    finishCapture('rejectWithError')
    if (current !== null) {
      try {
        current.stdin.write('quit\n')
      } catch {}
      setTimeout(() => {
        try {
          current.kill()
        } catch {}
      }, 800)
    }
    notify()
  }

  return { capture, state, dispose }
}

/**
 * The reply overlay: one spawned PowerShell/WPF process with a transparent,
 * topmost, click-through text window. The Host arms it after a dictation and
 * feeds the assistant's reply text from the durable session feed.
 */
function createOverlayBridge(ctx) {
  let child = null
  let ready = false
  let error = ''
  let armedSession = null
  let lastText = ''
  let visible = false
  let streamText = ''
  let flushTimer = null
  let seenSessionEvents = 0
  let seenStreamFrames = 0
  let lastSessionEventType = ''
  let lastSessionArgType = ''
  let lastSessionArgId = ''
  let lastStreamAgentId = ''
  let lastMessageSession = ''
  let lastMessageChars = 0
  let matchedStreamFrames = 0
  const config = {
    opacity: OVERLAY_DEFAULT_OPACITY,
    fontFamily: OVERLAY_DEFAULT_FONT,
    fontSize: OVERLAY_DEFAULT_FONT_SIZE,
  }
  const waiters = new Set()

  const state = () => ({
    ready,
    error,
    armed: armedSession !== null,
    visible,
    lastText: lastText.slice(0, 80),
    debug: {
      seenSessionEvents,
      seenStreamFrames,
      lastSessionEventType,
      lastSessionArgType,
      lastSessionArgId,
      lastStreamAgentId,
      lastMessageSession,
      lastMessageChars,
      matchedStreamFrames,
    },
    config: { ...config },
  })

  function notify() {
    for (const waiter of [...waiters]) {
      try {
        waiter()
      } catch {}
    }
  }

  function spawnOverlay() {
    if (child !== null) return
    if (process.platform !== 'win32') {
      error = '回复浮窗目前仅支持 Windows'
      notify()
      return
    }
    let proc
    try {
      proc = spawn(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OVERLAY_SCRIPT],
        {
          env: {
            ...process.env,
            DSH_OVERLAY_SECONDS: String(OVERLAY_SECONDS),
            DSH_OVERLAY_OPACITY: String(config.opacity),
            DSH_OVERLAY_FONT: config.fontFamily,
            DSH_OVERLAY_FONT_SIZE: String(config.fontSize),
          },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
      notify()
      return
    }
    child = proc
    ready = false
    error = ''
    const readyTimer = setTimeout(() => {
      if (child === proc && !ready) {
        error = '回复浮窗未就绪'
        notify()
      }
    }, OVERLAY_READY_TIMEOUT_MS)

    let buffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line === '') continue
        if (line === 'ready') {
          clearTimeout(readyTimer)
          ready = true
          error = ''
          notify()
        } else if (line.startsWith('error')) {
          error = line.slice(5).trim() || '回复浮窗出错'
          notify()
        }
      }
    })

    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-500)
    })

    proc.on('error', (failure) => {
      error = failure instanceof Error ? failure.message : String(failure)
      notify()
    })
    proc.on('exit', (exitCode) => {
      clearTimeout(readyTimer)
      if (child !== proc) return
      child = null
      ready = false
      visible = false
      if (error === '') {
        const detail = stderr.trim()
        error = detail.length > 0 ? detail : `回复浮窗已退出（${exitCode ?? '?'}）`
      }
      notify()
    })
  }

  function ensureStarted() {
    if (child !== null && ready) return Promise.resolve(true)
    spawnOverlay()
    if (child === null) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waiters.delete(waiter)
        resolve(value)
      }
      const waiter = () => {
        if (ready) finish(true)
        else if (child === null) finish(false)
      }
      const timer = setTimeout(() => finish(ready), OVERLAY_READY_TIMEOUT_MS)
      waiters.add(waiter)
    })
  }

  function writeLine(line) {
    if (child === null) return false
    try {
      if (child.stdin.writable) {
        child.stdin.write(line + '\n')
        return true
      }
    } catch {}
    return false
  }

  function writeOverlay(prefix, text) {
    const value = normalizeOverlayText(text)
    if (value === '') return
    lastText = value
    void ensureStarted().then((started) => {
      if (!started) return
      if (writeLine(prefix + ' ' + Buffer.from(value, 'utf8').toString('base64'))) {
        visible = true
        notify()
      }
    })
  }

  function show(text) {
    writeOverlay('show', text)
  }

  /** Live update while the assistant is still writing; keeps the panel visible. */
  function stream(text) {
    writeOverlay('stream', text)
  }

  function hide() {
    if (writeLine('hide')) {
      visible = false
      notify()
    }
  }

  function clearStream() {
    streamText = ''
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  /** Coalesce text deltas so the helper redraws at most every ~120 ms. */
  function scheduleStream() {
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      if (streamText !== '') stream(streamText)
    }, OVERLAY_STREAM_FLUSH_MS)
  }

  function configure(patch) {
    if (patch === null || typeof patch !== 'object') return state()
    if (typeof patch.opacity === 'number' && Number.isFinite(patch.opacity)) {
      config.opacity = Math.max(0, Math.min(100, Math.round(patch.opacity)))
    }
    if (typeof patch.fontFamily === 'string' && patch.fontFamily.trim() !== '' && patch.fontFamily.length <= 64) {
      config.fontFamily = patch.fontFamily.trim()
    }
    if (typeof patch.fontSize === 'number' && Number.isFinite(patch.fontSize)) {
      config.fontSize = Math.max(10, Math.min(40, Math.round(patch.fontSize)))
    }
    // The helper reads its appearance from the environment at startup, so the
    // next show spawns a fresh one with the new opacity and font.
    disposeChild()
    notify()
    return state()
  }

  /** Arm one session: its next assistant replies are mirrored on screen. */
  function arm(sessionId) {
    const normalized = normalizeSessionId(sessionId)
    if (normalized === '') return false
    armedSession = normalized
    lastText = ''
    clearStream()
    show('正在处理你的请求…')
    return true
  }

  function disarm() {
    armedSession = null
    clearStream()
    notify()
  }

  /** Mirror the process-local assistant stream for the armed session. */
  function handleAssistantStream(sessionId, frame) {
    seenStreamFrames += 1
    lastStreamAgentId = typeof sessionId === 'string' ? sessionId : ''
    if (armedSession === null || normalizeSessionId(sessionId) !== armedSession) return
    matchedStreamFrames += 1
    const type = frame?.type
    if (type === 'start') {
      clearStream()
      return
    }
    if (type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      streamText += chunk.text
      scheduleStream()
    }
  }

  /** Mirror the durable session feed; the caller filters by armed session. */
  function handleSessionEvent(session, event) {
    seenSessionEvents += 1
    lastSessionEventType = typeof event?.type === 'string' ? event.type : ''
    lastSessionArgType = typeof session
    lastSessionArgId =
      session === null || session === undefined
        ? ''
        : typeof session === 'string'
          ? session
          : typeof session.id === 'string'
            ? session.id
            : ''
    const type = event?.type
    const text = type === 'assistant/message' ? messageText(event.data?.message) : ''
    if (type === 'assistant/message') {
      lastMessageSession = typeof session?.id === 'string' ? session.id : ''
      lastMessageChars = text.length
    }
    if (armedSession === null) return
    if (session === undefined || normalizeSessionId(session.id) !== armedSession) return
    if (type === 'assistant/message') {
      clearStream()
      if (text !== '') show(text)
      return
    }
    if (type === 'turn/end') {
      const reason = event.data?.reason
      if (reason?.kind === 'error' && lastText === '') {
        show('请求失败：' + (reason.error?.message ?? '未知错误'))
      }
      disarm()
    }
  }

  function disposeChild() {
    if (child === null) return
    writeLine('quit')
    const current = child
    child = null
    ready = false
    visible = false
    setTimeout(() => {
      try {
        current.kill()
      } catch {}
    }, 800)
  }

  function dispose() {
    disposeChild()
    notify()
  }

  return { arm, disarm, show, stream, hide, configure, state, handleAssistantStream, handleSessionEvent, dispose }
}

function normalizeSessionId(value) {
  if (typeof value !== 'string') return ''
  return value.startsWith('session-') ? value.slice('session-'.length) : value
}

function normalizeOverlayText(text) {
  let value = String(text ?? '').replace(/\r\n/g, '\n')
  if (value.trim() === '') return ''
  value = value.replace(/```[a-zA-Z0-9_+#.-]*\n/g, '').replace(/```/g, '')
  value = value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (value.length > OVERLAY_MAX_CHARS) value = value.slice(0, OVERLAY_MAX_CHARS - 1) + '…'
  return value
}

function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
  }
  return normalizeOverlayText(parts.join('\n'))
}

async function handle(req, res, ctx, hotkey, overlay, screenshot) {
  if (!isLoopback(req)) {
    send(res, 403, fail('forbidden', '仅允许本机访问语音接口'))
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
  const speech = ctx.get('speechToText')

  if (path === '/status' && req.method === 'GET') {
    if (!speech) {
      send(res, 503, fail('unavailable', '语音识别服务未启用：请启用语音输入插件包'))
      return
    }
    send(res, 200, { ok: true, ...describe(speech.snapshot()) })
    return
  }

  if (path === '/transcribe' && req.method === 'POST') {
    if (!speech) {
      send(res, 503, fail('unavailable', '语音识别服务未启用：请启用语音输入插件包'))
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      send(res, error.code === 'tooLarge' ? 413 : 400, fail(error.code ?? 'badRequest', error.message))
      return
    }
    const encoded = typeof body?.audioBase64 === 'string' ? body.audioBase64 : ''
    if (encoded.length === 0) {
      send(res, 400, fail('badRequest', '缺少录音数据'))
      return
    }
    const audio = Buffer.from(encoded, 'base64')
    if (audio.length < 44) {
      send(res, 400, fail('badRequest', '录音数据不完整'))
      return
    }
    if (audio.length > MAX_AUDIO_BYTES) {
      send(res, 413, fail('tooLarge', '录音超过服务限制'))
      return
    }
    if (audio.toString('latin1', 0, 4) !== 'RIFF' || audio.toString('latin1', 8, 12) !== 'WAVE') {
      send(res, 400, fail('badRequest', '录音格式无效：需要 16 kHz 单声道 WAV'))
      return
    }
    let spec
    try {
      const language = typeof body?.language === 'string' && body.language.length > 0 ? body.language : undefined
      spec = speech.resolve({ audio: new Uint8Array(audio), ...(language === undefined ? {} : { language }) })
    } catch (error) {
      send(res, 400, fail('resolve', error instanceof Error ? error.message : String(error)))
      return
    }
    try {
      const transcript = await speech.transcribe(spec, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS))
      send(res, 200, {
        ok: true,
        text: transcript.text,
        audioSeconds: transcript.audioSeconds,
        inferenceSeconds: transcript.inferenceSeconds,
      })
    } catch (error) {
      send(res, 500, fail('transcribe', error instanceof Error ? error.message : String(error)))
    }
    return
  }

  if (path === '/prepare' && req.method === 'POST') {
    if (!speech) {
      send(res, 503, fail('unavailable', '语音识别服务未启用：请启用语音输入插件包'))
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      send(res, error.code === 'tooLarge' ? 413 : 400, fail(error.code ?? 'badRequest', error.message))
      return
    }
    const providerId = typeof body?.providerId === 'string' && body.providerId.length > 0
      ? body.providerId
      : speech.snapshot()?.selection?.providerId
    if (typeof providerId !== 'string' || providerId.length === 0) {
      send(res, 400, fail('badRequest', '尚未选择语音识别服务'))
      return
    }
    try {
      const options = typeof body?.downloadSource === 'string' && body.downloadSource.length > 0
        ? { downloadSource: body.downloadSource }
        : undefined
      speech.prepare(providerId, options)
    } catch (error) {
      send(res, 500, fail('prepare', error instanceof Error ? error.message : String(error)))
      return
    }
    send(res, 202, { ok: true })
    return
  }

  if (path === '/hotkey/bind' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      send(res, error.code === 'tooLarge' ? 413 : 400, fail(error.code ?? 'badRequest', error.message))
      return
    }
    const next = hotkey.bind(
      body?.enabled === true,
      typeof body?.code === 'string' ? body.code : '',
      typeof body?.shotCode === 'string' ? body.shotCode : '',
    )
    send(res, 200, { ok: true, ...next, seq: 0 })
    return
  }

  if (path === '/hotkey/state' && req.method === 'GET') {
    send(res, 200, { ok: true, ...hotkey.state() })
    return
  }

  if (path === '/hotkey/poll' && req.method === 'GET') {
    const sinceRaw = Number.parseInt(url.searchParams.get('since') ?? '0', 10)
    const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 0
    const result = await hotkey.poll(since, HOTKEY_POLL_TIMEOUT_MS)
    send(res, 200, { ok: true, events: result.events, state: result.state, seq: result.events.length > 0 ? result.events[result.events.length - 1].seq : since })
    return
  }

  if (path === '/screenshot/capture' && req.method === 'POST') {
    if (process.platform !== 'win32') {
      send(res, 503, fail('unsupported', '截图目前仅支持 Windows'))
      return
    }
    let shot
    try {
      shot = await screenshot.capture()
    } catch (error) {
      send(res, 500, fail('capture', error instanceof Error ? error.message : String(error)))
      return
    }
    let data
    try {
      data = await readFile(shot.path)
    } catch (error) {
      send(res, 500, fail('read', error instanceof Error ? error.message : String(error)))
      return
    } finally {
      try {
        await unlink(shot.path)
      } catch {}
    }
    if (data.length > SCREENSHOT_MAX_BYTES) {
      send(res, 413, fail('tooLarge', '截图文件过大'))
      return
    }
    send(res, 200, {
      ok: true,
      imageBase64: data.toString('base64'),
      mediaType: 'image/png',
      width: shot.width,
      height: shot.height,
      bytes: data.length,
    })
    return
  }

  if (path === '/overlay/arm' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      send(res, error.code === 'tooLarge' ? 413 : 400, fail(error.code ?? 'badRequest', error.message))
      return
    }
    if (!overlay.arm(typeof body?.sessionId === 'string' ? body.sessionId : '')) {
      send(res, 400, fail('badRequest', '缺少会话标识'))
      return
    }
    send(res, 200, { ok: true })
    return
  }

  if (path === '/overlay/show' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      send(res, error.code === 'tooLarge' ? 413 : 400, fail(error.code ?? 'badRequest', error.message))
      return
    }
    overlay.show(typeof body?.text === 'string' ? body.text : '')
    send(res, 200, { ok: true })
    return
  }

  if (path === '/overlay/hide' && req.method === 'POST') {
    overlay.hide()
    send(res, 200, { ok: true })
    return
  }

  if (path === '/overlay/config' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      send(res, error.code === 'tooLarge' ? 413 : 400, fail(error.code ?? 'badRequest', error.message))
      return
    }
    send(res, 200, { ok: true, ...overlay.configure(body) })
    return
  }

  if (path === '/overlay/state' && req.method === 'GET') {
    send(res, 200, { ok: true, ...overlay.state() })
    return
  }

  send(res, 404, fail('notFound', '未知的语音接口'))
}

export function apply(ctx) {
  const hotkey = createHotkeyBridge(ctx)
  const overlay = createOverlayBridge(ctx)
  const screenshot = createScreenshotBridge(ctx)
  const handler = (req, res) => {
    Promise.resolve(handle(req, res, ctx, hotkey, overlay, screenshot)).catch((error) => {
      try {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      } catch {}
      send(res, 500, fail('internal', error instanceof Error ? error.message : String(error)))
    })
  }
  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
    return () => {
      try {
        disposeRoute()
      } catch {}
      hotkey.dispose()
      overlay.dispose()
      screenshot.dispose()
    }
  }, 'push-to-talk: loopback speech, hotkey, screenshot and overlay bridges')

  // Mirror one armed session's assistant replies onto the overlay. Streaming
  // deltas keep the panel live; the durable session feed holds the final text.
  ctx.effect(() => {
    const offStream = ctx.on('agent/assistant-stream', (payload) => {
      try {
        overlay.handleAssistantStream(payload?.agent?.id, payload?.frame)
      } catch {}
    })
    const offSession = ctx.on('session/event', (session, event) => {
      try {
        overlay.handleSessionEvent(session, event)
      } catch {}
    })
    return () => {
      try {
        if (typeof offStream === 'function') offStream()
      } catch {}
      try {
        if (typeof offSession === 'function') offSession()
      } catch {}
    }
  }, 'push-to-talk: reply overlay feeds')
}
