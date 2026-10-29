# dsh-push-to-talk — 按住说话

给 DeepSeek Harness 输入框加一个「按住说话」麦克风和一个**单键按住**快捷键：**按住录音，松开自动识别并发送**。

它复用本机已有的语音识别后端（语音输入插件包里的 `speechToText` 服务：SenseVoice 本地模型或云端服务），不重新下载模型，也不新增识别通道。

## 安装

从 npm（发布后）：

```
dsh plugin --profile <你的 profile> add dsh-push-to-talk
```

从 GitHub：

```
dsh plugin --profile <你的 profile> add git+https://github.com/zl0215/dsh-vediocontrol.git
```

也可以在 DSH 的 **插件 → 安装** 页面填入包名或 Git 地址安装。安装后本 bundle 会：

- 停用内置的点击式语音前端 `ui-voice-input`，改为按住说话按钮 + 单键快捷键；
- 在 Windows 上按需启动两个本机辅助进程（全局按键监听、回复浮窗），不联网。

前置条件：已启用 `@deepseek-ai/dsh-experimental-voice-input-bundle`（提供 `speechToText` 与 SenseVoice 模型）；首次使用需在页面里允许一次麦克风权限。

## 用法

- **麦克风**：输入框右侧、发送按钮之前。按住开始录音，波形与计时显示在输入框下方，松开即识别并发送。
- **快捷键**：默认 **F2**（单个按键）。在任意位置按住 F2 说话，松开即识别并发送；也可以在输入框里按住它。
- **取消**：上滑后松开、按 **Esc**，或按住快捷键时再按其它字符键，都会取消本次录音。
- 按下不足 350ms 视为误触，不会识别；没识别到语音也不会发送。
- 最长单次录音 120 秒（与语音服务默认上限一致）。

## 修改快捷键

**设置 → 通用 → 「按住说话快捷键」**：

- 点「修改」，再按下一个按键即可绑定。只接受**非字符按键**，避免和打字冲突：
  `F1`–`F12`、左/右 `Ctrl`、左/右 `Alt`、左/右 `Shift`。
- 「恢复默认」回到 `F2`。
- 绑定保存在浏览器本地（`localStorage`），换页面/重启后仍生效。

同一页面还有 **「麦克风常驻」** 开关：打开后麦克风保持待命，按下零等待（系统麦克风指示会一直亮着）；关闭时只在每次识别后热连接 2 分钟。第一次识别成功后会弹一次「开启零等待」的提示条，点一下即可打开。

> 之所以限制为功能键/修饰键：单个字符键（如 V）一旦绑定，就必须在每次输入该字符时让路，会破坏正常打字。

## 全局快捷键（离开 DSH 也能用）

默认关闭。打开 **设置 → 通用 → 「全局快捷键（其它软件中也能用）」** 后：

- 本插件会启动一个本机 PowerShell 辅助进程（`hotkey.ps1`），安装 Windows 低级键盘钩子，**只监听你绑定的那一个键**，不联网、不记录输入，也不拦截按键（其它软件照常收到这个键）。
- 之后即使你正在用别的软件、DSH 窗口在后台，**按住 F2 说话 → 松开**，识别结果会自动发送到 DSH 当前会话，由助手继续处理。
- 更换快捷键后会自动重启辅助进程、改为监听新键；关闭开关即停止辅助进程。
- 「麦克风常驻」建议同时打开：这样在其它软件里按下按键也是零等待；否则每次冷按仍会等设备打开。
- 第一次使用仍需在 DSH 页面里允许一次麦克风权限。

注意：

- 目前仅支持 Windows。
- DSH 窗口**不要最小化**（可以放在其它窗口后面）；最小化时浏览器会节流页面，按键与界面更新可能延迟。
- 如果任务需要工具调用审批，DHS 会停在审批提示上等你回到窗口确认；想让它全程自动执行，需要在设置里使用更宽松的权限预设。

## 回复悬浮窗

打开 **设置 → 通用 → 「回复悬浮窗」**（默认开启）后：

