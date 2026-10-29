# dsh-automation — implementation contract

This is a DeepSeek Harness **Host plugin bundle** that gives the agent desktop and browser
automation tools: screenshots, screen recording, mouse and keyboard input, app control and
Chromium automation over the DevTools protocol.

Everything is zero-dependency plain ESM JavaScript. Desktop automation targets **macOS**;
the browser layer is cross-platform. No npm packages may be added. `index.js` registers six
model-facing tools and imports the modules described below.

Environment facts used during development:

- Node 22+ for the global `WebSocket`; macOS (Darwin, arm64) for the desktop paths.
- Google Chrome / Microsoft Edge installed under `/Applications`; ffmpeg/ffprobe from Homebrew.
- `/usr/bin/swiftc` (Xcode Command Line Tools) for compiling the native macOS helper.
- Tools are registered in `index.js` via `ctx.tools.register({name, description, parameters,
  output:{schema, render}, execute, isConcurrencySafe?})`. `parameters` is a raw JSON Schema
  object and `output.render(value)` must return `[{type:'text', text}]`; the shared helper is
  `renderText(value)` from `lib/util.mjs`.
- **Sandbox caveat for testing:** inside a seatbelt sandbox Chrome/Chromium must be launched
  with `--no-sandbox`, and `screencapture`, AppleScript and TCC checks report permission
  failures there even though the installed plugin runs in the unsandboxed Host process.


### `lib/native.mjs` 

Wraps the compiled Swift helper `lib/native-helper.swift`. Compile once per source hash into
`config.helperCacheDir` or `<artifactBase>/bin`, e.g. `native-helper-<hash8>`, using
`swiftc -O -module-cache-path <cache>/module-cache -o <cache>/<name> lib/native-helper.swift`
(via `run` from `lib/util.mjs`). All helper calls use a JSON protocol: `execFile(binary,
[command, JSON.stringify(args)])` and must `JSON.parse` stdout; a helper error prints
`{"error": "...", "code": "..."}` and exits non-zero. Cache the compiled binary path in module
state; compile failures must surface an actionable error (Xcode CLT / `xcode-select --install`).

Exports:

```js
export async function ensureHelper({ cacheDir, timeoutMs })   // -> absolute binary path
export async function permissions()                            // -> {accessibility:boolean, screenRecording:boolean, platform, helperPath?}
export async function requestPermission(kind)                  // kind: 'screen-recording'|'accessibility' -> {granted, prompted:boolean}
export async function openSettings(kind)                       // 'screen-recording'|'accessibility'|'automation' -> {opened:true, url}
export async function screenInfo()                             // -> {displays:[{id, main, bounds:{x,y,width,height}, scale, name?}], cursor:{x,y}, frontmostApp:{name,bundleId,pid}}
export async function appList()                                // -> [{name, bundleId, pid, active, hidden, windows:[{title,bounds,minimized}]}]
export async function appAction({ action, app, args })         // action: 'launch'|'activate'|'quit'|'hide'|'show' -> {ok, app:{...}}
export async function appWindows({ app })                      // -> [{title, bounds, minimized}]
export async function mouse({ action, x, y, from, to, button, count, deltaX, deltaY, durationMs, modifiers })
export async function keyboard({ action, key, keys, text, modifiers, delayMs }) // action: 'key'|'hotkey'|'type'
export async function clickAt({ x, y, button, count, modifiers })   // convenience used by screen/tests
export async function axTrusted()                              // -> boolean (helper preflight)
```

Semantics: coordinates are global screen points (top-left origin, same space as
`screencapture` and `CGEvent`). Mouse must move with intermediate steps then post
down/up (double click = clickCount 2 on both events with a small delay). `hotkey` takes
an array such as `["cmd","shift","t"]`. `type` must type arbitrary Unicode text
(CGEventKeyboardSetUnicodeString, chunked) and not depend on the current keyboard layout.
`modifiers` is an array of `cmd|ctrl|alt|shift|fn`.

Fallback: when `swiftc` is unavailable, `keyboard`/`mouse` click/key/hotkey/type may fall back
to `osascript` System Events, but return `backend: 'applescript'` and a hint that accessibility
permission is required; `mouse` move/scroll/drag then fail with a clear error.

### `lib/screen.mjs` 

