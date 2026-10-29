/**
 * Push-to-talk — Client half.
 *
 * A press-and-hold microphone in the composer and a global single-key hold
 * shortcut: hold to record, release to transcribe and send. Capture,
 * resampling and WAV encoding follow the shipped voice-input implementation
 * (MIT, DeepSeek Harness) so the Host receives the canonical 16 kHz mono PCM16
 * WAV it expects.
 */
window.__ModuleLoader__.load({
  id: 'dsh-push-to-talk',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'push-to-talk'
    const API = '/push-to-talk/api'
    /** A shorter press is treated as an accidental tap, not dictation. */
    const MIN_HOLD_MS = 350
    /** Sliding the finger this far up before release cancels the capture. */
    const CANCEL_DRAG_PX = 72
    const MAX_DURATION_SECONDS = 120
    const MAX_AUDIO_BYTES = 4 * 1024 * 1024
    const TRANSCRIBE_TIMEOUT_MS = 180_000
    const NOTICE_MS = 4500
    const POLL_MS = 1500
    /** Single non-printing key held to talk; any of the bindable keys can replace it. */
    const DEFAULT_KEY_CODE = 'F2'
    const KEY_STORAGE = 'dsh.push-to-talk.key'
    const MODIFIER_CODES = new Set([
      'ShiftLeft',
      'ShiftRight',
      'ControlLeft',
      'ControlRight',
      'AltLeft',
      'AltRight',
      'MetaLeft',
      'MetaRight',
    ])
    // A held key only ends the recording when the browser reliably delivers its
    // keyup. Function keys and modifier keys do; CapsLock/ScrollLock/Pause and
    // the Windows/Meta keys have platform quirks (toggle or OS menu on release),
    // so they are deliberately not bindable.
    const BINDABLE_CODES = new Set([
      'ControlLeft',
      'ControlRight',
      'AltLeft',
      'AltRight',
      'ShiftLeft',
      'ShiftRight',
    ])
    function isBindableKey(code) {
      return typeof code === 'string' && (/^F([1-9]|1[0-2])$/.test(code) || BINDABLE_CODES.has(code))
    }
    function loadStoredKey() {
      try {
        const stored = localStorage.getItem(KEY_STORAGE)
        return isBindableKey(stored) ? stored : DEFAULT_KEY_CODE
      } catch {
        return DEFAULT_KEY_CODE
      }
    }
    function storeKey(code) {
      try {
        localStorage.setItem(KEY_STORAGE, code)
      } catch {}
    }
    const KEEP_WARM_STORAGE = 'dsh.push-to-talk.keep-warm'
    const WARM_HINT_STORAGE = 'dsh.push-to-talk.warm-hint'
    function loadKeepWarm() {
      try {
        return localStorage.getItem(KEEP_WARM_STORAGE) === '1'
      } catch {
        return false
      }
    }
    function storeKeepWarm(value) {
      try {
        localStorage.setItem(KEEP_WARM_STORAGE, value === true ? '1' : '0')
      } catch {}
    }
    function loadWarmHintSeen() {
      try {
        return localStorage.getItem(WARM_HINT_STORAGE) === '1'
      } catch {
        return true
      }
    }
    function storeWarmHintSeen() {
      try {
        localStorage.setItem(WARM_HINT_STORAGE, '1')
      } catch {}
    }
    const GLOBAL_STORAGE = 'dsh.push-to-talk.global'
    const OVERLAY_STORAGE = 'dsh.push-to-talk.overlay'
    function loadGlobalHotkey() {
      try {
        // On by default: the plugin exists to dictate from anywhere. An explicit
        // '0' from the settings switch keeps it off.
        return localStorage.getItem(GLOBAL_STORAGE) !== '0'
      } catch {
        return true
      }
    }
    function storeGlobalHotkey(value) {
      try {
        localStorage.setItem(GLOBAL_STORAGE, value === true ? '1' : '0')
      } catch {}
    }
    function loadReplyOverlay() {
      try {
        // On by default too; the switch stores an explicit '0' to disable it.
        return localStorage.getItem(OVERLAY_STORAGE) !== '0'
      } catch {
        return true
      }
    }
    function storeReplyOverlay(value) {
      try {
        localStorage.setItem(OVERLAY_STORAGE, value === true ? '1' : '0')
      } catch {}
    }

    //#region dictionaries
    const zh = {
      hold: '按住说话',
      holdHint: '按住麦克风说话，松开后识别到输入框',
      recording: '正在聆听',
      release: '松开发送',
      releaseCancel: '松开取消',
      slideCancel: '上滑取消',
      requesting: '请允许使用麦克风…',
      opening: '正在打开麦克风…',
      transcribing: '正在识别…',
      prepare: '下载并准备',
      preparing: '正在准备语音识别…',
      'prep.checking': '正在检查本地资源…',
      'prep.downloading': '正在下载模型 {percent}%',
      'prep.loading': '正在加载模型…',
      'prep.waking': '正在唤醒语音识别…',
      'prep.cancelling': '正在取消准备…',
      'prep.unprepared': '首次使用需要下载本地语音识别模型',
      'prep.setup': '需要先准备语音识别模型，约 {gb} GB 硬盘空间。',
      setupTitle: '语音识别尚未就绪',
      conflict: '输入框内容已变化，识别结果已保留。',
      insert: '插入并发送',
      discard: '丢弃',
      dismiss: '关闭',
      empty: '没有识别到语音，请再试一次。',
      tooShort: '说话时间太短，已取消。',
      authorized: '麦克风已授权。请再次按住说话。',
      warming: '正在准备麦克风…',
      cancelled: '已取消语音输入。',
      tooLarge: '录音过长，已取消。',
      failed: '语音识别失败：{message}',
      unavailable: '当前浏览器不支持录音。',
      permission: '麦克风权限未开启，请在浏览器和系统设置中允许访问。',
      deviceMissing: '麦克风不可用，请检查输入设备。',
      interrupted: '录音中断，请重试。',
      serviceOff: '语音识别服务未启用：请启用语音输入插件包',
      requestFailed: '无法连接语音服务：{message}',
      statusFailed: '无法读取语音服务状态：{message}',
      providerLocal: '本机',
      providerCloud: '云端',
      shortcutTitle: '按住说话快捷键',
      shortcutDesc: '按住该键说话，松开后识别并自动发送；输入框右侧的麦克风也可以按住说话。',
      shortcutChange: '修改',
      shortcutCancel: '取消',
      shortcutReset: '恢复默认',
      shortcutCapturing: '请按下要使用的单个按键（Esc 取消）',
      shortcutInvalid: '请使用功能键或修饰键，例如 F2、右 Ctrl、右 Alt',
      shortcutSaved: '已绑定 {key}',
      shortcutDefault: '默认 {key}',
      keyHint: '按住 {key} 说话，松开自动发送',
      sent: '已发送',
      keepWarmTitle: '麦克风常驻',
      keepWarmDesc: '开启后麦克风保持待命，按住时立即开始录音；期间系统麦克风指示会持续亮着。关闭则只在识别后热连接 2 分钟。',
      on: '已开启',
      off: '已关闭',
      warmHint: '按住后仍要等麦克风打开？开启常驻可以消除这段等待。',
      warmEnable: '开启零等待',
      warmLater: '以后再说',
      globalTitle: '全局快捷键（其它软件中也能用）',
      globalDescOn: '正在后台监听 {key}：即使你正在使用其它软件，按住它也能录音并发送给当前会话。',
      globalDescOff: '开启后可以离开 DSH、在其它软件里按住 {key} 说话，松开后自动发送给当前会话。',
      globalError: '全局快捷键未就绪：{message}',
      globalStarting: '正在启动全局快捷键…',
      globalTrouble: '需要在 Windows 上运行一个本机辅助进程（不联网，只监听一个按键）。',
      globalUnsupported: '当前系统暂不支持全局快捷键（仅 Windows）。',
      overlayTitle: '回复悬浮窗',
      overlayDescOn: '说完话、松开按键后，回复会以透明浮窗显示在屏幕上（即使你在其它软件里）。',
      overlayDescOff: '开启后，用全局快捷键提问时，回复会以透明、置顶、不挡鼠标的浮窗显示在屏幕上。',
      overlayWarn: '注意：如果正在共享整个屏幕，浮窗也会被对方看到。',
      keyControlLeft: '左 Ctrl',
      keyControlRight: '右 Ctrl',
      keyAltLeft: '左 Alt',
      keyAltRight: '右 Alt',
      keyShiftLeft: '左 Shift',
      keyShiftRight: '右 Shift',
      keyMetaLeft: '左 Win',
      keyMetaRight: '右 Win',
    }
    const en = {
      hold: 'Hold to talk',
      holdHint: 'Hold the microphone to record; release to write the transcript into the draft',
      recording: 'Listening',
      release: 'Release to send',
      releaseCancel: 'Release to cancel',
      slideCancel: 'Slide up to cancel',
      requesting: 'Waiting for microphone permission…',
      opening: 'Opening the microphone…',
      transcribing: 'Transcribing…',
      prepare: 'Download and prepare',
      preparing: 'Preparing speech recognition…',
      'prep.checking': 'Checking local resources…',
      'prep.downloading': 'Downloading model {percent}%',
      'prep.loading': 'Loading the model…',
      'prep.waking': 'Waking speech recognition…',
      'prep.cancelling': 'Cancelling preparation…',
      'prep.unprepared': 'Local speech recognition needs a first-run download',
      'prep.setup': 'Speech recognition needs setup first, about {gb} GB of disk space.',
      setupTitle: 'Speech recognition is not ready',
      conflict: 'The draft changed while transcribing; the transcript is kept.',
      insert: 'Insert and send',
      discard: 'Discard',
      dismiss: 'Dismiss',
      empty: 'No speech was recognized. Please try again.',
      tooShort: 'Too short — dictation cancelled.',
      authorized: 'Microphone access is granted. Hold again to talk.',
      warming: 'Preparing the microphone…',
      cancelled: 'Voice input cancelled.',
      tooLarge: 'The recording was too long and was cancelled.',
      failed: 'Speech recognition failed: {message}',
      unavailable: 'This browser cannot record audio.',
      permission: 'Microphone access is blocked. Allow it in the browser and system settings.',
      deviceMissing: 'No microphone is available. Check the input device.',
      interrupted: 'Recording was interrupted. Please try again.',
      serviceOff: 'Speech recognition is not enabled: enable the voice input bundle',
      requestFailed: 'Cannot reach the speech service: {message}',
      statusFailed: 'Cannot read the speech service status: {message}',
      providerLocal: 'local',
      providerCloud: 'cloud',
      shortcutTitle: 'Hold-to-talk shortcut',
      shortcutDesc: 'Hold this key to dictate and release to send. The microphone beside the composer works the same way.',
      shortcutChange: 'Change',
      shortcutCancel: 'Cancel',
      shortcutReset: 'Reset',
      shortcutCapturing: 'Press the single key to use (Esc cancels)',
      shortcutInvalid: 'Use a function or modifier key, for example F2, Right Ctrl or Right Alt',
      shortcutSaved: 'Bound {key}',
      shortcutDefault: 'Default {key}',
      keyHint: 'Hold {key} to talk; release to send',
      sent: 'Sent',
      keepWarmTitle: 'Keep the microphone warm',
      keepWarmDesc: 'Keeps the microphone standing by so a press starts instantly; the system microphone indicator stays on meanwhile. When off, it stays warm for 2 minutes after each dictation only.',
      on: 'On',
      off: 'Off',
      warmHint: 'Still waiting for the microphone after pressing? The standing microphone removes that wait.',
      warmEnable: 'Remove the wait',
      warmLater: 'Not now',
      globalTitle: 'Global shortcut (works in other apps)',
      globalDescOn: 'Listening for {key} in the background: hold it while using another application and the transcript is sent to the current session.',
      globalDescOff: 'When on, leave DSH, hold {key} in any application, and release to send the transcript to the current session.',
      globalError: 'Global shortcut is not ready: {message}',
      globalStarting: 'Starting the global shortcut…',
      globalTrouble: 'Runs a local Windows helper process that listens to one key only and never uses the network.',
      globalUnsupported: 'Global shortcuts are Windows-only for now.',
      overlayTitle: 'Reply overlay',
      overlayDescOn: 'After you dictate, replies appear in a transparent overlay on screen, even while you use another application.',
      overlayDescOff: 'When on, a reply to a global-shortcut question appears in a transparent, always-on-top, click-through overlay.',
      overlayWarn: 'Note: while sharing your entire screen, the overlay is visible to others too.',
      keyControlLeft: 'Left Ctrl',
      keyControlRight: 'Right Ctrl',
      keyAltLeft: 'Left Alt',
      keyAltRight: 'Right Alt',
      keyShiftLeft: 'Left Shift',
      keyShiftRight: 'Right Shift',
      keyMetaLeft: 'Left Win',
      keyMetaRight: 'Right Win',
    }
    const dictionaries = { zh, en }
    //#endregion

    //#region audio (adapted from @deepseek-ai/dsh-experimental-client-ui-voice-input, MIT)
    var RecordingError = class extends Error {
      constructor(kind) {
        super(kind)
        this.kind = kind
        this.name = 'RecordingError'
      }
    }

    function encodeWave(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2)
      const view = new DataView(bytes.buffer)
      const write = (at, value) => {
        for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i)
      }
      write(0, 'RIFF')
      view.setUint32(4, bytes.length - 8, true)
      write(8, 'WAVE')
      write(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true)
      view.setUint32(28, 32000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      write(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let i = 0; i < samples.length; i++) {
        const value = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      }
      return bytes
    }

    function audioBase64(bytes) {
      let text = ''
      for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
      return btoa(text)
    }

    /**
     * Reopening the microphone costs a visible pause between pressing the key
     * and the "listening" state, so the acquired input (stream, analyser and
     * one long-lived AudioContext) is kept warm for a while after a capture and
     * reused by the next push-to-talk. The OS recording indicator stays on only
     * during this window; hiding the page or leaving the window releases it.
     */
    const WARM_MS = 120000
    let warmInput = null
    let sharedContext = null
    /** Opt-in standing microphone: the indicator stays on, but a press never waits. */
    let keepMicWarm = false

    /** One AudioContext for every capture: creating it is off the press path. */
    function ensureAudioContext() {
      if (sharedContext !== null && sharedContext.state !== 'closed') return sharedContext
      try {
        sharedContext = new AudioContext({ sampleRate: 16000 })
      } catch {
        sharedContext = new AudioContext()
      }
      return sharedContext
    }

    function releaseWarmInput() {
      if (warmInput === null) return
      const session = warmInput
      warmInput = null
      clearTimeout(session.timer)
      try {
        session.source.disconnect()
      } catch {}
      try {
        session.stream.getTracks().forEach((track) => track.stop())
      } catch {}
    }

    function adoptWarmInput() {
      if (warmInput === null) return null
      const session = warmInput
      warmInput = null
      clearTimeout(session.timer)
      return session
    }

    function parkWarmInput(session) {
      releaseWarmInput()
      if (session === null || typeof document === 'undefined' || document.hidden) return false
      if (keepMicWarm) {
        warmInput = { ...session, timer: 0 }
        return true
      }
      const timer = setTimeout(releaseWarmInput, WARM_MS)
      warmInput = { ...session, timer }
      return true
    }

    function applyKeepWarm(value) {
      keepMicWarm = value === true
      if (!keepMicWarm) releaseWarmInput()
    }

    /** One microphone acquisition: permission prompt, MediaRecorder capture, 16 kHz WAV. */
    var Recording = class {
      constructor() {
        this.samples = new Float32Array(256)
        this.chunks = []
        this.lifetime = new AbortController()
        this.watch = null
        this.disposal = null
        this.stream = undefined
        this.recorder = undefined
        this.context = undefined
        this.analyser = undefined
        this.source = undefined
        this.onError = undefined
      }

      watchTracks() {
        this.unwatchTracks()
        const controller = new AbortController()
        this.watch = controller
        for (const track of this.stream.getTracks()) {
          track.addEventListener('ended', () => this.interrupted(this.onError), { signal: controller.signal })
        }
      }

      unwatchTracks() {
        if (this.watch !== null) {
          this.watch.abort()
          this.watch = null
        }
      }

      async acquire(onError) {
        this.onError = onError
        const session = adoptWarmInput()
        if (session !== null) {
          this.stream = session.stream
          this.context = session.context
          this.analyser = session.analyser
          this.source = session.source
          this.samples = session.samples
          this.watchTracks()
          if (this.context.state === 'suspended') {
            try {
              await this.context.resume()
            } catch {}
          }
          if (this.lifetime.signal.aborted) {
            this.park()
            throw new RecordingError('cancelled')
          }
          return
        }
        await this.preview()
      }

      async preview() {
        const devices = navigator.mediaDevices
        if (!devices) throw new RecordingError('unavailable')
        let stream
        try {
          stream = await devices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false,
          })
        } catch (error) {
          if (error instanceof DOMException) {
            if (error.name === 'NotAllowedError') throw new RecordingError('permission')
            if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') throw new RecordingError('deviceMissing')
          }
          throw error
        }
        if (this.lifetime.signal.aborted) {
          stream.getTracks().forEach((track) => track.stop())
          throw new RecordingError('cancelled')
        }
        this.stream = stream
        try {
          // Decoding follows the context sample rate, so a 16 kHz context makes
          // decodeAudioData return the canonical rate directly.
          this.context = ensureAudioContext()
          this.analyser = this.context.createAnalyser()
          this.analyser.fftSize = this.samples.length
          this.source = this.context.createMediaStreamSource(stream)
          this.source.connect(this.analyser)
          this.watchTracks()
        } catch (error) {
          await this.dispose()
          throw error
        }
      }

      async start(onError) {
        if (typeof MediaRecorder === 'undefined') throw new RecordingError('unavailable')
        await this.acquire(onError)
        if (this.lifetime.signal.aborted) throw new RecordingError('cancelled')
        try {
          this.recorder = new MediaRecorder(this.stream)
          this.recorder.ondataavailable = (event) => {
            if (!this.lifetime.signal.aborted && event.data.size > 0) this.chunks.push(event.data)
          }
          this.recorder.onerror = () => this.interrupted(onError)
          this.recorder.start()
        } catch (error) {
          await this.dispose()
          throw error
        }
      }

      interrupted(onError) {
        if (this.lifetime.signal.aborted) return
        this.dispose().catch(() => undefined)
        try {
          onError?.(new RecordingError('interrupted'))
        } catch {}
      }

      amplitude() {
        if (!this.analyser) return 0
        this.analyser.getFloatTimeDomainData(this.samples)
        let sum = 0
        for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i]
        return Math.sqrt(sum / this.samples.length)
      }

      async stop(maxDurationSeconds) {
        const recorder = this.recorder
        const context = this.context
        if (!recorder || !context || recorder.state !== 'recording') {
          await this.dispose()
          throw new RecordingError('empty')
        }
        let samples
        try {
          await new Promise((resolve, reject) => {
            recorder.onstop = () => resolve()
            recorder.onerror = () => reject(new RecordingError('empty'))
            recorder.stop()
          })
          this.lifetime.signal.throwIfAborted()
          const blob = new Blob(this.chunks, { type: recorder.mimeType })
          if (blob.size === 0) throw new RecordingError('empty')
          const decoded = await context.decodeAudioData(await blob.arrayBuffer())
          this.lifetime.signal.throwIfAborted()
          if (Math.abs(decoded.sampleRate - 16000) < 1) {
            samples = decoded.getChannelData(0)
          } else {
            const frames = Math.max(1, Math.floor(Math.min(decoded.duration, maxDurationSeconds) * 16000))
            const offline = new OfflineAudioContext(1, frames, 16000)
            const source = offline.createBufferSource()
            source.buffer = decoded
            source.connect(offline.destination)
            source.start()
            samples = (await offline.startRendering()).getChannelData(0)
          }
        } finally {
          this.park()
        }
        const limit = Math.floor(maxDurationSeconds * 16000)
        return encodeWave(samples.length > limit ? samples.subarray(0, limit) : samples)
      }

      /** Hand the acquired input to the warm pool, or release it when warmer reuse is impossible. */
      park() {
        this.unwatchTracks()
        if (this.recorder?.state === 'recording') {
          try {
            this.recorder.stop()
          } catch {}
        }
        const stream = this.stream
        const context = this.context
        const analyser = this.analyser
        const source = this.source
        this.recorder = undefined
        this.chunks = []
        this.stream = undefined
        this.context = undefined
        this.analyser = undefined
        this.source = undefined
        if (stream && context && analyser && source && parkWarmInput({ stream, context, analyser, source, samples: this.samples })) return
        try {
          source?.disconnect()
        } catch {}
        try {
          stream?.getTracks().forEach((track) => track.stop())
        } catch {}
        // The shared AudioContext stays alive for the next capture.
      }

      dispose() {
        if (!this.disposal) {
          this.disposal = new Promise((resolve, reject) => {
            this.release().then(resolve, reject)
          })
        }
        return this.disposal
      }

      async release() {
        this.lifetime.abort(new RecordingError('cancelled'))
        this.unwatchTracks()
        if (this.recorder?.state === 'recording') this.recorder.stop()
        try {
          this.source?.disconnect()
        } catch {}
        this.source = undefined
        this.stream?.getTracks().forEach((track) => track.stop())
        this.stream = undefined
        this.context = undefined
        this.analyser = undefined
        this.chunks = []
        // The shared AudioContext stays alive for the next capture.
      }
    }
    //#endregion

    const IDLE_LEVELS = Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const BUSY = new Set(['requesting', 'recording', 'transcribing', 'preparing'])

    function createController(ctx) {
      const t = (key, params) => {
        let dict = zh
        try {
          const active = String(ctx.locale.getSnapshot().active ?? '')
          const base = active.split('-')[0]
          dict = dictionaries[active] ?? dictionaries[base] ?? zh
        } catch {}
        let text = dict[key] ?? en[key] ?? key
        if (params !== undefined) {
          for (const [name, value] of Object.entries(params)) text = text.replaceAll('{' + name + '}', String(value))
        }
        return text
      }

      const listeners = new Set()
      let state = {
        phase: 'idle',
        levels: IDLE_LEVELS,
        elapsed: 0,
        dragCancel: false,
        status: null,
        statusError: '',
        message: '',
        pendingText: '',
        keyCode: loadStoredKey(),
        capturingKey: false,
        noticeTone: 'error',        inputMode: 'pointer',
        permission: 'unknown',
        keepWarm: loadKeepWarm(),
        globalHotkey: loadGlobalHotkey(),
        globalReady: false,
        globalError: '',
        globalSeq: 0,
        overlayReplies: loadReplyOverlay(),
      }
      applyKeepWarm(state.keepWarm)
      let recording = null
      let binding = null
      let generation = 0
      let pointerId = null
      let startY = 0
      let recordingStartedAt = 0
      let releasedEarly = false
      let rafId = 0
      let noticeId = 0
      let pollId = 0
      let watchdogId = 0
      let autoStopId = 0
      let activeSession = null
      let globalDetach = null
      let disposed = false
      let slotContext = null
      let inputMode = 'pointer'
      let keyboardCode = null
      let captureKeyResolve = null
      let warming = false
      let globalRecording = false
      let globalPolling = false
      let globalPollController = null
      let lastBindAttempt = 0

      const subscribe = (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
      const getState = () => state
      const emit = (patch) => {
        if (disposed) return
        state = Object.assign({}, state, patch)
        for (const listener of listeners) {
          try {
            listener()
          } catch {}
        }
      }

      const clearNotice = () => {
        if (noticeId !== 0) {
          clearTimeout(noticeId)
          noticeId = 0
        }
      }
      const notice = (message, tone = 'error') => {
        emit({ phase: 'notice', message, noticeTone: tone, levels: IDLE_LEVELS, elapsed: 0, dragCancel: false })
        clearNotice()
        noticeId = setTimeout(() => {
          noticeId = 0
          if (state.phase === 'notice') emit({ phase: 'idle', message: '' })
        }, NOTICE_MS)
      }

      const failureText = (error) => {
        if (error && error.name === 'RecordingError') return t(error.kind)
        return t('failed', { message: error instanceof Error ? error.message : String(error) })
      }

      function keyLabel(code) {
        const names = {
          ControlLeft: 'keyControlLeft',
          ControlRight: 'keyControlRight',
          AltLeft: 'keyAltLeft',
          AltRight: 'keyAltRight',
          ShiftLeft: 'keyShiftLeft',
          ShiftRight: 'keyShiftRight',
          MetaLeft: 'keyMetaLeft',
          MetaRight: 'keyMetaRight',
        }
        const name = names[code]
        return name === undefined ? code : t(name)
      }

      function setSlotContext(context) {
        slotContext = context ?? null
      }

      function setPermission(value) {
        if (value !== 'granted' && value !== 'prompt' && value !== 'denied') return
        if (state.permission === value) return
        emit({ permission: value })
      }

      function setKeepWarm(value) {
        const next = value === true
        applyKeepWarm(next)
        storeKeepWarm(next)
        emit({ keepWarm: next })
        if (next) void warmMic()
      }

      function enableWarmFromHint() {
        storeWarmHintSeen()
        setKeepWarm(true)
        emit({ phase: 'idle' })
      }

      function dismissWarmHint() {
        storeWarmHintSeen()
        emit({ phase: 'idle' })
      }

      function setKeyBinding(code) {
        if (!isBindableKey(code)) return false
        storeKey(code)
        emit({ keyCode: code })
        if (state.globalHotkey) void syncGlobalBinding()
        return true
      }

      /** Tell the Host which single key the global helper should listen for. */
      async function syncGlobalBinding() {
        if (disposed) return
        lastBindAttempt = Date.now()
        try {
          const response = await fetch(API + '/hotkey/bind', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: state.globalHotkey === true, code: state.keyCode }),
          })
          let data = null
          try {
            data = await response.json()
          } catch {}
          if (!response.ok || data === null || data.ok !== true) {
            throw new Error(data?.error?.message ?? 'HTTP ' + response.status)
          }
          emit({ globalReady: data.ready === true, globalError: data.ready === true ? '' : (data.error ?? '') })
        } catch (error) {
          emit({ globalReady: false, globalError: error instanceof Error ? error.message : String(error) })
        }
      }

      function setGlobalHotkey(value) {
        const next = value === true
        storeGlobalHotkey(next)
        emit({ globalHotkey: next, globalError: next ? state.globalError : '' })
        if (next) {
          void syncGlobalBinding()
          startGlobalPolling()
        } else {
          stopGlobalPolling()
          void syncGlobalBinding()
        }
      }

      function setOverlayReplies(value) {
        const next = value === true
        storeReplyOverlay(next)
        emit({ overlayReplies: next })
      }

      /** Ask the Host to mirror this session's next reply on the OS overlay. */
      async function armOverlay(sessionId) {
        if (disposed || !state.overlayReplies) return
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        try {
          await fetch(API + '/overlay/arm', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
        } catch {}
      }

      function hideOverlay() {
        if (!state.overlayReplies) return
        try {
          void fetch(API + '/overlay/hide', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        } catch {}
      }

      function onGlobalDown() {
        if (disposed || BUSY.has(state.phase)) return
        if (slotContext === null) return
        void begin({
          sessionId: slotContext.sessionId,
          inputActions: slotContext.inputActions,
          inputMode: 'keyboard',
          keyCode: state.keyCode,
          global: true,
        })
      }

      function onGlobalUp() {
        end()
      }

      async function pollGlobalLoop() {
        if (globalPolling) return
        globalPolling = true
        while (globalPolling && !disposed) {
          const controller = new AbortController()
          globalPollController = controller
          const timeout = setTimeout(() => controller.abort(), 25_000)
          try {
            const response = await fetch(API + '/hotkey/poll?since=' + String(state.globalSeq), {
              credentials: 'same-origin',
              cache: 'no-store',
              signal: controller.signal,
            })
            const data = await response.json()
            if (data !== null && data.ok === true) {
              const helper = data.state ?? {}
              const events = Array.isArray(data.events) ? data.events : []
              const seq = typeof data.seq === 'number' ? data.seq : state.globalSeq
              emit({
                globalReady: helper.ready === true,
                globalError: helper.ready === true ? '' : (helper.error ?? state.globalError),
                globalSeq: seq,
              })
              for (const event of events) {
                if (event.type === 'down') onGlobalDown()
                else if (event.type === 'up') onGlobalUp()
              }
            }
          } catch {}
          clearTimeout(timeout)
          if (!globalPolling) break
          // Retry a failed helper once in a while instead of giving up silently.
          if (
            state.globalHotkey &&
            !state.globalReady &&
            state.globalError !== '' &&
            Date.now() - lastBindAttempt > 30_000
          ) {
            void syncGlobalBinding()
          }
          // Avoid a hot loop when the Host answers instantly (for example a
          // helper that is not running yet).
          await new Promise((resolve) => setTimeout(resolve, 120))
        }
        globalPolling = false
      }

      function startGlobalPolling() {
        if (disposed || globalPolling) return
        void pollGlobalLoop()
      }

      function stopGlobalPolling() {
        globalPolling = false
        try {
          globalPollController?.abort()
        } catch {}
        globalPollController = null
      }

      /**
       * Open the microphone before the user presses, so the device is ready when
       * push-to-talk starts. Only runs after permission was already granted, so
       * it can never show a prompt by itself.
       */
      async function warmMic() {
        if (disposed || warming || BUSY.has(state.phase) || warmInput !== null) return
        if (state.permission !== 'granted') return
        warming = true
        const capture = new Recording()
        try {
          await capture.acquire(() => {})
          warming = false
          if (disposed || BUSY.has(state.phase)) {
            await capture.dispose()
            return
          }
          capture.park()
        } catch {
          warming = false
          try {
            await capture.dispose()
          } catch {}
        }
      }

      function startKeyCapture() {
        if (disposed) return
        emit({ capturingKey: true })
      }

      function cancelKeyCapture() {
        if (!state.capturingKey) return
        emit({ capturingKey: false })
      }

      function handleKeyDown(event) {
        if (disposed) return
        if (state.capturingKey) {
          if (event.key === 'Escape') {
            event.preventDefault()
            emit({ capturingKey: false })
            return
          }
          if (event.isComposing || event.repeat) return
          if (!isBindableKey(event.code)) {
            if (event.key.length === 1 || event.key === 'Enter' || event.key === 'Tab' || event.key === ' ') {
              event.preventDefault()
              notice(t('shortcutInvalid'))
            }
            return
          }
          event.preventDefault()
          event.stopPropagation()
          setKeyBinding(event.code)
          emit({ capturingKey: false })
          notice(t('shortcutSaved', { key: keyLabel(event.code) }), 'success')
          return
        }
        if (event.code !== state.keyCode) return
        if (event.repeat || event.isComposing) return
        // With a running global helper the Host delivers the press; never start
        // twice from the page's own key event.
        if (state.globalHotkey && state.globalReady) {
          event.preventDefault()
          return
        }
        if (slotContext === null || BUSY.has(state.phase)) return
        event.preventDefault()
        void begin({
          sessionId: slotContext.sessionId,
          inputActions: slotContext.inputActions,
          inputMode: 'keyboard',
          keyCode: event.code,
        })
      }

      function selectedProvider(status) {
        const providers = Array.isArray(status?.providers) ? status.providers : []
        const wanted = status?.selection?.providerId
        return providers.find((provider) => provider.id === wanted) ?? providers[0]
      }

      function providerUsable(provider) {
        const phase = provider?.preparation?.phase
        return phase === 'ready' || phase === 'standby' || phase === 'waking'
      }

      async function refreshStatus() {
        try {
          const response = await fetch(API + '/status', { credentials: 'same-origin', cache: 'no-store' })
          let data = null
          try {
            data = await response.json()
          } catch {}
          if (!response.ok || data === null || data.ok !== true) {
            throw new Error(data?.error?.message ?? 'HTTP ' + response.status)
          }
          emit({ status: data, statusError: '' })
          return data
        } catch (error) {
          emit({ statusError: error instanceof Error ? error.message : String(error) })
          return null
        }
      }

      function stopAnimation() {
        if (rafId !== 0) {
          cancelAnimationFrame(rafId)
          rafId = 0
        }
      }

      function detachGlobals() {
        if (globalDetach) {
          globalDetach()
          globalDetach = null
        }
      }

      function resetBinding() {
        binding = null
        pointerId = null
        releasedEarly = false
        keyboardCode = null
        globalRecording = false
        if (autoStopId !== 0) {
          clearTimeout(autoStopId)
          autoStopId = 0
        }
        stopAnimation()
        detachGlobals()
      }

      async function disposeCapture() {
        const capture = recording
        recording = null
        if (capture) {
          try {
            await capture.dispose()
          } catch {}
        }
      }

      async function cancel(message) {
        generation += 1
        stopAnimation()
        detachGlobals()
        resetBinding()
        if (watchdogId !== 0) {
          clearTimeout(watchdogId)
          watchdogId = 0
        }
        emit({ phase: 'idle', levels: IDLE_LEVELS, elapsed: 0, dragCancel: false, message: '', pendingText: '' })
        await disposeCapture()
        if (message) notice(message)
      }

      function attachGlobals(run) {
        detachGlobals()
        const isPointer = inputMode === 'pointer'
        const boundCode = keyboardCode
        const onPointerUp = (event) => {
          if (!isPointer || run !== generation) return
          if (pointerId !== null && event.pointerId !== pointerId) return
          end()
        }
        const onPointerCancel = (event) => {
          if (!isPointer || run !== generation) return
          if (pointerId !== null && event.pointerId !== pointerId) return
          cancel(t('cancelled'))
        }
        const onKeyUp = (event) => {
          if (isPointer || run !== generation) return
          if (boundCode !== null && event.code !== boundCode) return
          event.preventDefault()
          end()
        }
        const onOtherKey = (event) => {
          if (isPointer || run !== generation) return
          if (boundCode !== null && event.code === boundCode) return
          if (MODIFIER_CODES.has(event.code) || event.code === 'CapsLock') return
          cancel(t('cancelled'))
        }
        const onEscape = (event) => {
          if (event.key !== 'Escape') return
          if (!BUSY.has(state.phase)) return
          event.preventDefault()
          cancel(t('cancelled'))
        }
        const onBlur = () => {
          if (run !== generation) return
          // A global recording is held while another application has focus, so
          // the page's own blur is expected and must not stop it.
          if (globalRecording) return
          if (state.phase === 'recording') finish()
        }
        const onVisibility = () => {
          if (run !== generation) return
          if (globalRecording) return
          if (document.hidden && (state.phase === 'recording' || state.phase === 'requesting')) cancel('')
        }
        if (isPointer) {
          window.addEventListener('pointerup', onPointerUp)
          window.addEventListener('pointercancel', onPointerCancel)
        } else if (!globalRecording) {
          window.addEventListener('keyup', onKeyUp, true)
          window.addEventListener('keydown', onOtherKey, true)
        }
        document.addEventListener('keydown', onEscape, true)
        window.addEventListener('blur', onBlur)
        document.addEventListener('visibilitychange', onVisibility)
        globalDetach = () => {
          if (isPointer) {
            window.removeEventListener('pointerup', onPointerUp)
            window.removeEventListener('pointercancel', onPointerCancel)
          } else if (!globalRecording) {
            window.removeEventListener('keyup', onKeyUp, true)
            window.removeEventListener('keydown', onOtherKey, true)
          }
          document.removeEventListener('keydown', onEscape, true)
          window.removeEventListener('blur', onBlur)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }

      function animate(run) {
        const levels = []
        let lastEmit = 0
        const tick = () => {
          if (run !== generation) return
          const capture = recording
          if (!capture) return
          const now = performance.now()
          const elapsed = (now - recordingStartedAt) / 1000
          levels.push(Math.min(1, capture.amplitude() * 7))
          if (levels.length > 12) levels.shift()
          if (now - lastEmit >= 80) {
            lastEmit = now
            emit({ levels: levels.slice(), elapsed: Math.floor(elapsed) })
          }
          if (elapsed >= MAX_DURATION_SECONDS) {
            finish()
            return
          }
          rafId = requestAnimationFrame(tick)
        }
        rafId = requestAnimationFrame(tick)
      }

      async function begin(options) {
        if (disposed || BUSY.has(state.phase)) return
        const provider = selectedProvider(state.status)
        if (state.status !== null && provider && provider.preparation?.phase === 'unprepared') {
          emit({ phase: 'setup' })
          return
        }
        const run = ++generation
        const pressedAt = performance.now()
        inputMode = options.inputMode === 'keyboard' ? 'keyboard' : 'pointer'
        globalRecording = options.global === true && inputMode === 'keyboard'
        keyboardCode = inputMode === 'keyboard' ? (options.keyCode ?? state.keyCode) : null
        pointerId = options.pointerId ?? null
        startY = options.clientY ?? 0
        releasedEarly = false
        clearNotice()
        let span
        try {
          span = options.inputActions?.captureInsertion?.()
        } catch {
          span = undefined
        }
        binding = { sessionId: options.sessionId, inputActions: options.inputActions, span }
        const capture = new Recording()
        recording = capture
        emit({ phase: 'requesting', inputMode, message: '', pendingText: '', dragCancel: false, elapsed: 0, levels: IDLE_LEVELS })
        if (provider?.preparation?.phase === 'standby') void prefetchProvider(provider.id)
        attachGlobals(run)
        watchdogId = setTimeout(() => {
          watchdogId = 0
          if (run !== generation || state.phase !== 'requesting') return
          void cancel('')
          notice(t('permission'))
        }, 30_000)
        void refreshStatus()
        try {
          await capture.start((failure) => {
            if (run !== generation) return
            void cancel('')
            notice(failureText(failure))
          })
          if (run !== generation) return
          if (releasedEarly) {
            const waited = performance.now() - pressedAt
            await cancel('')
            // A long "requesting" means the browser permission prompt was open:
            // the press itself could not record, so ask for one more hold.
            notice(waited >= 1200 ? t('authorized') : t('tooShort'))
            return
          }
          recordingStartedAt = performance.now()
          if (watchdogId !== 0) {
            clearTimeout(watchdogId)
            watchdogId = 0
          }
          emit({ phase: 'recording', permission: 'granted' })
          // Timeout-based cap: requestAnimationFrame pauses when the window is in
          // the background, but a global recording may run exactly there.
          autoStopId = setTimeout(() => {
            autoStopId = 0
            if (run === generation) finish()
          }, MAX_DURATION_SECONDS * 1000)
          animate(run)
        } catch (failure) {
          if (run !== generation) return
          await cancel('')
          notice(failureText(failure))
        }
      }

      function move(event) {
        if (state.phase !== 'recording') return
        if (pointerId !== null && event.pointerId !== pointerId) return
        const dragging = startY - (event.clientY ?? startY) > CANCEL_DRAG_PX
        if (dragging !== state.dragCancel) emit({ dragCancel: dragging })
      }

      function end() {
        if (state.phase === 'requesting') {
          releasedEarly = true
          return
        }
        if (state.phase !== 'recording') return
        if (state.dragCancel) {
          void cancel(t('cancelled'))
          return
        }
        const held = performance.now() - recordingStartedAt
        if (held < MIN_HOLD_MS) {
          void cancel('')
          notice(t('tooShort'))
          return
        }
        finish()
      }

      /** Start a standby model loading while the user is already speaking. */
      async function prefetchProvider(providerId) {
        try {
          await fetch(API + '/prepare', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ providerId }),
          })
        } catch {}
      }

      async function postTranscribe(audio) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS)
        try {
          const response = await fetch(API + '/transcribe', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ audioBase64: audioBase64(audio) }),
            signal: controller.signal,
          })
          let data = null
          try {
            data = await response.json()
          } catch {}
          if (!response.ok || data === null || data.ok !== true) {
            throw new Error(data?.error?.message ?? 'HTTP ' + response.status)
          }
          return data
        } finally {
          clearTimeout(timeout)
        }
      }

      function insert(text) {
        const actions = binding?.inputActions
        let inserted = false
        if (actions) {
          try {
            inserted = actions.insertText(text, binding.span) === true
          } catch {
            inserted = false
          }
          if (!inserted) {
            try {
              inserted = actions.insertText(text, actions.captureInsertion()) === true
            } catch {
              inserted = false
            }
          }
        }
        if (inserted) {
          // Where the press came from decides whether the reply is worth an
          // on-screen overlay: a global press or a window that is not focused
          // means the user is looking at another application.
          const sessionId = binding?.sessionId
          const away = globalRecording || (typeof document.hasFocus === 'function' && !document.hasFocus())
          // Release means send: hand the transcript to the composer and submit it.
          try {
            actions.submit?.()
          } catch {}
          resetBinding()
          emit({ phase: 'idle', message: '', pendingText: '', levels: IDLE_LEVELS, elapsed: 0 })
          if (away) void armOverlay(sessionId)
          // Offer the standing microphone once, after a real dictation worked.
          if (!state.keepWarm && !loadWarmHintSeen()) emit({ phase: 'hint' })
          return
        }
        emit({ phase: 'conflict', pendingText: text })
      }

      function applyPending() {
        if (state.pendingText === '') return
        insert(state.pendingText)
      }

      function discardPending() {
        resetBinding()
        emit({ phase: 'idle', pendingText: '', message: '' })
      }

      async function finish() {
        if (state.phase !== 'recording' && state.phase !== 'requesting') return
        const run = generation
        const capture = recording
        if (!capture) return
        stopAnimation()
        detachGlobals()
        emit({ phase: 'transcribing', dragCancel: false })
        let audio
        try {
          audio = await capture.stop(MAX_DURATION_SECONDS)
        } catch (failure) {
          if (run !== generation) return
          recording = null
          await cancel('')
          notice(failureText(failure))
          return
        }
        recording = null
        if (run !== generation) return
        if (audio.byteLength > MAX_AUDIO_BYTES) {
          resetBinding()
          emit({ phase: 'idle' })
          notice(t('tooLarge'))
          return
        }
        let result
        try {
          result = await postTranscribe(audio)
        } catch (failure) {
          if (run !== generation) return
          resetBinding()
          emit({ phase: 'idle' })
          notice(t('failed', { message: errorText(failure) }))
          return
        }
        if (run !== generation) return
        const text = String(result.text ?? '').trim()
        if (text === '') {
          resetBinding()
          emit({ phase: 'idle' })
          notice(t('empty'))
          return
        }
        insert(text)
      }

      const errorText = (error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return 'timeout'
        return error instanceof Error ? error.message : String(error)
      }

      function pollPreparation(providerId) {
        if (pollId !== 0) clearInterval(pollId)
        pollId = setInterval(async () => {
          const status = await refreshStatus()
          if (status === null) return
          const provider = selectedProvider(status)
          const phase = provider?.preparation?.phase
          if (provider && providerUsable(provider)) {
            clearInterval(pollId)
            pollId = 0
            emit({ phase: 'idle' })
            return
          }
          if (phase === 'failed' || phase === 'cancelled' || phase === 'unprepared' || phase === undefined) {
            clearInterval(pollId)
            pollId = 0
            if (phase === 'failed') emit({ phase: 'notice', message: t('setupTitle') })
            else emit({ phase: 'setup' })
          }
        }, POLL_MS)
      }

      async function prepare() {
        const provider = selectedProvider(state.status)
        emit({ phase: 'preparing' })
        try {
          const response = await fetch(API + '/prepare', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(provider ? { providerId: provider.id } : {}),
          })
          let data = null
          try {
            data = await response.json()
          } catch {}
          if (!response.ok || data === null || data.ok !== true) {
            throw new Error(data?.error?.message ?? 'HTTP ' + response.status)
          }
        } catch (error) {
          emit({ phase: 'setup' })
          notice(t('requestFailed', { message: error instanceof Error ? error.message : String(error) }))
          return
        }
        pollPreparation(provider?.id ?? '')
        await refreshStatus()
      }

      function openSetup() {
        emit({ phase: 'setup' })
      }

      function dismiss() {
        clearNotice()
        if (state.phase === 'conflict') return
        emit({ phase: 'idle', message: '', levels: IDLE_LEVELS, elapsed: 0 })
      }

      function setActiveSession(sessionId) {
        if (activeSession === sessionId) return
        activeSession = sessionId
        if (BUSY.has(state.phase) || state.phase === 'conflict') {
          generation += 1
          stopAnimation()
          detachGlobals()
          resetBinding()
          void disposeCapture()
          emit({ phase: 'idle', pendingText: '', message: '', levels: IDLE_LEVELS, elapsed: 0 })
        }
      }

      const controller = {
        subscribe,
        getState,
        begin,
        move,
        end,
        prepare,
        openSetup,
        applyPending,
        discardPending,
        dismiss,
        refreshStatus,
        setActiveSession,
        setSlotContext,
        setKeyBinding,
        setPermission,
        setKeepWarm,
        setGlobalHotkey,
        setOverlayReplies,
        armOverlay,
        hideOverlay,
        syncGlobalBinding,
        startGlobalPolling,
        stopGlobalPolling,
        enableWarmFromHint,
        dismissWarmHint,
        warmMic,
        startKeyCapture,
        cancelKeyCapture,
        handleKeyDown,
        keyLabel,
        t,
        dispose() {
          disposed = true
          generation += 1
          stopAnimation()
          detachGlobals()
          clearNotice()
          stopGlobalPolling()
          storeGlobalHotkey(state.globalHotkey)
          // Stop the helper even if the Host row outlives this page.
          void fetch(API + '/hotkey/bind', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: false, code: state.keyCode }),
          }).catch(() => {})
          if (watchdogId !== 0) {
            clearTimeout(watchdogId)
            watchdogId = 0
          }
          if (autoStopId !== 0) {
            clearTimeout(autoStopId)
            autoStopId = 0
          }
          if (pollId !== 0) clearInterval(pollId)
          pollId = 0
          void disposeCapture()
        },
      }
      return controller
    }

    //#region styles
    const STYLES = `
.dpt-mic{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .15s ease,color .15s ease;touch-action:none;user-select:none;-webkit-user-select:none;position:relative}
.dpt-mic:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dpt-mic:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dpt-mic[data-active="true"]{color:var(--dsw-alias-state-error-primary)}
.dpt-mic[data-busy="true"]{color:var(--dsw-alias-brand-primary);cursor:progress}
.dpt-mic[data-unavailable="true"]{opacity:.45}
.dpt-mic svg{display:block;pointer-events:none}
.dpt-dock{display:flex;align-items:center;gap:10px;margin-top:6px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;max-width:100%;box-sizing:border-box}
.dpt-dock[data-tone="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dpt-dock[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary)}
.dpt-dock[data-tone="success"]{border-color:var(--dsw-alias-state-success-primary)}
.dpt-dock[data-tone="brand"]{border-color:var(--dsw-alias-brand-primary)}
.dpt-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpt-hint{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dpt-meter{display:inline-flex;align-items:flex-end;gap:2px;height:18px;flex:0 0 auto}
.dpt-meter span{display:block;width:3px;border-radius:2px;background:var(--dsw-alias-state-error-primary);transition:height .08s linear}
.dpt-spinner{width:12px;height:12px;flex:0 0 auto;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dpt-spin .8s linear infinite}
@keyframes dpt-spin{to{transform:rotate(360deg)}}
.dpt-button{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:2px 10px;cursor:pointer}
.dpt-button:hover{background:var(--dsw-alias-bg-layer-2)}
.dpt-button[data-primary="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dpt-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dpt-icon-button{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1}
.dpt-icon-button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dpt-prep{color:var(--dsw-alias-label-secondary)}
.dpt-setting{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;font-size:13px;color:var(--dsw-alias-label-primary)}
.dpt-setting-text{display:flex;flex-direction:column;gap:3px;min-width:0}
.dpt-setting-title{font-weight:500;font-size:13px}
.dpt-setting-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45}
.dpt-setting-warn{color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:1.4}
.dpt-setting-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.dpt-kbd{display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
`
    //#endregion

    function MicIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': true, focusable: 'false' },
        h('path', { d: 'M12 3.6a2.6 2.6 0 0 1 2.6 2.6v5.6a2.6 2.6 0 0 1-5.2 0V6.2A2.6 2.6 0 0 1 12 3.6Z', fill: 'currentColor' }),
        h('path', { d: 'M6.4 11.2a5.6 5.6 0 0 0 11.2 0', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
        h('path', { d: 'M12 16.8V20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
      )
    }

    function levelBars(levels, tone) {
      return h(
        'span',
        { className: 'dpt-meter', 'aria-hidden': true },
        levels.map((value, index) =>
          h('span', {
            key: index,
            style: {
              height: Math.max(3, Math.round(3 + value * 15)) + 'px',
              background: tone === 'cancel' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-error-primary)',
            },
          }),
        ),
      )
    }

    function apply(ctx) {
      try {
        ctx.effect(() => {
          const offZh = ctx.locale.register(NS, 'zh', zh)
          const offEn = ctx.locale.register(NS, 'en', en)
          return () => {
            try {
              offZh()
            } catch {}
            try {
              offEn()
            } catch {}
          }
        }, 'push-to-talk: dictionaries')
      } catch {}

      const controller = createController(ctx)
      ctx.effect(() => () => controller.dispose(), 'push-to-talk: controller')

      // Global hold key: capture phase so the bound single key never reaches the
      // composer or the page while it is used as push-to-talk.
      ctx.effect(() => {
        const onKeyDown = (event) => controller.handleKeyDown(event)
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, 'push-to-talk: hold key listener')

      // Release the warm microphone when the page hides, the window loses focus
      // (only when neither the standing microphone nor the global shortcut needs
      // it), or the plugin unloads.
      ctx.effect(() => {
        const onVisibility = () => {
          if (document.hidden) releaseWarmInput()
        }
        const onBlur = () => {
          if (!keepMicWarm && !controller.getState().globalHotkey) releaseWarmInput()
        }
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('blur', onBlur)
        return () => {
          document.removeEventListener('visibilitychange', onVisibility)
          window.removeEventListener('blur', onBlur)
          releaseWarmInput()
        }
      }, 'push-to-talk: warm microphone lifetime')

      // Standing microphone: reacquire when the window regains focus, and warm
      // once permission is already granted.
      ctx.effect(() => {
        const onFocus = () => {
          if (keepMicWarm) void controller.warmMic()
        }
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, 'push-to-talk: standing microphone refocus')

      // Global shortcut lifecycle: bind the Host helper and start polling when
      // the page loads with the preference already enabled.
      ctx.effect(() => {
        if (controller.getState().globalHotkey) {
          void controller.syncGlobalBinding()
          controller.startGlobalPolling()
        }
        const onFocus = () => {
          if (controller.getState().globalHotkey && !controller.getState().globalReady) void controller.syncGlobalBinding()
          // Back in DSH: the reply can be read here, so drop the on-screen copy.
          controller.hideOverlay()
        }
        window.addEventListener('focus', onFocus)
        return () => {
          window.removeEventListener('focus', onFocus)
          controller.stopGlobalPolling()
        }
      }, 'push-to-talk: global shortcut lifecycle')

      // Track the microphone permission so the dock can say "opening" instead of
      // asking for permission, and so hover prewarming never opens a prompt.
      ctx.effect(() => {
        let dropped = false
        let unsubscribe = null
        try {
          const query = navigator.permissions?.query?.({ name: 'microphone' })
          if (query !== undefined && typeof query.then === 'function') {
            query
              .then((status) => {
                if (dropped) return
                controller.setPermission(status.state)
                if (status.state === 'granted' && controller.getState().keepWarm) void controller.warmMic()
                try {
                  const onChange = () => controller.setPermission(status.state)
                  status.addEventListener?.('change', onChange)
                  unsubscribe = () => status.removeEventListener?.('change', onChange)
                } catch {}
              })
              .catch(() => {})
          }
        } catch {}
        return () => {
          dropped = true
          try {
            unsubscribe?.()
          } catch {}
        }
      }, 'push-to-talk: microphone permission state')

      const useLocale = () => {
        const subscribe = React.useCallback((listener) => ctx.locale.subscribe(listener), [])
        const getSnapshot = React.useCallback(() => {
          try {
            return String(ctx.locale.getSnapshot().active ?? '')
          } catch {
            return ''
          }
        }, [])
        return React.useSyncExternalStore(subscribe, getSnapshot)
      }

      function MicButton(props) {
        useLocale()
        const state = React.useSyncExternalStore(controller.subscribe, controller.getState)
        const sessionId = props?.sessionId
        React.useEffect(() => {
          if (sessionId !== undefined) controller.setActiveSession(sessionId)
        }, [sessionId])
        React.useEffect(() => {
          controller.setSlotContext({ sessionId, inputActions: props?.inputActions })
          return () => controller.setSlotContext(null)
        }, [sessionId, props?.inputActions])
        React.useEffect(() => {
          void controller.refreshStatus()
        }, [])
        const busy = state.phase === 'requesting' || state.phase === 'transcribing' || state.phase === 'preparing'
        const recordingNow = state.phase === 'recording' || state.phase === 'requesting'
        const unavailable = state.status !== null && Array.isArray(state.status.providers) && state.status.providers.length > 0 && !providerUsableIn(state)
        const t = controller.t
        const label = recordingNow
          ? state.dragCancel
            ? t('releaseCancel')
            : t('release')
          : t('hold')
        const keyHint = t('keyHint', { key: controller.keyLabel(state.keyCode) })
        const onPointerDown = (event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return
          event.preventDefault()
          try {
            event.currentTarget.setPointerCapture?.(event.pointerId)
          } catch {}
          void controller.begin({
            sessionId,
            inputActions: props?.inputActions,
            pointerId: event.pointerId,
            clientY: event.clientY,
          })
        }
        const onPointerMove = (event) => controller.move(event)
        const onPointerUp = (event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return
          controller.end()
        }
        const onPointerCancel = () => controller.end()
        return h(
          React.Fragment,
          null,
          h('style', null, STYLES),
          h(
            'button',
            {
              type: 'button',
              className: 'dpt-mic',
              'aria-label': label,
              title: recordingNow ? label : keyHint,
              'data-active': recordingNow ? 'true' : 'false',
              'data-busy': busy ? 'true' : 'false',
              'data-unavailable': unavailable ? 'true' : 'false',
              onPointerDown,
              onPointerMove,
              onPointerUp,
              onPointerCancel,
              onPointerEnter: () => {
                void controller.warmMic()
              },
              onFocus: () => {
                void controller.warmMic()
              },
              onContextMenu: (event) => event.preventDefault(),
              onDragStart: (event) => event.preventDefault(),
            },
            h(MicIcon),
          ),
        )
      }

      function providerUsableIn(state) {
        const status = state.status
        if (status === null) return true
        const providers = Array.isArray(status.providers) ? status.providers : []
        const wanted = status.selection?.providerId
        const provider = providers.find((item) => item.id === wanted) ?? providers[0]
        if (!provider) return false
        const phase = provider.preparation?.phase
        return phase === 'ready' || phase === 'standby' || phase === 'waking'
      }

      function StatusBar(props) {
        useLocale()
        const state = React.useSyncExternalStore(controller.subscribe, controller.getState)
        const sessionId = props?.sessionId
        React.useEffect(() => {
          if (sessionId !== undefined) controller.setActiveSession(sessionId)
        }, [sessionId])
        const t = controller.t
        const status = state.status
        const providers = Array.isArray(status?.providers) ? status.providers : []
        const wanted = status?.selection?.providerId
        const provider = providers.find((item) => item.id === wanted) ?? providers[0]
        const preparation = provider?.preparation ?? undefined
        const phase = preparation?.phase

        if (state.phase === 'requesting') {
          return dock(
            'brand',
            h('span', { className: 'dpt-spinner' }),
            h('span', { className: 'dpt-label' }, t(state.permission === 'granted' ? 'opening' : 'requesting')),
          )
        }
        if (state.phase === 'recording') {
          return dock(
            'brand',
            levelBars(state.levels, state.dragCancel ? 'cancel' : 'record'),
            h('span', { className: 'dpt-label' }, t('recording') + ' · ' + formatElapsed(state.elapsed)),
            h(
              'span',
              { className: 'dpt-hint' },
              state.dragCancel
                ? t('releaseCancel')
                : state.inputMode === 'keyboard'
                  ? t('release')
                  : t('release') + ' · ' + t('slideCancel'),
            ),
          )
        }
        if (state.phase === 'transcribing') {
          return dock('brand', h('span', { className: 'dpt-spinner' }), h('span', { className: 'dpt-label' }, t('transcribing')))
        }
        if (state.phase === 'preparing') {
          let text = t('preparing')
          if (phase === 'downloading') text = t('prep.downloading', { percent: downloadPercent(preparation) })
          else if (phase === 'checking' || phase === 'loading' || phase === 'waking' || phase === 'cancelling') text = t('prep.' + phase)
          return dock('brand', h('span', { className: 'dpt-spinner' }), h('span', { className: 'dpt-label' }, text))
        }
        if (state.phase === 'conflict') {
          return dock(
            'warn',
            h('span', { className: 'dpt-label' }, state.pendingText || t('conflict')),
            h('button', { type: 'button', className: 'dpt-button', 'data-primary': 'true', onClick: () => controller.applyPending() }, t('insert')),
            h('button', { type: 'button', className: 'dpt-button', onClick: () => controller.discardPending() }, t('discard')),
          )
        }
        if (state.phase === 'notice') {
          return dock(
            state.noticeTone === 'success' ? 'success' : 'error',
            h('span', { className: 'dpt-label' }, state.message),
            h('button', { type: 'button', className: 'dpt-icon-button', 'aria-label': t('dismiss'), title: t('dismiss'), onClick: () => controller.dismiss() }, '×'),
          )
        }
        if (state.phase === 'hint') {
          return dock(
            'brand',
            h('span', { className: 'dpt-label' }, t('warmHint')),
            h(
              'button',
              { type: 'button', className: 'dpt-button', 'data-primary': 'true', onClick: () => controller.enableWarmFromHint() },
              t('warmEnable'),
            ),
            h('button', { type: 'button', className: 'dpt-button', onClick: () => controller.dismissWarmHint() }, t('warmLater')),
          )
        }
        if (state.phase === 'setup') {
          const gb = provider?.setupEstimate?.recommendedDiskBytes
            ? Math.max(0.1, Math.round((provider.setupEstimate.recommendedDiskBytes / 1e9) * 10) / 10)
            : null
          return dock(
            'warn',
            h('span', { className: 'dpt-label' }, gb === null ? t('prep.unprepared') : t('prep.setup', { gb })),
            h('button', { type: 'button', className: 'dpt-button', 'data-primary': 'true', onClick: () => void controller.prepare() }, t('prepare')),
            h('button', { type: 'button', className: 'dpt-icon-button', 'aria-label': t('dismiss'), title: t('dismiss'), onClick: () => controller.dismiss() }, '×'),
          )
        }
        if (state.statusError !== '') {
          return dock(
            'error',
            h('span', { className: 'dpt-label' }, t('statusFailed', { message: state.statusError })),
            h('button', { type: 'button', className: 'dpt-icon-button', 'aria-label': t('dismiss'), title: t('dismiss'), onClick: () => controller.dismiss() }, '×'),
          )
        }
        if (status !== null && provider && !providerUsablePhase(phase)) {
          return dock(
            'warn',
            h('span', { className: 'dpt-label' }, t('setupTitle')),
            h('button', { type: 'button', className: 'dpt-button', 'data-primary': 'true', onClick: () => void controller.openSetup() }, t('prepare')),
          )
        }
        return null
      }

      /** Settings → General row: one single key held to dictate. */
      function ShortcutRow() {
        useLocale()
        const state = React.useSyncExternalStore(controller.subscribe, controller.getState)
        const t = controller.t
        const current = controller.keyLabel(state.keyCode)
        return h(
          'div',
          { className: 'dpt-setting' },
          h('style', null, STYLES),
          h(
            'div',
            { className: 'dpt-setting-text' },
            h('strong', { className: 'dpt-setting-title' }, t('shortcutTitle')),
            h(
              'span',
              { className: 'dpt-setting-desc' },
              state.capturingKey ? t('shortcutCapturing') : t('shortcutDesc'),
            ),
          ),
          h(
            'div',
            { className: 'dpt-setting-actions' },
            h('kbd', { className: 'dpt-kbd' }, current),
            h(
              'button',
              {
                type: 'button',
                className: 'dpt-button',
                'data-primary': state.capturingKey ? 'true' : 'false',
                onClick: () => {
                  if (state.capturingKey) controller.cancelKeyCapture()
                  else controller.startKeyCapture()
                },
              },
              state.capturingKey ? t('shortcutCancel') : t('shortcutChange'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dpt-button',
                onClick: () => {
                  controller.cancelKeyCapture()
                  controller.setKeyBinding(DEFAULT_KEY_CODE)
                },
              },
              t('shortcutReset'),
            ),
          ),
        )
      }

      /** Settings → General row: opt-in standing microphone for zero press latency. */
      function KeepWarmRow() {
        useLocale()
        const state = React.useSyncExternalStore(controller.subscribe, controller.getState)
        const t = controller.t
        return h(
          'div',
          { className: 'dpt-setting' },
          h('style', null, STYLES),
          h(
            'div',
            { className: 'dpt-setting-text' },
            h('strong', { className: 'dpt-setting-title' }, t('keepWarmTitle')),
            h('span', { className: 'dpt-setting-desc' }, t('keepWarmDesc')),
          ),
          h(
            'div',
            { className: 'dpt-setting-actions' },
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': state.keepWarm ? 'true' : 'false',
                className: 'dpt-button',
                'data-primary': state.keepWarm ? 'true' : 'false',
                onClick: () => controller.setKeepWarm(!state.keepWarm),
              },
              state.keepWarm ? t('on') : t('off'),
            ),
          ),
        )
      }

      /** Settings → General row: hold the key while another application is focused. */
      function GlobalRow() {
        useLocale()
        const state = React.useSyncExternalStore(controller.subscribe, controller.getState)
        const t = controller.t
        const key = controller.keyLabel(state.keyCode)
        let description
        if (!state.globalHotkey) description = t('globalDescOff', { key }) + ' ' + t('globalTrouble')
        else if (state.globalError !== '') description = t('globalError', { message: state.globalError })
        else if (state.globalReady) description = t('globalDescOn', { key })
        else description = t('globalStarting')
        return h(
          'div',
          { className: 'dpt-setting' },
          h('style', null, STYLES),
          h(
            'div',
            { className: 'dpt-setting-text' },
            h('strong', { className: 'dpt-setting-title' }, t('globalTitle')),
            h('span', { className: 'dpt-setting-desc' }, description),
          ),
          h(
            'div',
            { className: 'dpt-setting-actions' },
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': state.globalHotkey ? 'true' : 'false',
                className: 'dpt-button',
                'data-primary': state.globalHotkey ? 'true' : 'false',
                onClick: () => controller.setGlobalHotkey(!state.globalHotkey),
              },
              state.globalHotkey ? t('on') : t('off'),
            ),
          ),
        )
      }

      /** Settings → General row: show replies in a transparent OS overlay. */
      function OverlayRow() {
        useLocale()
        const state = React.useSyncExternalStore(controller.subscribe, controller.getState)
        const t = controller.t
        return h(
          'div',
          { className: 'dpt-setting' },
          h('style', null, STYLES),
          h(
            'div',
            { className: 'dpt-setting-text' },
            h('strong', { className: 'dpt-setting-title' }, t('overlayTitle')),
            h(
              'span',
              { className: 'dpt-setting-desc' },
              state.overlayReplies ? t('overlayDescOn') : t('overlayDescOff'),
            ),
            state.overlayReplies ? h('span', { className: 'dpt-setting-warn' }, t('overlayWarn')) : null,
          ),
          h(
            'div',
            { className: 'dpt-setting-actions' },
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': state.overlayReplies ? 'true' : 'false',
                className: 'dpt-button',
                'data-primary': state.overlayReplies ? 'true' : 'false',
                onClick: () => controller.setOverlayReplies(!state.overlayReplies),
              },
              state.overlayReplies ? t('on') : t('off'),
            ),
          ),
        )
      }

      function providerUsablePhase(phase) {
        return phase === 'ready' || phase === 'standby' || phase === 'waking'
      }

      function downloadPercent(preparation) {
        if (!preparation || typeof preparation.totalBytes !== 'number' || preparation.totalBytes <= 0) return '…'
        const completed = Number(preparation.completedBytes ?? 0)
        return String(Math.min(99, Math.floor((completed / preparation.totalBytes) * 100)))
      }

      function formatElapsed(seconds) {
        const whole = Math.max(0, Math.floor(seconds))
        const minutes = Math.floor(whole / 60)
        const rest = whole % 60
        return minutes > 0 ? minutes + ':' + String(rest).padStart(2, '0') : '0:' + String(rest).padStart(2, '0')
      }

      function dock(tone, ...children) {
        return h(
          'div',
          { className: 'dpt-dock', 'data-tone': tone, role: 'status' },
          h('style', null, STYLES),
          children,
        )
      }

      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'push-to-talk-mic',
            order: 10,
          },
          MicButton,
        ),
      )
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'push-to-talk-status',
            order: 5,
          },
          StatusBar,
        ),
      )
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'push-to-talk-shortcut',
            order: 21,
          },
          ShortcutRow,
        ),
      )
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'push-to-talk-keep-warm',
            order: 22,
          },
          KeepWarmRow,
        ),
      )
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'push-to-talk-global',
            order: 23,
          },
          GlobalRow,
        ),
      )
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'push-to-talk-overlay',
            order: 24,
          },
          OverlayRow,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