- 用全局快捷键（或窗口不在前台时按住麦克风）提问并发送后，插件会记住"这一问"，然后开始监听该会话的回复。
- 助手每产出一条回复，屏幕上就会显示一个**置顶、不抢焦点、白色背景**的小面板，右上角有「×」取消按钮，只显示这次提问的回答内容——**不会显示历史上下文**。
- 面板约 **10 秒**后自动消失（`OVERLAY_SECONDS`），点「×」立即关闭；鼠标可以正常点击面板（透明模式除外）。
- 面板带有 **屏幕捕获排除**：用 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` 把它从屏幕共享/录屏里排除，所以在腾讯会议共享**整个屏幕**时对方看不到它，而本机仍然正常可见。
- 本轮结束（`turn/end`）后停止监听；面板约 10 秒后自动消失，或点击右上角「×」立即关闭。回到 DSH 窗口时会主动收起。
- 文本过长时截断到约 1200 字符；回复中的代码围栏标记会被去掉，其余按纯文本显示。
- 实现：Host 侧再启动一个本机 PowerShell/WPF 辅助进程（`overlay.ps1`），通过 stdin 接收 `show <base64>` / `hide` / `quit`。

**关于透明背景的取舍**：Windows 只允许"非逐像素透明"的窗口使用捕获排除。原来那种背景完全透明的窗口无法被排除（实测 `SetWindowDisplayAffinity` 返回错误 8）。因此默认使用白色面板以换取会议共享时的隐私，并且面板可点击以便按取消按钮。如果更想要完全透明背景，可在启动 DSH 前设置环境变量 `DSH_OVERLAY_TRANSPARENT=1`，此时浮窗恢复透明（点击穿透、无取消按钮），但屏幕共享会看到它。

注意：

- 自动隐藏后窗口再次显示时会重新应用捕获排除；窗口隐藏期间 `GetWindowDisplayAffinity` 可能读出 0，再次显示后恢复为 0x11。
- 屏幕捕获排除是 Windows 10 2004+ 的能力；更旧系统会退化为"捕获画面里显示黑块"（`WDA_MONITOR` 回退）。
- 若会议软件使用非标准捕获方式（如部分远程桌面/硬件采集），排除可能不生效。

## 辅助进程的约定（`hotkey.ps1`）

- 由 Host 以 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File hotkey.ps1` 启动，只设置环境变量 `DSH_PTT_KEY`。
- stdout 每行一个事件、立即刷新：`ready`（钩子装好）、`down`、`up`、`error <原因>`；自动重复不会重复上报 `down`。
- 安装低级键盘钩子（`SetWindowsHookEx(WH_KEYBOARD_LL)`）后始终把按键转发给系统，**不吞键**。
- 不需要管理员权限、不联网、不写磁盘；准备就绪约 0.7 秒（运行时编译内嵌 C#）。
- 已知边界：收不到发往“以管理员运行”窗口的按键；UAC 提示/锁屏期间不产生事件；注入的按键也会被识别（便于自动化测试）。

## 麦克风权限与延迟

**为什么会弹「请允许使用麦克风」**：录音必须由浏览器调用系统麦克风，第一次在某个页面（来源）上使用时会询问授权。授权按「来源」记录，DSH 桌面端的本地页面地址带端口；如果两次启动之间端口不同，浏览器会把它当成新站点再问一次。点一次「允许」即可，同一来源之后不再询问。这是浏览器/Electron 层的行为，插件无法绕过。

**第一次按住可能“白按”一次**：授权弹窗期间还没开始录音。授权完成后如果已经松手，插件会提示「麦克风已授权。请再次按住说话」；如果一直按着，授权通过后会直接开始录音。

**按下 → 开始聆听之间为什么有延迟，以及怎么减少**：

延迟来自浏览器/系统打开麦克风设备本身（冷启动约 0.1–0.4 秒，蓝牙耳机可能 1 秒以上）。

- **鼠标点麦克风**：授权后，鼠标移到按钮上时插件已经提前打开设备，所以点下去基本没有延迟。
- **快捷键（F2）**：没有“悬停”这种提前信号，按下那一刻才开始打开设备，所以会看到这段冷启动延迟。
- 每次识别成功后麦克风会保持热连接 **2 分钟**，这段时间内再按快捷键几乎立即开始录音——也就是“说一句 → 等一下 → 再说一句”的第二次通常已经很快；只有中间隔了很久或第一次按会慢。
- **要彻底消除**：开启「麦克风常驻」，麦克风一直待命。第一次识别成功发送后，输入框下方会出现一次提示条「开启零等待」，点一下即可；也可以在 **设置 → 通用 → 「麦克风常驻」** 打开。代价是系统麦克风指示会持续亮着。

其他优化：全页面共用一个 16 kHz AudioContext，按下与松开两端都省掉创建/重采样开销；模型处于 `standby` 时会在按下瞬间顺便预加载；状态条会区分「正在打开麦克风…」和「请允许使用麦克风…」，看到「正在聆听」再开口可以避免第一个字被剪掉。

**松开 → 文字发出**：录音收尾 + 本机识别通常 0.2–0.6 秒（SenseVoice 对 1 秒音频约几十毫秒）。

## 依赖

