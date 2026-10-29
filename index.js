/**
 * Desktop & Browser Automation — a Host plugin bundle for DeepSeek Harness.
 *
 * Registers six model-facing tools:
 *   computer_permissions  macOS TCC diagnosis/requests for the desktop tools
 *   screen_capture        screenshots of a display, region or window
 *   screen_record         video recording of the screen or an automation browser page
 *   computer_input        real mouse / keyboard input on the desktop
 *   computer_app          application lifecycle, windows, open target, AppleScript/JXA
 *   browser               Chromium automation over the DevTools protocol
 *
 * Implementation modules: lib/native.mjs (Swift helper), lib/screen.mjs, lib/apps.mjs,
 * lib/browser.mjs (CDP). This file owns tool schemas, argument mapping and error shaping.
 *
 * @module @liuxinye/dsh-automation
 */
import { ArtifactWriter } from './lib/artifact.mjs'
import { BrowserManager } from './lib/browser.mjs'
import * as apps from './lib/apps.mjs'
import * as native from './lib/native.mjs'
import * as screen from './lib/screen.mjs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import {
  AutomationError,
  asObject,
  errorText,
  renderText,
  requireString,
  sleep,
} from './lib/util.mjs'

/** Plugin row name shown by the Loader. */
export const name = 'automation-suite'
/** The tool registry is the only hard dependency. */
export const inject = ['tools']

/** Config defaults; `cordis.patch.yml` overrides them. */
const DEFAULTS = Object.freeze({
  artifactDir: null,
  browserKind: 'chrome',
  browserHeadless: true,
  browserPort: null,
  browserUserDataDir: null,
  browserExecutable: null,
  helperCacheDir: null,
  commandTimeoutMs: 30000,
})

const PERMISSION_HINT =
  'Grant it to "DeepSeek Harness" in System Settings → Privacy & Security, then quit and reopen DeepSeek Harness and run computer_permissions with action "check".'

/** --- tiny schema builders ------------------------------------------------ */
const S = (description) => ({ type: 'string', description })
const N = (description) => ({ type: 'number', description })
const B = (description) => ({ type: 'boolean', description })
const E = (values, description) => ({ type: 'string', enum: values, description })
const A = (items, description) => ({ type: 'array', items, description })
const O = (properties, description, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  description,
})

const POINT = O({ x: N('Global x coordinate in screen points.'), y: N('Global y coordinate in screen points.') }, 'A global screen point.')
const REGION = O(
  {
    x: N('Left edge in screen points.'),
    y: N('Top edge in screen points.'),
    width: N('Width in screen points.'),
    height: N('Height in screen points.'),
  },
  'A rectangular screen region in global screen points.',
)
const MODIFIERS = A(E(['cmd', 'ctrl', 'alt', 'shift', 'fn'], 'Modifier key.'), 'Modifier keys held for the action.')

const SCHEMA_OBJECT = { type: 'object' }
const SCHEMA_ANY = { type: 'json' }

/**
 * Wrap an execute body so expected failures reach the model as a readable message
 * with the actionable hint.
 * @param {(args: Record<string, unknown>, exec: any) => Promise<unknown>} body
 * @returns {(args: unknown, exec: any) => Promise<unknown>}
 */
function guarded(body) {
  return async (args, exec) => {
    try {
      return await body(asObject(args), exec)
    } catch (error) {
      if (error instanceof AutomationError) throw new Error(errorText(error))
      throw error
    }
  }
}

/**
 * Register one tool definition, keeping registration as a plugin effect.
 * @param {any} ctx
 * @param {any} definition
 */
function register(ctx, definition) {
  ctx.tools.register(definition)
}