```js
export async function capture(args, { artifacts, exec, config })
// args: { display?, region?:{x,y,width,height}, window?: string|number, app?: string,
//         cursor?: boolean, format?: 'png'|'jpg'|'pdf', path? }
// -> {path, width, height, bytes, target, display?}
export async function displays()
export async function windows({ app })          // -> [{windowId, app, title, bounds, layer}]
export async function startRecording(args, { artifacts, exec, config })
// args: { display?, region?, showClicks?: boolean, audio?: boolean } -> {id, path, startedAt, command}
export async function stopRecording({ id })     // -> {id, path, bytes, durationMs, width?, height?, encoder}
export async function recordingStatus()         // -> {recordings:[{id, path, startedAt, running, elapsedMs}]}
export async function dispose()                 // stop every running recording and wait
```

Screenshot: `/usr/sbin/screencapture -x` with `-D<display>`, `-R x,y,w,h`, `-l <windowId>`,
`-C` (cursor), `-t jpg`. Window selection by title/app: resolve via native window list
(`/usr/sbin/screencapture -l<id>`), fail with a clear hint listing candidate windows.
Verify the file exists and is non-empty; get pixel dimensions with
`sips -g pixelWidth -g pixelHeight` (or parse PNG/JPEG header) and bytes from `stat`.
Screen Recording permission failures surface as `screencapture` exit 1 with
`"could not create image from display"`; map that to an `AutomationError` with code
`SCREEN_RECORDING_PERMISSION` and a hint to enable Screen Recording for DeepSeek Harness and
run the `computer_permissions` tool.

Recording: primary `screencapture -v -x [-D n] [-R ...] [-k] [-g] <path>.mov`, kept running
until stop; stop sends SIGINT, waits for exit (up to ~10s), then validates the file. Track
processes in module state. If `screencapture -v` exits immediately with an error, fall back to
ffmpeg avfoundation (`-f avfoundation -i "Capture screen N" -r <fps>`), but only when ffmpeg is
found; report `encoder:'ffmpeg'|'screencapture'`. Duration via `ffprobe` when available, else
wall clock.

### `lib/apps.mjs` 

```js
export async function listApps()                       // via native.appList()
export async function open({ target, app })            // `/usr/bin/open [-a app] target` -> {ok, target}
export async function activate({ app })
export async function quit({ app, force })
export async function hide({ app })
export async function windows({ app })
export async function appleScript({ script, language })// language: 'applescript'|'jxa' -> {stdout, stderr, code}
```

`appleScript` uses `/usr/bin/osascript` (`-l JavaScript` for jxa), timeout, and maps
-1743 / -10004 / "not authorized" to an `AutomationError` with code `AUTOMATION_PERMISSION`
and a hint about System Settings → Privacy & Security → Automation / Accessibility.

### `lib/browser.mjs` 

Chromium control over the DevTools Protocol with the global `WebSocket` — no Playwright.
The Lead constructs it once at plugin apply and calls `dispose()` on unload:

```js
export class BrowserManager {
  constructor({ artifacts, config, log })
  async run(args, exec)   // args.action selects; returns a JSON-serializable object; throws AutomationError
  async dispose()
}
```

`artifacts` is the `ArtifactWriter` from `lib/artifact.mjs` (use
`artifacts.path(exec, 'browser', 'png')` and `artifacts.dir(exec, 'browser-profile')`).
`config` carries `browserKind`, `browserHeadless`, `browserPort`, `browserUserDataDir`,
`browserExecutable`, `commandTimeoutMs`.

Actions (all return plain objects; include `page` info where useful):

- `launch` `{browserKind?, headless?, port?, userDataDir?, viewport?:{width,height}, url?}`
  → `{browser, port, wsUrl, pid, userDataDir, page:{id,url,title}}`. Reuse an existing
  instance when already running. Must work headless and headed.
- `connect` `{port?, wsUrl?}` → same shape (attach to an already-running browser).
- `close` → `{closed:true}`; also kill a launched child process.
- `status` → `{running, browser, port, wsUrl, pages:[{id,url,title,active}], recording}`
- `pages` → `{pages:[...]}`, `new_page` `{url?}` → `{page}`, `select_page` `{pageId}` → `{page}`
- `goto` `{url, waitUntil?:'load'|'domcontentloaded'|'networkidle', timeoutMs?}`
  → `{page, status}`; also `back`, `forward`, `reload`.