- 已启用 `@deepseek-ai/dsh-experimental-voice-input-bundle` 提供的 Host 侧语音识别行（`speech-to-text`、`speech-to-text-sensevoice`、`api-speech-to-text`）。本插件只替换前端交互，不替换后端。
- 识别模型已准备好。若尚未准备，输入框下方会提示「下载并准备」，本插件可以直接触发下载并显示进度。
- 浏览器麦克风权限（本机回环地址即可，无需 HTTPS）。

## 发送行为

识别完成后，文字会插入到按住时记录的光标位置，然后立即提交发送（`inputActions.submit()`）：

- 输入框里原本已经输入的草稿会连同识别结果一起发送。
- 如果录音期间草稿被改动，插入会失败；此时结果会保留在输入框下方，提供「插入并发送 / 丢弃」。
- 未识别到语音、录音太短、识别失败时只提示，不会发送。

## 与内置语音插件的关系

本 bundle 的 patch 在启用时会把内置语音前端 `ui-voice-input`（点击开始、再点停止的麦克风）关掉，改用按住说话按钮与快捷键，避免出现两个麦克风。停用或卸载本插件后，内置麦克风自动恢复。已经被语音插件保存的「识别服务 / 识别语言」偏好继续生效；由于内置前端被停用，语音插件详情页里的识别偏好与设备选择面板不再显示（模型已就绪时通常无需再改）。如需改回原前端，停用本插件即可。

## 本机接口

Host 侧只注册一个仅回环可访问的 JSON 接口（`127.0.0.1` / `::1`），其它地址一律 403：

```
GET  /push-to-talk/api/status          识别服务、选中服务商、准备进度、录音上限
POST /push-to-talk/api/transcribe      { audioBase64 } → { text }（16 kHz 单声道 PCM16 WAV）
POST /push-to-talk/api/prepare         准备模型（可选下载源）
POST /push-to-talk/api/hotkey/bind     启动/停止全局按键辅助进程（{ enabled, code }）
GET  /push-to-talk/api/hotkey/state    辅助进程状态
GET  /push-to-talk/api/hotkey/poll     长轮询按键 down/up 事件（?since=N）
POST /push-to-talk/api/overlay/arm     开始监听某会话这一次提问的回复（{ sessionId }）
POST /push-to-talk/api/overlay/show    直接显示一段文字（调试用，{ text }）
POST /push-to-talk/api/overlay/hide    收起浮窗
GET  /push-to-talk/api/overlay/state   浮窗状态（ready/armed/visible/lastText）
```

录音数据只在本次请求内存在，不写入会话事件或附件。以上接口同样只接受本机回环访问。

## 发布到插件市场

本仓库已经是可发布状态（npm 包名 `dsh-push-to-talk`，带 `dsh.bundle.patch` 与 `dsh.client`）。发布步骤：

1. **GitHub**：新建仓库后推送本目录（仓库根目录就是本插件包）：

   ```
   git init -b main
   git add .
   git commit -m "feat: push-to-talk plugin for DeepSeek Harness"
   git remote add origin https://github.com/zl0215/dsh-vediocontrol.git
   git push -u origin main
   ```

2. **npm**：`npm login` 后 `npm publish`（`npm pack --dry-run` 可先检查打包内容）。

3. **DSH Plugin Hub（dsh-plugin.org）**：在 <https://dsh-plugin.org/zh/submit> 提交仓库地址，审核通过后即可在社区市场的「发现」里安装。

4. **官方 Discover 市场索引（可选）**：仓库里的 `market/index.json` 是格式 1 的市场索引（已用官方校验器 `@deepseek-ai/dsh-plugin-market-index` 验证通过），其中插件指向 npm 版本。把仓库发布到 GitHub 后，在 DSH 中启用 `@deepseek-ai/dsh-experimental-plugin-market-bundle`，然后在 **设置 / 发现** 里添加索引地址：

   ```
   https://raw.githubusercontent.com/zl0215/dsh-vediocontrol/main/market/index.json
   ```

   这个索引默认用 Git 源安装：`market/index.json` 里的 `versions[0].source.commit` 必须指向仓库里一个已推送的提交（当前为首次发布提交）。发新版时依次修改 `version`、`publishTimestamp`（Unix 秒）与 `source.commit`，提交推送后，索引地址内容自动更新。

## 已知限制

- 不提供输入设备选择器和识别语言选择器：使用系统默认麦克风与语音插件中已保存的服务/语言（默认自动识别）。
- 页面内快捷键只在聊天输入框存在时生效（新建会话/设置页等无输入框的页面不会触发）；全局快捷键需要当前会话的输入框存在，DSH 窗口运行中即可。
- 全局快捷键仅支持 Windows，且会额外运行一个本机 PowerShell 辅助进程；DSH 窗口最小化时页面会被节流，建议保持窗口可见（可在其它窗口后面）。
- 页面内按住期间切换会话、页面隐藏或浏览器失焦会结束/取消本次录音；全局录音不受窗口失焦影响。
- 若语音识别服务不可用（语音输入插件包被停用），按钮会以半透明提示，输入框下方给出说明。