/**
 * Mount the automation suite.
 * @param {any} ctx Cordis plugin context with the `tools` service.
 * @param {Record<string, unknown>} config bundle row config.
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS }
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value !== undefined && value !== null) settings[key] = value
  }
  // One compiled Swift helper shared by every module; a stable default cache keeps
  // it warm across sessions instead of landing next to a per-session artifact dir.
  if (typeof settings.helperCacheDir !== 'string' || settings.helperCacheDir.trim().length === 0) {
    settings.helperCacheDir = joinPath(tmpdir(), 'dsh-automation-native')
  }
  native.configure({ cacheDir: settings.helperCacheDir, timeoutMs: settings.commandTimeoutMs })
  const artifacts = new ArtifactWriter({ ctx, config: settings })
  const log = (levelOrMessage, maybeMessage) => {
    const line = typeof maybeMessage === 'string' ? `${levelOrMessage} ${maybeMessage}` : String(levelOrMessage)
    try {
      console.log(`[dsh-automation] ${line}`)
    } catch {
      /* logging must never break a tool */
    }
  }
  const browser = new BrowserManager({ artifacts, config: settings, log })

  ctx.effect(() => () => {
    Promise.resolve()
      .then(() => browser.dispose())
      .catch((error) => log(`browser dispose failed: ${errorText(error)}`))
    Promise.resolve()
      .then(() => screen.dispose())
      .catch((error) => log(`recording dispose failed: ${errorText(error)}`))
  })

  register(ctx, permissionsTool(ctx, settings))
  register(ctx, captureTool(ctx, settings, artifacts))
  register(ctx, recordTool(ctx, settings, artifacts, browser))
  register(ctx, inputTool(ctx, settings))
  register(ctx, appTool(ctx, settings))
  register(ctx, browserTool(ctx, settings, browser))
  log('tools registered: computer_permissions, screen_capture, screen_record, computer_input, computer_app, browser')
}

/** --- computer_permissions ------------------------------------------------ */

function permissionsTool(ctx, settings) {
  return {
    name: 'computer_permissions',
    description:
      'Check, request or open settings for the macOS privacy permissions that desktop automation needs. Screen Recording is required by screen_capture and display screen_record; Accessibility is required by computer_input and app window details; Automation is required by computer_app scripts that drive another app. Call action "check" after any permission-related tool failure, and action "request" to trigger the system prompt. macOS applies Screen Recording grants only after the app restarts.',
    parameters: O(
      {
        action: E(['check', 'request', 'open_settings'], 'check reports current status; request triggers the system prompt; open_settings opens the relevant System Settings pane.'),
        target: E(['screen_recording', 'accessibility', 'automation'], 'Which permission action "request" or "open_settings" applies to. Defaults to both desktop permissions.'),
      },
      'macOS permission diagnostics.',
      ['action'],
    ),
    output: { schema: SCHEMA_OBJECT, render: (_args, value) => renderText(value) },
    timeoutMs: 60000,
    execute: guarded(async (args) => {
      const action = requireString(args.action, 'action')
      if (action === 'check') {
        const report = await permissionReport(settings)
        return report
      }
      if (action === 'request') {
        const target = typeof args.target === 'string' ? args.target : 'both'
        const requested = []
        if (target === 'screen_recording' || target === 'both') requested.push(await safeCall(() => native.requestPermission('screen-recording')))
        if (target === 'accessibility' || target === 'both') requested.push(await safeCall(() => native.requestPermission('accessibility')))
        if (target === 'automation') requested.push({ target, prompted: false, note: 'Automation is requested by the first AppleScript call to each app; there is no preflight prompt. Use computer_app action "script" to trigger it.' })
        const report = await permissionReport(settings)
        return { ...report, requested }
      }
      if (action === 'open_settings') {
        const target = typeof args.target === 'string' ? args.target : 'both'
        const opened = []
        if (target === 'screen_recording' || target === 'both') opened.push(await safeCall(() => native.openSettings('screen-recording')))
        if (target === 'accessibility' || target === 'both') opened.push(await safeCall(() => native.openSettings('accessibility')))
        if (target === 'automation') opened.push(await safeCall(() => native.openSettings('automation')))
        return { opened, hint: `Turn on the matching switch for DeepSeek Harness. ${PERMISSION_HINT}` }
      }
      throw new AutomationError(`unknown action "${action}"`, { code: 'BAD_ACTION', hint: 'Use action check, request or open_settings.' })
    }),
  }
}