- `click` `{selector, button?, clickCount?, timeoutMs?}`; `dblclick`; `hover`;
  selectors: CSS, or `text=...` (visible text match), or `xpath=...`. Click must dispatch real
  `Input.dispatchMouseEvent` at the element's viewport center (scroll into view first) and
  return `{clicked:true, selector, box}`.
- `fill` `{selector, value, clear?}` (focus + select-all + `Input.insertText`, React-safe),
  `type` `{selector?, text, delayMs?}`, `press` `{key, modifiers?, selector?}` (key map:
  Enter/Tab/Escape/Backspace/Delete/Arrows/Home/End/PageUp/PageDown/Space/F1-F12/letters;
  modifiers `cmd|ctrl|alt|shift`), `select_option` `{selector, value}`, `check`/`uncheck`.
- `scroll` `{selector?, x?, y?, deltaX?, deltaY?}`.
- `wait_for` `{selector?, text?, state?:'visible'|'hidden'|'attached'|'detached',
  timeoutMs?, networkIdle?}` → `{matched:true, elapsedMs}`; default timeout 10s.
- `snapshot` `{maxText?:number}` → `{page, elements:[{ref, role, name, selector, value?,
  checked?, disabled?, tag}], text}`. Walk the DOM in one `Runtime.evaluate`, keep only visible
  elements, compute a CSS selector usable by `click`, include interactive elements (a, button,
  input, select, textarea, [role], [onclick], [contenteditable], headings) and a bounded body
  text (default 4000 chars). This is the main way a text-only model perceives a page.
- `eval` `{expression, awaitPromise?}` → `{result}` (JSON-serializable; throw on page exception).
- `screenshot` `{path?, fullPage?, selector?, format?:'png'|'jpeg', quality?}` → `{path, width,
  height, bytes}`.
- `record_start` `{fps?, quality?, maxWidth?}` → `{recording:true, frames}`;
  `record_stop` → `{path, frames, durationMs, bytes, encoder:'ffmpeg'|'frames'}`.
  Use `Page.startScreencast` (format jpeg, quality 80); on every frame ack with
  `Page.screencastFrameAck` and write `frame-00001.jpg` into an artifact dir; stop encodes to
  mp4 with ffmpeg using the concat demuxer with per-frame durations (min 20ms, max 2s,
  `-pix_fmt yuv420p -movflags +faststart`), fallback `encoder:'frames'` + frames dir when
  ffmpeg is missing. Recording must not deadlock the page.
- `console` `{limit?}` → `{messages:[{level, text, timestamp}]}` (Runtime.consoleAPICalled +
  Log.entryAdded, last 200 buffered), `network` `{limit?}` → `{requests:[{url, method, status,
  failed, error?}]}` (Network.enable, last 300), `dialog` `{policy:'accept'|'dismiss',
  promptText?}` → `{policy}` (javascript dialogs are otherwise auto-accepted and logged),
  `viewport` `{width,height,deviceScaleFactor?,mobile?}`, `download_list` `{limit?}` →
  `{downloads:[{filename,url,state,path}]}` (Browser.setDownloadBehavior allow into
  `<artifact dir>/downloads`), `pdf` `{path?}` → `{path, bytes}`.

CDP requirements: use one browser-level WebSocket, `Target.attachToTarget {flatten:true}` for
page sessions, unique message ids, request timeouts, reject on `error` responses, capture
`Runtime.executionContextDestroyed`/`Target.detachedFromTarget` safely. Enable `Page`,
`Runtime`, `Network`, `Log` once per page. Launch args must include
`--remote-debugging-port=<port> --user-data-dir=<dir> --no-first-run --no-default-browser-check
--disable-background-networking --remote-allow-origins=*`; pick a free port when none is
requested and poll `http://127.0.0.1:<port>/json/version` for readiness. A launched browser is
a child process — never leave it running after `dispose()`.

## Testing

- Write your own standalone checks under `dsh-automation/test/` or `scripts/` prefixed with
  your module name, runnable with plain `node`. Browser tests must launch Chrome with
  `--no-sandbox` (the `browser` module itself must NOT hardcode `--no-sandbox`; instead honor
  env `DSH_AUTOMATION_CHROME_NO_SANDBOX=1` or a `noSandbox` launch param for test runs).
- Use a temporary artifact dir (e.g. `/tmp/dsh-auto-test`) in tests, never the workspace root.
- Report: files written, commands run, observed results, and anything not verifiable without
  macOS TCC permissions.