## 文件

- `index.js` — Host 插件：注册回环 JSON 接口，桥接 `speechToText`；管理全局按键与回复浮窗两个辅助进程，监听会话事件把回复送到浮窗。
- `hotkey.ps1` — Windows 辅助进程：低级键盘钩子，把绑定的单个按键的按下/松开写到 stdout。
- `overlay.ps1` — Windows 辅助进程：WPF 白色置顶面板（带取消按钮、录屏不可见），从 stdin 接收要显示的文字。
- `client.js` — 浏览器插件：按住手势与单键按住、全局按键事件订阅、录音与 16 kHz 重采样、识别状态条、设置行、插入并发送。
- `market/index.json` — 官方插件市场索引（格式 1，已通过官方校验器）。
- `cordis.patch.yml` — 停用内置语音前端并插入本插件行。
- `locale/*.json`、`icon.svg` — 插件管理器中的标题、描述与图标。
- `NOTICE.md` — 录音与重采样代码的上游归属说明（MIT）。
- `test/` — 离线冒烟测试与两个 Windows 辅助进程的探针测试。

## 验证

已在当前 `desktop` 配置中验证：

- `node --check` 通过（`index.js`、`client.js`）。
- 全局按键辅助进程 `hotkey.ps1` 的独立冒烟测试通过（`test/hotkey-smoke.ps1`，66 项断言）：18 个可绑定按键的
  `ready/down/up`、非目标键不触发、长按自动重复只上报一次、20 秒存活与继续工作、进程结束释放钩子；
  `spawn → ready` 实测 0.65–1.13 秒。
- Host 端到端：`POST /hotkey/bind` 启动辅助进程并很快 `ready`；用 `SendInput` 注入一次 F2 后，
  `GET /hotkey/poll` 返回 `down` / `up` 事件；重复 bind 复用进程不重启；切换按键会按新键重启。
- 离线冒烟测试通过（`node test/smoke-client.mjs`）：加载浏览器模块、执行 `apply()`、注册五个入口
  （`conversation.input.right#push-to-talk-mic`、`conversation.composer.dock#push-to-talk-status`、
  `settings.general.item#push-to-talk-shortcut/-keep-warm/-global`）、渲染组件、拦截默认 F2 按键、
  重新绑定按键并持久化、切换「麦克风常驻」并持久化、开启「全局快捷键」后向 Host 绑定按键并启动事件长轮询。
- `GET /push-to-talk/api/status` 返回真实的识别服务快照（SenseVoiceSmall (INT8)，`phase: ready`，
  语言 `auto`，上限 120 秒 / 4 MiB）。
- `POST /push-to-talk/api/transcribe` 用 1 秒 16 kHz WAV 端到端调用 `speechToText.transcribe`
  成功返回（`{"ok":true,"text":"","audioSeconds":1,...}`）。
- 已连接页面中相关入口的占用者（occupant）均为 `active`，内置 `ui-voice-input` 行已停用。
- 回复浮窗 `overlay.ps1` 用独立探针实测（`test/overlay-probe.ps1`）：spawn→ready 约 0.7 秒；窗口扩展样式
  实测 `0x08000088`（TOPMOST + TOOLWINDOW + NOACTIVATE，置顶、不抢焦点、可点击）；**捕获排除实测
  `affinity=0x11`**；白色面板显示可见、前台窗口不变；自动隐藏、再次 show、hide、quit 优雅退出（exit 0）。
- 实时集成验证：通过 Host 接口显示的白色浮窗（独立进程）在系统里枚举到 `affinity=0x11` 且 `visible=True`；
  约 10 秒后窗口自动隐藏（枚举不到可捕获排除的可见窗口）。
- Host 侧 `POST /overlay/show` 中文文本经 UTF-8 显示成功（`/overlay/state.lastText` 一致）；
  `POST /overlay/arm` 后状态为 `armed:true`，并做过一次真实会话回复镜像演练。
- 待用户实测：离开 DSH、在其它软件中按 F2 的完整链路（按键 → 识别 → 发送 → 浮窗显示回复 → 助手执行）。
- 浏览器内的实际外观与真实录音效果由用户确认；本环境没有浏览器控制能力。

修改 `client.js` 后浏览器会热加载新的 client 产物（当前页面已自动生效）；Host 侧
`index.js` 的改动需要重启应用才会重新加载。