/**
 * Assemble the permission report, tolerating an unavailable native helper.
 * @param {Record<string, unknown>} settings
 */
async function permissionReport(settings) {
  let status
  try {
    status = await native.permissions()
  } catch (error) {
    return {
      platform: process.platform,
      helperAvailable: false,
      error: errorText(error),
      hint: 'The native Swift helper is used for Accessibility checks; screenshots still work through screencapture. Install Xcode Command Line Tools (xcode-select --install) to enable input and app windows.',
    }
  }
  let automation = 'unknown'
  let automationError
  try {
    const probe = await apps.appleScript({ script: 'tell application "Finder" to return name of startup disk', language: 'applescript' })
    if (probe.code === 0) automation = 'granted'
    else {
      automation = 'denied'
      automationError = String(probe.stderr ?? '').trim().slice(0, 300)
    }
  } catch (error) {
    automation = 'denied'
    automationError = errorText(error)
  }
  const hints = []
  if (status.screenRecording !== true) hints.push(`Screen Recording is off: screenshots, display recording and window titles fail. ${PERMISSION_HINT}`)
  if (status.accessibility !== true) hints.push(`Accessibility is off: mouse/keyboard input and window details fail. ${PERMISSION_HINT}`)
  if (automation !== 'granted') hints.push('Automation for Finder is not granted: scripts that control other apps need it. Open System Settings → Privacy & Security → Automation.')
  return {
    platform: process.platform,
    helperAvailable: true,
    accessibility: status.accessibility === true,
    screenRecording: status.screenRecording === true,
    automation,
    ...(automationError === undefined ? {} : { automationError }),
    cursor: status.cursor,
    frontmostApp: status.frontmostApp,
    artifactDir:
      typeof settings.artifactDir === 'string' && settings.artifactDir.length > 0
        ? settings.artifactDir
        : '(session working directory)/.dsh-automation',
    hints,
  }
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error: string }>}
 */
