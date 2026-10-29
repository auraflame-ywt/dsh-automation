# dsh-automation — 桌面与浏览器自动化插件

给 DeepSeek Harness 增加「操作本机 + 操作浏览器」的能力：截屏、录屏、真实鼠标键盘输入、应用控制、
AppleScript 逃生舱，以及基于 DevTools 协议（CDP）的 Chromium 浏览器自动化，适合做 UI 自动化测试。

> **平台**：当前发布的是 **macOS 版**。桌面自动化基于 Swift helper + `screencapture` + `osascript`，
> 需要授予辅助功能与屏幕录制权限；**Windows 版已发布，见
> [`@liuxinye/dsh-computer-use`](https://github.com/auraflame-ywt/dsh-computer-use)**；浏览器自动化部分跨平台。

## 平台支持

| 平台 | 桌面自动化 | 浏览器自动化 |
| --- | --- | --- |
| **macOS** | ✅ 当前版本完整支持（本版本即为 macOS 版） | ✅ |
| **Windows** | ✅ 另见 [`@liuxinye/dsh-computer-use`](https://github.com/auraflame-ywt/dsh-computer-use) | ✅ |
| Linux | —— | ✅ |

> Windows 桌面能力（窗口/输入/截图/UIAutomation）由独立插件 `@liuxinye/dsh-computer-use` 提供，
> 与本插件共享同一组工具名与设计；macOS 版的能力边界见文末「已知限制」。

- 纯 ESM、零 npm 依赖（Node 22+ 内置 `WebSocket`）
- Host 插件 bundle，安装后对所有会话可用，重启后仍然生效
- 所有产物（截图 / 录屏 / 浏览器 profile / 下载）落在当前会话工作目录的 `.dsh-automation/` 下

## 六个工具

| 工具 | 能力 |
| --- | --- |
| `computer_permissions` | 检查 / 申请 / 打开 macOS 隐私权限设置（屏幕录制、辅助功能、自动化） |
| `screen_capture` | 截取整屏、指定区域、指定窗口；列出显示器与窗口；输出 PNG/JPG/PDF |
| `screen_record` | 录制屏幕或自动化浏览器页面为 mp4；start / stop / status |
| `computer_input` | 移动、单击 / 双击 / 右键 / 中键、拖拽、滚轮、输入文字、按键、快捷键 |
| `computer_app` | 列出 / 启动 / 激活 / 退出 / 隐藏应用，列窗口，打开文件或 URL，运行 AppleScript / JXA |
| `browser` | Chrome/Edge：启动/连接、导航、快照、点击、填表、按键、等待、eval、截图、录屏、console/network、标签页、下载、PDF |

### 浏览器测试推荐流程

```
browser launch headless=true            # 启动（无头或带窗口）
browser goto url=...                    # 导航
browser snapshot                        # 拿到可见元素的 CSS 选择器
browser click selector='text=登录'      # 用选择器或 text= 点击
browser fill selector='#user' value=... # 填表（React 兼容）
browser wait_for text=欢迎 timeoutMs=10000
browser console / network               # 断言日志与请求
browser screenshot                      # 截图证据（read_image 可查看）
browser record_start / record_stop      # 录屏证据（mp4）
```

`snapshot` 是文本模型感知页面的主要方式：返回可见交互元素（角色、名称、可复用的 CSS 选择器、
值、勾选状态）加一段有界页面正文。

## macOS 权限

`screen_capture`、屏幕录屏需要 **屏幕录制（Screen Recording）**；`computer_input`、
`computer_app windows` 需要 **辅助功能（Accessibility）**；`computer_app script` 驱动其他
应用时需要 **自动化（Automation）**。授权对象都是 **DeepSeek Harness**。

1. 让智能体调用 `computer_permissions` `action=request`（会触发系统弹窗），或
2. 手动打开「系统设置 → 隐私与安全性 → 屏幕录制 / 辅助功能」，勾选 DeepSeek Harness；
3. **屏幕录制授权后必须退出并重新打开 DeepSeek Harness** 才生效；
4. 再调用 `computer_permissions` `action=check` 确认三项状态。

`screen_capture` 失败时会返回可操作的错误提示（`SCREEN_RECORDING_PERMISSION`），不会静默失败。

## 配置

`cordis.patch.yml` 中的行配置（都可省略）：

```yaml
- id: automation-suite
  name: '@liuxinye/dsh-automation'
  config:
    artifactDir: null          # null -> <会话工作目录>/.dsh-automation
    browserKind: chrome        # chrome | edge
    browserHeadless: true      # 默认无头；单次 launch 可覆盖
    browserPort: null          # null -> 自动挑选空闲端口
    browserUserDataDir: null   # null -> <artifactDir>/browser-profile
    helperCacheDir: null       # Swift 原生助手的编译缓存目录；null -> $TMPDIR/dsh-automation-native
    commandTimeoutMs: 30000
```

## 架构

- `index.js`：注册六个工具、参数映射、错误整形（唯一的 harness 耦合点）
- `lib/native-helper.swift` + `lib/native.mjs`：编译一次的原生助手，用 CGEvent 发真实鼠标键盘事件、
  CGPreflight/AX 检查权限、CGWindowList 列窗口、NSWorkspace 控制应用
- `lib/screen.mjs`：`screencapture` 截图；`screencapture -v` 录屏（SIGINT 收尾），ffmpeg 兜底
- `lib/apps.mjs`：应用生命周期与 `osascript` AppleScript / JXA
- `lib/browser.mjs`：自研 CDP 客户端（浏览器级 WebSocket + flatten session），真实输入事件、
  DOM 快照、`Page.startScreencast` + ffmpeg 合成 mp4
- `lib/util.mjs` / `lib/artifact.mjs`：进程执行、时间戳、产物目录

## 测试

```bash
cd dsh-automation
node test/integration-smoke.mjs   # 挂载插件并跑真实工具调用（浏览器全链路）
node test/native-selftest.mjs     # 原生助手编译与协议
node test/browser-selftest.mjs    # CDP 全动作面
```

测试用 `/tmp/dsh-auto-test` 存放产物；Chrome 在 sandbox 内跑需要 `--no-sandbox`（仅测试路径）。

## 安装

在 DSH 的 **设置 → 插件 → 安装** 里填包名：

```text
@liuxinye/dsh-automation
```

命令行等价：

```bash
dsh plugin --profile desktop add @liuxinye/dsh-automation
```

### 从源码链接（开发调试）

```bash
dsh plugin --profile desktop add "link:/绝对路径/dsh-automation"
```

安装后六个工具对所有会话可见，无需在会话内额外启用。

## 验证状态

本机（macOS 27 / Chrome 156 / Node 24，2026-10-28）实测：

- 自动化测试套件：`integration-smoke` PASS、`browser-selftest` 173/173、`native-selftest` 65 PASS
- Host 内实测通过（三项权限均已授予）：
  - 权限报告 / 显示器 / 窗口枚举（含窗口标题）、区域截图、窗口截图、整屏录屏
    （screencapture h264 mov，1920×1080，ffprobe 校验）
  - 真实鼠标点击（计算器 7 键：显示 1 → 17）、Unicode 输入（→ 173）、Escape/Return 按键、
    快捷键 `cmd+2` / `cmd+1`（计算器切换科学/基础视图，窗口宽 342→786px）、应用激活、AppleScript
  - 浏览器 headless + headed 启动（无 `--no-sandbox`）、goto、snapshot（含 ref/CSS 选择器）、
    点击、填表、等待、console、截图（PNG 校验）、浏览器录屏（ffmpeg 合成 mp4，抽帧确认画面内容）、
    关闭后无残留 Chrome 进程

## 已知限制

- 桌面能力目前只实现 macOS（Swift / screencapture / osascript）；浏览器部分跨平台。
- 屏幕录制在授权生效前会失败；区域录制依赖系统 `screencapture -v` 对 `-R` 的支持。
- 浏览器录屏是逐帧 screencast 合成，动作很快时帧率会下降（只在新帧到达时采集）。
- 页面加载瞬间（`browser` 连接建立之前）的 console 日志不会被缓冲；连接后产生的日志正常捕获。
- `snapshot` 只覆盖主文档，不穿透 shadow DOM 与 iframe。
- `browser` 每次调用都是一次独立 CDP 往返，状态（当前页面、录制）保存在插件实例内，直到
  `browser close` 或 Harness 退出。
- 截图/录屏/浏览器 profile 默认落在当前会话工作目录的 `.dsh-automation/`；如不希望污染仓库，
  可在配置里改 `artifactDir` 或在项目 `.gitignore` 中忽略该目录。