async function safeCall(fn) {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

/** --- screen_capture ------------------------------------------------------ */

function captureTool(ctx, settings, artifacts) {
  return {
    name: 'screen_capture',
    description:
      'Capture the macOS screen to a PNG/JPEG/PDF artifact. action "capture" grabs a whole display, a screen region, or one window; "displays" lists monitors with bounds; "windows" lists visible windows and their ids so a window can be targeted. Needs Screen Recording permission for DeepSeek Harness (see computer_permissions). Returns the absolute file path plus pixel dimensions; open it with read_image when you need to look at it.',
    parameters: O(
      {
        action: E(['capture', 'displays', 'windows'], 'capture writes an image file; displays/windows discover targets.'),
        app: S('Restrict the window lookup or capture to this application name, e.g. "Google Chrome".'),
        cursor: B('Include the mouse cursor in the capture. Defaults to false.'),
        display: N('1-based display index from action "displays"; defaults to the main display.'),
        format: E(['png', 'jpg', 'pdf'], 'Output format; defaults to png.'),
        path: S('Optional absolute output path. Defaults to a timestamped file under the session .dsh-automation/screens directory.'),
        region: REGION,
        window: { oneOf: [{ type: 'number' }, { type: 'string' }], description: 'Window id from action "windows", or a substring of a window title.' },
      },
      'Screen capture and display/window discovery.',
      ['action'],
    ),
    output: { schema: SCHEMA_OBJECT, render: (_args, value) => renderText(value) },
    timeoutMs: 60000,
    execute: guarded(async (args, exec) => {
      const action = requireString(args.action, 'action')
      if (action === 'displays') {
        const value = await screen.displays()
        return { displays: Array.isArray(value) ? value : value?.displays ?? [] }
      }
      if (action === 'windows') {
        const value = await screen.windows({ app: typeof args.app === 'string' ? args.app : undefined })
        return { windows: Array.isArray(value) ? value : value?.windows ?? [] }
      }
      if (action === 'capture') {
        const result = await screen.capture(
          {
            display: typeof args.display === 'number' ? args.display : undefined,
            region: isRegion(args.region) ? args.region : undefined,
            window: typeof args.window === 'number' || typeof args.window === 'string' ? args.window : undefined,
            app: typeof args.app === 'string' ? args.app : undefined,
            cursor: args.cursor === true,
            format: typeof args.format === 'string' ? args.format : undefined,
            path: typeof args.path === 'string' ? args.path : undefined,
          },
          { artifacts, exec, config: settings },
        )
        return { ...result, hint: `Inspect the image with read_image on ${JSON.stringify(result.path)}.` }
      }
      throw new AutomationError(`unknown action "${action}"`, { code: 'BAD_ACTION', hint: 'Use action capture, displays or windows.' })
    }),
  }
}

/**
 * @param {unknown} value
 * @returns {value is { x: number, y: number, width: number, height: number }}
 */
function isRegion(value) {
  if (value === null || typeof value !== 'object') return false
  const region = /** @type {Record<string, unknown>} */ (value)
  return ['x', 'y', 'width', 'height'].every((key) => typeof region[key] === 'number' && Number.isFinite(region[key]))
}

/** --- screen_record ------------------------------------------------------- */

function recordTool(ctx, settings, artifacts, browser) {
  return {
    name: 'screen_record',
    description:
      'Record a video of the macOS screen or of the automation browser page. action "start" begins a recording and returns an id; "stop" finalizes it and returns the mp4 path, duration and size; "status" lists active or recent recordings. source "display" uses the system screen recorder and needs Screen Recording permission; source "browser" records the page controlled by the browser tool (no macOS permission needed) and is the best choice for automated test evidence. Artifacts are written under the session .dsh-automation/recordings directory.',
    parameters: O(
      {
        action: E(['start', 'stop', 'status', 'list'], 'start/stop/status; list is an alias of status.'),
        audio: B('Record the default microphone (display source only). Defaults to false.'),
        display: N('1-based display index to record; defaults to the main display.'),
        fps: N('Target frame rate for browser recording; defaults to 15.'),
        id: S('Recording id returned by start; stops the most recent recording when omitted.'),
        quality: N('JPEG quality 1-100 for browser recording frames; defaults to 80.'),
        region: REGION,
        showClicks: B('Draw click highlights into the recording (display source only).'),
        source: E(['display', 'browser'], 'display records the whole macOS screen; browser records the automation browser page. Defaults to display.'),
      },
      'Video recording of the screen or the automation browser page.',
      ['action'],
    ),
    output: { schema: SCHEMA_OBJECT, render: (_args, value) => renderText(value) },
    timeoutMs: 180000,
    execute: guarded(async (args, exec) => {
      const action = requireString(args.action, 'action')
      const source = typeof args.source === 'string' ? args.source : 'display'
      if (action === 'start') {
        if (source === 'browser') {
          const result = await browser.run(
            {
              action: 'record_start',
              fps: typeof args.fps === 'number' ? args.fps : undefined,
              quality: typeof args.quality === 'number' ? args.quality : undefined,
            },
            exec,
          )
          return { source, ...result }
        }
        if (source === 'display') {
          const result = await screen.startRecording(
            {
              display: typeof args.display === 'number' ? args.display : undefined,
              region: isRegion(args.region) ? args.region : undefined,
              showClicks: args.showClicks === true,
              audio: args.audio === true,
            },
            { artifacts, exec, config: settings },
          )
          return { source, ...result }
        }
        throw new AutomationError(`unknown source "${source}"`, { code: 'BAD_ACTION', hint: 'Use source display or browser.' })
      }
      if (action === 'stop') {
        const id = typeof args.id === 'string' ? args.id : undefined
        if (id !== undefined && id.startsWith('browser:')) {
          return { source: 'browser', ...(await browser.run({ action: 'record_stop' }, exec)) }
        }
        const result = await screen.stopRecording({ id })
        return { source: 'display', ...result }
      }
      if (action === 'status' || action === 'list') {
        const [display, browserStatus] = await Promise.all([
          safeCall(() => screen.recordingStatus()),
          safeCall(() => browser.run({ action: 'status' }, exec)),
        ])
        return {
          display: display.ok ? display.value : { error: display.error },
          browser: browserStatus.ok
            ? { running: browserStatus.value?.running === true, recording: browserStatus.value?.recording === true }
            : { error: browserStatus.error },
        }
      }
      throw new AutomationError(`unknown action "${action}"`, { code: 'BAD_ACTION', hint: 'Use action start, stop or status.' })
    }),
  }
}

/** --- computer_input ------------------------------------------------------ */

const INPUT_ACTIONS = [
  'move',
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'drag',
  'scroll',
  'type',
  'key',
  'hotkey',
  'cursor',
  'wait',
]

function inputTool(ctx, settings) {
  return {
    name: 'computer_input',
    description:
      'Send real mouse and keyboard input to the macOS desktop, exactly like a user: move, click, double/right/middle click, drag, scroll, type Unicode text, press named keys, and press hotkey combinations. Coordinates are global screen points with a top-left origin (the same space as screen_capture and screen_capture displays). Needs Accessibility permission for DeepSeek Harness; if a call fails with a permission error, run computer_permissions. Actions that do not need coordinates: type, key, hotkey, cursor, wait.',
    parameters: O(
      {
        action: E(INPUT_ACTIONS, 'What to do. cursor reports the pointer position; wait sleeps for ms.'),
        button: E(['left', 'right', 'middle'], 'Mouse button; defaults to left.'),
        count: N('Click count for click; 2 or 3 produce double/triple clicks. Defaults to 1.'),
        delayMs: N('Delay between typed characters. Defaults to 0.'),
        deltaX: N('Horizontal scroll amount in lines (positive scrolls right).'),
        deltaY: N('Vertical scroll amount in lines (positive scrolls down).'),
        durationMs: N('Movement or drag duration; defaults to 250ms for move and 400ms for drag.'),
        from: POINT,
        key: S('Key name for action key: return, enter, tab, escape, space, backspace, delete, arrows, home, end, pageup, pagedown, f1-f12, or a single character. Also accepts code:<virtual keycode>.'),
        keys: A(S('Key name or single character.'), 'Keys pressed together, e.g. ["cmd","shift","t"]. The last entry is the key; earlier ones may also be given in modifiers.'),
        modifiers: MODIFIERS,
        ms: N('Milliseconds to wait for action wait.'),
        steps: N('Intermediate mouse-move steps; defaults to 12.'),
        text: S('Text to type; arbitrary Unicode is supported.'),
        to: POINT,
        x: N('Global x coordinate in screen points.'),
        y: N('Global y coordinate in screen points.'),
      },
      'Desktop mouse and keyboard input.',
      ['action'],
    ),
    output: { schema: SCHEMA_OBJECT, render: (_args, value) => renderText(value) },
    timeoutMs: 60000,
    execute: guarded(async (args) => {
      const action = requireString(args.action, 'action')
      switch (action) {
        case 'move': {
          const result = await native.mouse({ action: 'move', x: needNumber(args.x, 'x'), y: needNumber(args.y, 'y'), durationMs: optionalNumber(args.durationMs), steps: optionalNumber(args.steps) })
          return { ok: true, action, ...result }
        }
        case 'click':
        case 'double_click':
        case 'right_click':
        case 'middle_click': {
          const count = action === 'double_click' ? 2 : action === 'click' ? optionalNumber(args.count) ?? 1 : 1
          const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : typeof args.button === 'string' ? args.button : 'left'
          const result = await native.mouse({ action: 'click', x: needNumber(args.x, 'x'), y: needNumber(args.y, 'y'), button, count, modifiers: optionalModifiers(args.modifiers) })
          return { ok: true, action, button, count, ...result }
        }
        case 'drag': {
          const from = needPoint(args.from, 'from')
          const to = needPoint(args.to, 'to')
          const result = await native.mouse({ action: 'drag', from, to, button: typeof args.button === 'string' ? args.button : 'left', durationMs: optionalNumber(args.durationMs) })
          return { ok: true, action, from, to, ...result }
        }
        case 'scroll': {
          const result = await native.mouse({ action: 'scroll', x: optionalNumber(args.x), y: optionalNumber(args.y), deltaX: optionalNumber(args.deltaX) ?? 0, deltaY: optionalNumber(args.deltaY) ?? 0 })
          return { ok: true, action, ...result }
        }
        case 'type': {
          const text = requireString(args.text, 'text')
          const result = await native.keyboard({ action: 'type', text, delayMs: optionalNumber(args.delayMs) })
          return { ok: true, action, chars: [...text].length, ...result }
        }
        case 'key': {
          const result = await native.keyboard({ action: 'key', key: requireString(args.key, 'key'), modifiers: optionalModifiers(args.modifiers) })
          return { ok: true, action, ...result }
        }
        case 'hotkey': {
          const keys = Array.isArray(args.keys) ? args.keys.filter((key) => typeof key === 'string') : []
          if (keys.length === 0) throw new AutomationError('hotkey needs keys, e.g. ["cmd","shift","t"]', { code: 'BAD_ARGS' })
          const result = await native.keyboard({ action: 'hotkey', keys, modifiers: optionalModifiers(args.modifiers) })
          return { ok: true, action, keys, ...result }
        }
        case 'cursor': {
          const info = await native.screenInfo()
          return { ok: true, action, cursor: info.cursor, frontmostApp: info.frontmostApp }
        }
        case 'wait': {
          const ms = optionalNumber(args.ms) ?? 500
          await sleep(Math.min(Math.max(ms, 0), 60000))
          return { ok: true, action, waitedMs: ms }
        }
        default:
          throw new AutomationError(`unknown action "${action}"`, { code: 'BAD_ACTION', hint: `Use one of: ${INPUT_ACTIONS.join(', ')}.` })
      }
    }),
  }
}

/** --- computer_app -------------------------------------------------------- */

const APP_ACTIONS = ['list', 'launch', 'activate', 'quit', 'hide', 'windows', 'frontmost', 'open', 'script']

function appTool(ctx, settings) {
  return {
    name: 'computer_app',
    description:
      'Control macOS applications. Actions: list running apps (with bundle ids and windows), launch, activate (bring to front), quit, hide, windows for one app, frontmost, open a file/URL (optionally with a specific app), and script to run AppleScript or JavaScript-for-Automation as an escape hatch for anything these actions do not cover. Launch/activate/quit/hide need no privacy permission; window titles and bounds need Accessibility; scripts that drive another app need Automation permission for that app (macOS asks on first use).',
    parameters: O(
      {
        action: E(APP_ACTIONS, 'Which application operation to perform.'),
        app: S('Application name, bundle identifier or absolute .app path, e.g. "Google Chrome" or "com.apple.Safari".'),
        args: A(S('Command-line argument.'), 'Arguments for a launched application.'),
        force: B('Force quit instead of a normal terminate. Defaults to false.'),
        language: E(['applescript', 'jxa'], 'Script language for action script; defaults to applescript.'),
        script: S('Script source for action script. In JXA, return a JSON-serializable value.'),
        target: S('File path or URL to open for action open.'),
        timeoutMs: N('Script timeout in milliseconds; defaults to 30000.'),
      },
      'macOS application control and script escape hatch.',
      ['action'],
    ),
    output: { schema: SCHEMA_OBJECT, render: (_args, value) => renderText(value) },
    timeoutMs: 120000,
    execute: guarded(async (args) => {
      const action = requireString(args.action, 'action')
      const app = typeof args.app === 'string' && args.app.trim().length > 0 ? args.app.trim() : undefined
      switch (action) {
        case 'list':
          return { apps: await apps.listApps() }
        case 'launch':
          return { ok: true, ...(await apps.open({ app, target: typeof args.target === 'string' ? args.target : undefined })) }
        case 'activate': {
          if (app === undefined) throw new AutomationError('activate needs app', { code: 'BAD_ARGS' })
          return { ok: true, ...(await apps.activate({ app })) }
        }
        case 'quit': {
          if (app === undefined) throw new AutomationError('quit needs app', { code: 'BAD_ARGS' })
          return { ok: true, ...(await apps.quit({ app, force: args.force === true })) }
        }
        case 'hide': {
          if (app === undefined) throw new AutomationError('hide needs app', { code: 'BAD_ARGS' })
          return { ok: true, ...(await apps.hide({ app })) }
        }
        case 'windows': {
          if (app === undefined) throw new AutomationError('windows needs app', { code: 'BAD_ARGS' })
          return { windows: await apps.windows({ app }) }
        }
        case 'frontmost': {
          const info = await native.screenInfo()
          return { frontmostApp: info.frontmostApp }
        }
        case 'open':
          return { ok: true, ...(await apps.open({ app, target: typeof args.target === 'string' ? args.target : undefined })) }
        case 'script': {
          const script = requireString(args.script, 'script')
          const language = typeof args.language === 'string' ? args.language : 'applescript'
          const timeoutMs = optionalNumber(args.timeoutMs) ?? 30000
          const result = await apps.appleScript({ script, language, timeoutMs })
          return { language, ...result }
        }
        default:
          throw new AutomationError(`unknown action "${action}"`, { code: 'BAD_ACTION', hint: `Use one of: ${APP_ACTIONS.join(', ')}.` })
      }
    }),
  }
}

/** --- browser ------------------------------------------------------------- */

const BROWSER_ACTIONS = [
  'launch',
  'connect',
  'close',
  'status',
  'pages',
  'new_page',
  'select_page',
  'goto',
  'back',
  'forward',
  'reload',
  'click',
  'dblclick',
  'hover',
  'fill',
  'type',
  'press',
  'select_option',
  'check',
  'uncheck',
  'scroll',
  'wait_for',
  'snapshot',
  'eval',
  'screenshot',
  'record_start',
  'record_stop',
  'console',
  'network',
  'dialog',
  'viewport',
  'download_list',
  'pdf',
]

function browserTool(ctx, settings, browser) {
  return {
    name: 'browser',
    description:
      'Automate a real Chromium browser (Chrome or Edge) through the DevTools protocol: launch or attach, navigate, inspect the page, click and type like a user, wait for conditions, read console and network activity, and capture screenshots, PDFs or video. Recommended test loop: launch → goto → snapshot (returns visible elements with CSS selectors) → click/fill/press with those selectors or text=... → wait_for → console/network → screenshot or record_start/record_stop. Selectors accept plain CSS, "text=visible label" and "xpath=...". Screenshots and videos are written under the session .dsh-automation directory and returned as absolute paths; use read_image to look at a screenshot. The browser keeps running between calls until action close.',
    parameters: O(
      {
        action: E(BROWSER_ACTIONS, 'The browser operation to perform.'),
        awaitPromise: B('For eval: wait for a returned Promise. Defaults to true.'),
        browserKind: E(['chrome', 'edge'], 'Chromium family for launch; defaults to the plugin config.'),
        button: E(['left', 'right', 'middle'], 'Mouse button for click; defaults to left.'),
        clear: B('For fill: clear the existing value first. Defaults to true.'),
        clickCount: N('Click count for click; defaults to 1.'),
        deltaX: N('Horizontal scroll delta in pixels.'),
        deltaY: N('Vertical scroll delta in pixels.'),
        expression: S('For eval: JavaScript expression evaluated in the page; the value is returned as JSON.'),
        format: E(['png', 'jpeg'], 'Image format for screenshot; defaults to png.'),
        fps: N('For record_start: target frame rate; defaults to 15.'),
        fullPage: B('For screenshot: capture the full scrollable page.'),
        headless: B('For launch: run without a window; defaults to the plugin config (headless true).'),
        key: S('For press: key name such as Enter, Tab, Escape, ArrowDown, a single character, or cmd+shift+t style combinations.'),
        limit: N('Maximum entries for console/network/download_list; defaults to 100.'),
        mobile: B('For viewport: emulate a mobile viewport.'),
        modifiers: MODIFIERS,
        networkIdle: B('For wait_for: also require no network activity for 500ms.'),
        pageId: S('Target page id from pages/status; defaults to the active page.'),
        path: S('Optional absolute output path for screenshot/pdf.'),
        policy: E(['accept', 'dismiss'], 'For dialog: how to answer JavaScript dialogs. Defaults to accept.'),
        port: N('CDP port for launch/connect; defaults to an automatically chosen free port.'),
        promptText: S('For dialog with policy accept: text for a prompt dialog.'),
        quality: N('JPEG quality 1-100 for screenshot or recording frames.'),
        selector: S('CSS selector, "text=visible label", or "xpath=expression".'),
        state: E(['visible', 'hidden', 'attached', 'detached'], 'For wait_for: state to wait for; defaults to visible.'),
        text: S('For wait_for: wait until visible page text contains this string.'),
        timeoutMs: N('Operation timeout; wait_for defaults to 10000ms.'),
        url: S('URL for goto/new_page, including data: URLs.'),
        userDataDir: S('Chrome profile directory; defaults to the plugin artifact directory.'),
        value: S('Value for fill or select_option.'),
        viewport: O({ width: N('Viewport width in CSS pixels.'), height: N('Viewport height in CSS pixels.') }, 'Initial viewport for launch.'),
        waitUntil: E(['load', 'domcontentloaded', 'networkidle'], 'For goto: navigation completion condition; defaults to load.'),
        width: N('Viewport width for action viewport.'),
        height: N('Viewport height for action viewport.'),
        x: N('Viewport x coordinate for click when no selector is given.'),
        y: N('Viewport y coordinate for click when no selector is given.'),
      },
      'Chromium browser automation over the DevTools protocol.',
      ['action'],
    ),
    output: { schema: SCHEMA_OBJECT, render: (_args, value) => renderText(value) },
    timeoutMs: 180000,
    execute: guarded(async (args, exec) => {
      const action = requireString(args.action, 'action')
      if (!BROWSER_ACTIONS.includes(action)) {
        throw new AutomationError(`unknown action "${action}"`, { code: 'BAD_ACTION', hint: `Use one of: ${BROWSER_ACTIONS.join(', ')}.` })
      }
      const params = { ...args }
      delete params.action
      return browser.run({ action, ...params }, exec)
    }),
  }
}

/** --- argument helpers ---------------------------------------------------- */

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function needNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AutomationError(`${label} must be a finite number`, { code: 'BAD_ARGS' })
  }
  return value
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function optionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {{ x: number, y: number }}
 */
function needPoint(value, label) {
  if (value === null || typeof value !== 'object') {
    throw new AutomationError(`${label} must be {x, y}`, { code: 'BAD_ARGS' })
  }
  const point = /** @type {Record<string, unknown>} */ (value)
  return { x: needNumber(point.x, `${label}.x`), y: needNumber(point.y, `${label}.y`) }
}

/**
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
function optionalModifiers(value) {
  if (!Array.isArray(value)) return undefined
  const modifiers = value.filter((entry) => typeof entry === 'string')
  return modifiers.length === 0 ? undefined : modifiers
}
