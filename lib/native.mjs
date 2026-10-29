// dsh-automation — native macOS automation layer.
//
// Wraps the compiled Swift helper `lib/native-helper.swift`. The helper is built
// once per source hash with `swiftc` into a cache directory, then invoked over a
// tiny JSON protocol:
//
//   execFile(binary, [command, JSON.stringify(args)])
//
// The helper prints exactly one JSON object on stdout. On failure it prints
// `{"error": "...", "code": "..."}` and exits non-zero. All failures are mapped
// to AutomationError with an actionable hint.
//
// Everything here is best-effort when the compiler is missing: keyboard input and
// mouse clicks fall back to `osascript` System Events (with an explicit hint that
// Accessibility permission is required). Screen capture does not depend on this
// module at all — see lib/screen.mjs.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AutomationError, errorText, parseJson, run, which } from './util.mjs'

const HELPER_SOURCE = fileURLToPath(new URL('./native-helper.swift', import.meta.url))
const DEFAULT_COMPILE_TIMEOUT_MS = 180_000
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000
const SCREENSHOT_HINT =
  'Grant Screen Recording in System Settings → Privacy & Security → Screen Recording to DeepSeek Harness, then restart DeepSeek Harness.'
const ACCESSIBILITY_HINT =
  'Grant Accessibility in System Settings → Privacy & Security → Accessibility to DeepSeek Harness, then run the computer_permissions tool.'

/** @type {{ cacheDir: string | null, timeoutMs: number, binary: string | null, hash: string | null, build: Promise<string> | null, swiftc: string | null | undefined }} */
const state = {
  cacheDir: null,
  timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  binary: null,
  hash: null,
  build: null,
  swiftc: undefined,
}

const VALID_PERMISSION_KINDS = new Set(['screen-recording', 'accessibility'])
const SETTINGS_URLS = {
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
}

// Virtual key codes used by the AppleScript fallback (US layout, same as helper).
const KEY_CODES = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
  b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, '=': 24, 9: 25, 7: 26, '-': 27, 8: 28, 0: 29,
  ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, return: 36, enter: 36, l: 37, j: 38,
  "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47,
  tab: 48, space: 49, spacebar: 49, '`': 50, backspace: 51, delete: 51, escape: 53, esc: 53,
  'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97, 'f7': 98, 'f8': 100,
  'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111, 'f13': 105, 'f14': 107, 'f15': 113,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, arrowleft: 123, right: 124, arrowright: 124, down: 125, arrowdown: 125,
  up: 126, arrowup: 126, forwarddelete: 117, deleteforward: 117, del: 117,
}
const MODIFIER_ALIASES = {
  cmd: 'command down',
  command: 'command down',
  meta: 'command down',
  super: 'command down',
  ctrl: 'control down',
  control: 'control down',
  alt: 'option down',
  option: 'option down',
  opt: 'option down',
  shift: 'shift down',
}

/**
 * Resolve and remember the helper cache directory. Called by ensureHelper and by
 * the screen/apps modules so all of them share one compiled binary.
 * @param {{ cacheDir?: string, timeoutMs?: number }} [options]
 */
export function configure(options = {}) {
  if (typeof options.cacheDir === 'string' && options.cacheDir.trim().length > 0) {
    state.cacheDir = resolve(options.cacheDir.trim())
  }
  if (typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    state.timeoutMs = Math.round(options.timeoutMs)
  }
  return { cacheDir: state.cacheDir, timeoutMs: state.timeoutMs }
}

/**
 * Absolute path to the Swift helper sources.
 * @returns {string}
 */
export function helperSourcePath() {
  return HELPER_SOURCE
}

/**
 * @returns {string}
 */
function cacheDir() {
  if (state.cacheDir !== null) return state.cacheDir
  const configured = process.env.DSH_AUTOMATION_HELPER_CACHE
  const dir = configured !== undefined && configured.trim().length > 0
    ? resolve(configured.trim())
    : join(tmpdir(), 'dsh-automation-native')
  state.cacheDir = dir
  return dir
}

/**
 * Compile the Swift helper once per source hash and return its absolute path.
 * Idempotent: concurrent and repeated calls share one build.
 * @param {{ cacheDir?: string, timeoutMs?: number }} [options]
 * @returns {Promise<string>}
 */
export async function ensureHelper(options = {}) {
  configure(options)
  if (process.env.DSH_AUTOMATION_DISABLE_NATIVE === '1') {
    throw new AutomationError('the native macOS helper is disabled (DSH_AUTOMATION_DISABLE_NATIVE=1)', {
      code: 'NATIVE_HELPER_UNAVAILABLE',
      hint: 'Unset DSH_AUTOMATION_DISABLE_NATIVE to use the Swift helper. Without it, keyboard input and clicks fall back to AppleScript; screen capture still works.',
    })
  }
  if (state.binary !== null && existsSync(state.binary)) return state.binary
  if (state.build !== null) return state.build
  state.build = buildHelper().finally(() => {
    state.build = null
  })
  return state.build
}

/**
 * @returns {Promise<string>}
 */
async function buildHelper() {
  const dir = cacheDir()
  let source
  try {
    source = readFileSync(HELPER_SOURCE)
  } catch (error) {
    throw new AutomationError(
      `could not read the native helper source at ${HELPER_SOURCE}`,
      { code: 'NATIVE_HELPER_MISSING', hint: 'The plugin bundle is incomplete; reinstall dsh-automation.', cause: error },
    )
  }
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 8)
  const target = join(dir, `native-helper-${hash}`)
  state.hash = hash
  if (existsSync(target)) {
    try {
      if (statSync(target).size > 0) {
        state.binary = target
        return target
      }
    } catch {
      // fall through and rebuild
    }
  }

  const swiftc = resolveSwiftc()
  if (swiftc === null) {
    throw new AutomationError(
      'the Swift compiler (swiftc) is not available, so the native macOS helper cannot be built',
      {
        code: 'NATIVE_HELPER_UNAVAILABLE',
        hint: 'Install the Xcode Command Line Tools with `xcode-select --install`, then retry. Keyboard input and clicks fall back to AppleScript without it; screen capture still works.',
      },
    )
  }

  try {
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, 'module-cache'), { recursive: true })
  } catch (error) {
    throw new AutomationError(
      `could not create the native helper cache directory ${dir}`,
      { code: 'NATIVE_HELPER_CACHE_FAILED', hint: 'Set config.helperCacheDir to a writable directory.', cause: error },
    )
  }

  const result = await run(
    swiftc,
    ['-O', '-module-cache-path', join(dir, 'module-cache'), '-o', target, HELPER_SOURCE],
    { timeoutMs: DEFAULT_COMPILE_TIMEOUT_MS },
  )
  if (result.timedOut) {
    throw new AutomationError(
      `compiling the native helper timed out after ${Math.round(DEFAULT_COMPILE_TIMEOUT_MS / 1000)}s`,
      { code: 'NATIVE_HELPER_COMPILE_TIMEOUT', hint: 'Check that Xcode Command Line Tools are healthy (`xcode-select --install`) and retry.' },
    )
  }
  if (result.code !== 0 || !existsSync(target)) {
    const detail = (result.stderr || result.stdout || errorText(result)).trim().slice(-1500)
    throw new AutomationError(
      `failed to compile the native macOS helper with swiftc (exit ${result.code ?? 'signal'})`,
      {
        code: 'NATIVE_HELPER_COMPILE_FAILED',
        hint: `Install/repair Xcode Command Line Tools with \`xcode-select --install\`.\nswiftc: ${swiftc}\nsource: ${HELPER_SOURCE}\ndetail: ${detail}`,
      },
    )
  }
  state.binary = target
  return target
}

/**
 * @returns {string | null}
 */
function resolveSwiftc() {
  if (state.swiftc !== undefined) return state.swiftc
  state.swiftc = which('swiftc') ?? (existsSync('/usr/bin/swiftc') ? '/usr/bin/swiftc' : null)
  return state.swiftc
}

/**
 * Run one helper command and parse its JSON response.
 * @param {string} command
 * @param {Record<string, unknown>} [args]
 * @returns {Promise<Record<string, any>>}
 */
async function callHelper(command, args = {}) {
  const binary = await ensureHelper()
  const timeoutMs = state.timeoutMs
  const result = await run(binary, [command, JSON.stringify(args ?? {})], { timeoutMs })
  if (result.timedOut) {
    throw new AutomationError(
      `the native helper did not answer '${command}' within ${Math.round(timeoutMs / 1000)}s`,
      { code: 'NATIVE_HELPER_TIMEOUT', hint: 'The system may be busy or showing a permission dialog. Retry, or raise config.commandTimeoutMs.' },
    )
  }
  const stdout = result.stdout.trim()
  const parsed = stdout.length > 0 ? parseJson(stdout) : undefined
  if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const detail = (result.stderr || stdout || `exit ${result.code}`).trim().slice(-800)
    throw new AutomationError(
      `the native helper returned an unreadable response for '${command}'`,
      {
        code: 'NATIVE_HELPER_PROTOCOL',
        hint: `This is a bug or a build mismatch; delete the helper cache (${cacheDir()}) and retry. Detail: ${detail}`,
      },
    )
  }
  if (typeof parsed.error === 'string') {
    throw helperError(parsed)
  }
  if (result.code !== 0) {
    throw new AutomationError(
      `the native helper failed '${command}' with exit code ${result.code ?? 'signal'}`,
      { code: 'NATIVE_HELPER_FAILED', hint: (result.stderr ?? '').trim().slice(-600) || undefined },
    )
  }
  return parsed
}

/**
 * Turn a helper `{error, code, hint}` payload into an AutomationError.
 * @param {{ error: string, code?: string, hint?: string }} payload
 * @returns {AutomationError}
 */
function helperError(payload) {
  const rawCode = typeof payload.code === 'string' ? payload.code : 'NATIVE_HELPER_ERROR'
  let code = rawCode
  let hint = typeof payload.hint === 'string' && payload.hint.length > 0 ? payload.hint : undefined
  switch (rawCode) {
    case 'BAD_ARGS':
      hint ??= 'The native helper rejected the arguments. Check numeric coordinates (x/y/from/to), key names, modifier names and required text.'
      break
    case 'UNSUPPORTED_ACTION':
      hint ??= 'For app actions use launch, activate, quit, hide or show. Mouse actions: move, click, drag, scroll.'
      break
    case 'INPUT_FAILED':
      hint ??= `${ACCESSIBILITY_HINT} If it persists, retry the action.`
      break
    case 'WINDOW_LIST_FAILED':
      hint ??= 'The window server did not return windows. Retry; if it persists, restart DeepSeek Harness.'
      break
    case 'PERMISSION_ACCESSIBILITY':
      code = 'ACCESSIBILITY_PERMISSION'
      hint ??= ACCESSIBILITY_HINT
      break
    case 'PERMISSION_SCREEN_RECORDING':
      code = 'SCREEN_RECORDING_PERMISSION'
      hint ??= SCREENSHOT_HINT
      break
    case 'INPUT_NOT_DELIVERED':
      hint ??= ACCESSIBILITY_HINT
      break
    case 'APP_NOT_FOUND':
      hint ??= 'Run the apps tool with action=apps_list to see running applications, or launch it first.'
      break
    case 'UNSUPPORTED_KEY':
      hint ??= 'Use a letter, digit, F1-F12, return, tab, escape, backspace, space, arrows, home, end, pageup, pagedown. For text use action=type.'
      break
    case 'UNKNOWN_COMMAND':
      hint ??= 'The compiled helper is older than lib/native.mjs. Delete the helper cache directory (`helperStatus().cacheDir`) and retry.'
      break
    default:
      break
  }
  hint ??= 'Check the tool arguments and retry. If this looks like a macOS permission problem, run the computer_permissions tool.'
  return new AutomationError(payload.error, { code, hint })
}

/**
 * Ask osascript to perform System Events input; used only when swiftc is missing.
 * @param {string[]} scriptLines
 * @returns {Promise<{elapsedMs: number}>}
 */
async function runSystemEvents(scriptLines) {
  const result = await run('/usr/bin/osascript', scriptLines.flatMap((line) => ['-e', line]), { timeoutMs: 20_000 })
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    if (/-(1743|10004)|not authorized|not permitted|not allowed assistive access|permission/i.test(detail)) {
      throw new AutomationError(
        'macOS blocked the AppleScript fallback because automation/accessibility permission is missing',
        { code: 'ACCESSIBILITY_PERMISSION', hint: `${ACCESSIBILITY_HINT}\nAlso allow DeepSeek Harness under Privacy & Security → Automation (System Events).` },
      )
    }
    throw new AutomationError('the AppleScript fallback failed', {
      code: 'APPLESCRIPT_FALLBACK_FAILED',
      hint: detail.slice(-600) || 'Install Xcode Command Line Tools to enable the native helper.',
    })
  }
  return { elapsedMs: 0 }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function appleScriptString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * @param {unknown[]} modifiers
 * @returns {string | null}
 */
function appleScriptModifiers(modifiers) {
  const raw = Array.isArray(modifiers) ? modifiers : []
  const translated = []
  for (const modifier of raw) {
    const key = String(modifier).toLowerCase()
    const mapped = MODIFIER_ALIASES[key]
    if (mapped === undefined) return null
    if (!translated.includes(mapped)) translated.push(mapped)
  }
  return translated.length > 0 ? ` using {${translated.join(', ')}}` : ''
}

/**
 * @param {unknown} key
 * @returns {number | null}
 */
function keyCodeFor(key) {
  if (typeof key !== 'string' || key.length === 0) return null
  const lower = key.toLowerCase()
  if (Object.hasOwn(KEY_CODES, lower)) return KEY_CODES[lower]
  if (lower.startsWith('code:')) {
    const value = Number(lower.slice(5))
    if (Number.isInteger(value) && value >= 0 && value <= 127) return value
  }
  return null
}

/**
 * @param {string} command
 * @param {Record<string, unknown>} args
 * @param {() => Promise<Record<string, any>>} fallback
 * @returns {Promise<Record<string, any>>}
 */
async function callWithFallback(command, args, fallback) {
  try {
    return await callHelper(command, args)
  } catch (error) {
    if (error instanceof AutomationError && error.code === 'NATIVE_HELPER_UNAVAILABLE') {
      return fallback()
    }
    throw error
  }
}

// MARK: - Permissions

/**
 * Current TCC permission state for the helper process.
 * @returns {Promise<{ accessibility: boolean, screenRecording: boolean, platform: string, helperPath?: string, arch?: string, osVersion?: string }>}
 */
export async function permissions() {
  const helperPath = await ensureHelper()
  const payload = await callHelper('permissions')
  return {
    accessibility: payload.accessibility === true,
    screenRecording: payload.screenRecording === true,
    platform: typeof payload.platform === 'string' ? payload.platform : 'macos',
    helperPath,
    ...(typeof payload.arch === 'string' ? { arch: payload.arch } : {}),
    ...(typeof payload.osVersion === 'string' ? { osVersion: payload.osVersion } : {}),
    ...(payload.cursor !== undefined ? { cursor: payload.cursor } : {}),
    ...(payload.frontmostApp !== undefined ? { frontmostApp: payload.frontmostApp } : {}),
  }
}

/**
 * Ask macOS to prompt for one permission (or report it as already granted).
 * @param {'screen-recording' | 'accessibility'} kind
 * @returns {Promise<{ granted: boolean, prompted: boolean }>}
 */
export async function requestPermission(kind) {
  if (!VALID_PERMISSION_KINDS.has(kind)) {
    throw new AutomationError(`unknown permission kind '${String(kind)}'`, {
      code: 'BAD_ARGS',
      hint: "kind must be 'screen-recording' or 'accessibility'.",
    })
  }
  await ensureHelper()
  const command = kind === 'screen-recording' ? 'request-screen' : 'request-accessibility'
  const payload = await callHelper(command)
  return { granted: payload.granted === true, prompted: payload.prompted === true }
}

/**
 * Open the matching System Settings privacy pane.
 * @param {'screen-recording' | 'accessibility' | 'automation' | 'microphone'} kind
 * @returns {Promise<{ opened: true, url: string }>}
 */
export async function openSettings(kind) {
  const url = SETTINGS_URLS[kind]
  if (url === undefined) {
    throw new AutomationError(`unknown settings pane '${String(kind)}'`, {
      code: 'BAD_ARGS',
      hint: `kind must be one of: ${Object.keys(SETTINGS_URLS).join(', ')}.`,
    })
  }
  const result = await run('/usr/bin/open', [url], { timeoutMs: 15_000 })
  if (result.code !== 0) {
    throw new AutomationError('could not open System Settings', {
      code: 'SETTINGS_OPEN_FAILED',
      hint: `Run \`open "${url}"\` manually. ${(result.stderr || '').trim()}`.trim(),
    })
  }
  return { opened: true, url }
}

// MARK: - Screen / apps / windows info

/**
 * Displays, cursor position and frontmost application.
 * @returns {Promise<Record<string, any>>}
 */
export async function screenInfo() {
  const payload = await callHelper('displays')
  const displays = Array.isArray(payload.displays) ? payload.displays : []
  const cursor = payload.cursor ?? { x: 0, y: 0 }
  const frontmostApp = payload.frontmostApp ?? { name: '', bundleId: '', pid: 0 }
  return { displays, cursor, frontmostApp }
}

/**
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function appList() {
  const payload = await callHelper('apps')
  return Array.isArray(payload.apps) ? payload.apps : []
}

/**
 * @param {{ app?: string | number }} [options]
 * @returns {Promise<{ windows: Array<Record<string, any>>, screenRecording: boolean }>}
 */
export async function windowList(options = {}) {
  const payload = await callHelper('windows', options?.app === undefined ? {} : { app: String(options.app) })
  return {
    windows: Array.isArray(payload.windows) ? payload.windows : [],
    screenRecording: payload.screenRecording === true,
  }
}

/**
 * Launch/activate/quit/hide/show an application.
 * @param {{ action: string, app: string | number, args?: Record<string, unknown> }} options
 * @returns {Promise<Record<string, any>>}
 */
export async function appAction(options = {}) {
  const { action, app, args } = options ?? {}
  const valid = new Set(['launch', 'activate', 'quit', 'hide', 'show'])
  if (!valid.has(action)) {
    throw new AutomationError(`unknown app action '${String(action)}'`, {
      code: 'BAD_ARGS',
      hint: `action must be one of: ${[...valid].join(', ')}.`,
    })
  }
  if (app === undefined || app === null || (typeof app !== 'string' && typeof app !== 'number')) {
    throw new AutomationError('appAction requires an app name, bundle id or pid', {
      code: 'BAD_ARGS',
      hint: 'Pass app: "Safari", app: "com.apple.Safari" or app: 1234 (pid).',
    })
  }
  return callHelper('app-action', { action, app, args: args ?? {} })
}

/**
 * Accessibility windows for one running app.
 * @param {{ app?: string | number }} [options]
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function appWindows(options = {}) {
  if (options?.app === undefined || options.app === null) {
    throw new AutomationError('appWindows requires an app name, bundle id or pid', {
      code: 'BAD_ARGS',
      hint: 'Pass app: "Safari" or app: "com.apple.Safari".',
    })
  }
  const payload = await callHelper('app-windows', { app: options.app })
  return Array.isArray(payload.windows) ? payload.windows : []
}

/**
 * @returns {Promise<boolean>}
 */
export async function axTrusted() {
  try {
    const payload = await callHelper('permissions')
    return payload.accessibility === true
  } catch {
    return false
  }
}

// MARK: - Mouse

/**
 * Mouse actions. Coordinates are global screen points (top-left origin).
 * Scroll deltas are in lines; positive deltaY scrolls down and positive deltaX
 * scrolls right (the same convention as the model-facing tool schema).
 * @param {{ action: 'move'|'click'|'drag'|'scroll', x?: number, y?: number,
 *   from?: {x:number,y:number}, to?: {x:number,y:number}, button?: string,
 *   count?: number, deltaX?: number, deltaY?: number, durationMs?: number,
 *   steps?: number, modifiers?: string[] }} options
 * @returns {Promise<Record<string, any>>}
 */
export async function mouse(options = {}) {
  const { action } = options ?? {}
  switch (action) {
    case 'move':
      return callWithFallback('move', pick(options, ['x', 'y', 'durationMs', 'steps']), () => {
        throw new AutomationError('mouse move requires the native helper (swiftc)', {
          code: 'NATIVE_HELPER_UNAVAILABLE',
          hint: 'Install the Xcode Command Line Tools with `xcode-select --install`. The AppleScript fallback supports only clicks and keyboard input, not pointer movement or scrolling.',
        })
      })
    case 'click': {
      const args = pick(options, ['x', 'y', 'button', 'count', 'modifiers', 'durationMs'])
      const result = await callWithFallback('click', args, () => fallbackClick(options))
      if (result?.backend === undefined) result.backend = 'cgevent'
      return result
    }
    case 'drag': {
      const args = pick(options, ['from', 'to', 'button', 'modifiers', 'durationMs', 'steps'])
      if (args.from === undefined && options.x !== undefined && options.y !== undefined) {
        args.from = { x: options.x, y: options.y }
      }
      return callWithFallback('drag', args, () => {
        throw new AutomationError('mouse drag requires the native helper (swiftc)', {
          code: 'NATIVE_HELPER_UNAVAILABLE',
          hint: 'Install the Xcode Command Line Tools with `xcode-select --install`. The AppleScript fallback supports only clicks and keyboard input.',
        })
      })
    }
    case 'scroll':
      return callWithFallback('scroll', pick(options, ['x', 'y', 'deltaX', 'deltaY', 'steps']), () => {
        throw new AutomationError('mouse scroll requires the native helper (swiftc)', {
          code: 'NATIVE_HELPER_UNAVAILABLE',
          hint: 'Install the Xcode Command Line Tools with `xcode-select --install`. The AppleScript fallback supports only clicks and keyboard input.',
        })
      })
    default:
      throw new AutomationError(`unknown mouse action '${String(action)}'`, {
        code: 'BAD_ARGS',
        hint: "action must be one of: move, click, drag, scroll. Use keyboard for keys/text.",
      })
  }
}

/**
 * Convenience click used by other modules and tests.
 * @param {{ x: number, y: number, button?: string, count?: number, modifiers?: string[] }} options
 * @returns {Promise<Record<string, any>>}
 */
export async function clickAt(options = {}) {
  return mouse({ action: 'click', ...options })
}

// MARK: - Keyboard

/**
 * Keyboard actions. `type` types arbitrary Unicode, independent of layout.
 * @param {{ action: 'key'|'hotkey'|'type', key?: string, keys?: string[],
 *   text?: string, modifiers?: string[], delayMs?: number }} options
 * @returns {Promise<Record<string, any>>}
 */
export async function keyboard(options = {}) {
  const { action } = options ?? {}
  if (action === 'key') {
    return keyboardWithFallback('key', {
      key: options.key,
      modifiers: options.modifiers,
      delayMs: options.delayMs,
    }, () => fallbackKey(options))
  }
  if (action === 'hotkey') {
    const parsed = parseHotkey(options.keys, options.modifiers)
    return keyboardWithFallback('key', {
      key: parsed.key,
      modifiers: parsed.modifiers,
      delayMs: options.delayMs,
    }, () => fallbackHotkey(parsed))
  }
  if (action === 'type') {
    if (typeof options.text !== 'string' || options.text.length === 0) {
      throw new AutomationError('keyboard type requires a non-empty text string', {
        code: 'BAD_ARGS',
        hint: "Pass { action: 'type', text: 'hello' }.",
      })
    }
    return keyboardWithFallback('type', { text: options.text, delayMs: options.delayMs }, () => fallbackType(options.text))
  }
  throw new AutomationError(`unknown keyboard action '${String(action)}'`, {
    code: 'BAD_ARGS',
    hint: "action must be one of: key, hotkey, type. Use mouse for pointer input.",
  })
}

/**
 * @param {string} command
 * @param {Record<string, unknown>} args
 * @param {() => Promise<Record<string, any>>} fallback
 * @returns {Promise<Record<string, any>>}
 */
async function keyboardWithFallback(command, args, fallback) {
  const cleaned = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
  const result = await callWithFallback(command, cleaned, fallback)
  if (result?.backend === undefined) result.backend = 'cgevent'
  return result
}

/**
 * @param {unknown} keys keys array; the last entry is the key, earlier entries are modifiers
 * @param {unknown} [explicitModifiers] extra modifier names from a separate modifiers field
 * @returns {{ key: string, modifiers: string[] }}
 */
function parseHotkey(keys, explicitModifiers) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new AutomationError('hotkey requires a non-empty keys array', {
      code: 'BAD_ARGS',
      hint: 'Example: { action: "hotkey", keys: ["cmd", "shift", "t"] }. Put modifiers first and the final key last.',
    })
  }
  const list = keys.map((key) => String(key))
  const key = list[list.length - 1]
  const fromKeys = list.slice(0, -1)
  const extra = Array.isArray(explicitModifiers) ? explicitModifiers.map((modifier) => String(modifier)) : []
  const modifiers = []
  for (const modifier of [...fromKeys, ...extra]) {
    if (MODIFIER_ALIASES[modifier.toLowerCase()] === undefined) {
      throw new AutomationError(`'${modifier}' is not a modifier`, {
        code: 'BAD_ARGS',
        hint: 'Modifiers must be cmd/command, ctrl/control, alt/option or shift. The last entry in keys is the key to press.',
      })
    }
    if (!modifiers.some((existing) => existing.toLowerCase() === modifier.toLowerCase())) modifiers.push(modifier)
  }
  if (keyCodeFor(key) === null && key.length !== 1) {
    throw new AutomationError(`unsupported hotkey key '${key}'`, {
      code: 'UNSUPPORTED_KEY',
      hint: 'Use a letter, digit, F1-F12, return, tab, escape, space, arrows, home, end, pageup or pagedown.',
    })
  }
  return { key, modifiers }
}

/**
 * Click at global coordinates through System Events (left button only).
 * @param {{ x?: number, y?: number, button?: string, count?: number, modifiers?: string[] }} options
 */
async function fallbackClick(options) {
  if (typeof options.x !== 'number' || !Number.isFinite(options.x) || typeof options.y !== 'number' || !Number.isFinite(options.y)) {
    throw new AutomationError('click requires numeric x and y coordinates', {
      code: 'BAD_ARGS',
      hint: 'Pass { action: "click", x: 100, y: 200 }.',
    })
  }
  if (Array.isArray(options.modifiers) && options.modifiers.length > 0) {
    throw new AutomationError('modifier-clicks need the native helper', {
      code: 'FALLBACK_UNSUPPORTED',
      hint: 'Install the Xcode Command Line Tools (`xcode-select --install`) to click with cmd/ctrl/alt/shift. The AppleScript fallback supports plain left clicks only.',
    })
  }
  if (options.button !== undefined && String(options.button).toLowerCase() !== 'left') {
    throw new AutomationError(`${String(options.button)}-clicks need the native helper`, {
      code: 'FALLBACK_UNSUPPORTED',
      hint: 'Install the Xcode Command Line Tools (`xcode-select --install`). The AppleScript fallback supports plain left clicks only.',
    })
  }
  const count = Math.max(1, Math.min(3, Math.round(Number(options.count ?? 1))))
  const lines = ['tell application "System Events"']
  for (let index = 0; index < count; index += 1) {
    lines.push(`click at {${Math.round(options.x)}, ${Math.round(options.y)}}`)
  }
  lines.push('end tell')
  await runSystemEvents(lines)
  return {
    ok: true,
    action: 'click',
    x: options.x,
    y: options.y,
    count,
    backend: 'applescript',
    hint: 'The native helper is unavailable (swiftc missing); AppleScript fallback used. Accessibility and Automation permission are required.',
  }
}

/**
 * @param {{ key?: string, modifiers?: string[] }} options
 */
async function fallbackKey(options) {
  const key = typeof options.key === 'string' ? options.key : ''
  const modifiers = appleScriptModifiers(options.modifiers ?? [])
  if (modifiers === null) {
    throw new AutomationError('unsupported modifier for the AppleScript fallback', { code: 'BAD_ARGS' })
  }
  const code = keyCodeFor(key)
  const lines = code === null
    ? [`tell application "System Events" to keystroke ${appleScriptString(key.length === 1 ? key : key)}${modifiers}`]
    : [`tell application "System Events" to key code ${code}${modifiers}`]
  await runSystemEvents(lines)
  return {
    ok: true,
    action: 'key',
    key,
    backend: 'applescript',
    hint: 'The native helper is unavailable (swiftc missing); AppleScript fallback used. Accessibility and Automation permission are required.',
  }
}

/**
 * @param {{ key: string, modifiers: string[] }} parsed
 */
async function fallbackHotkey(parsed) {
  const modifiers = appleScriptModifiers(parsed.modifiers ?? [])
  if (modifiers === null) {
    throw new AutomationError('unsupported modifier for the AppleScript fallback', { code: 'BAD_ARGS' })
  }
  const code = keyCodeFor(parsed.key)
  const line = code === null
    ? `tell application "System Events" to keystroke ${appleScriptString(parsed.key)}${modifiers}`
    : `tell application "System Events" to key code ${code}${modifiers}`
  await runSystemEvents([line])
  return {
    ok: true,
    action: 'hotkey',
    keys: [...parsed.modifiers, parsed.key],
    backend: 'applescript',
    hint: 'The native helper is unavailable (swiftc missing); AppleScript fallback used. Accessibility and Automation permission are required.',
  }
}

/**
 * @param {string} text
 */
async function fallbackType(text) {
  const lines = ['tell application "System Events"']
  for (const line of text.split('\n')) {
    if (line.length > 0) lines.push(`keystroke ${appleScriptString(line)}`)
    lines.push('key code 36')
  }
  lines.pop()
  lines.push('end tell')
  await runSystemEvents(lines)
  return {
    ok: true,
    action: 'type',
    typed: text.length,
    backend: 'applescript',
    hint: 'The native helper is unavailable (swiftc missing); AppleScript fallback used. Accessibility and Automation permission are required. Long or non-BMP text may be truncated.',
  }
}

/**
 * Copy the listed keys from an options bag, dropping undefined values.
 * @param {Record<string, any>} source
 * @param {string[]} keys
 * @returns {Record<string, unknown>}
 */
function pick(source, keys) {
  const result = {}
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key]
  }
  return result
}

/**
 * Test hook: forget the cached helper path. Not part of the public tool surface.
 * @returns {void}
 */
export function resetHelperCache() {
  state.binary = null
  state.build = null
  state.hash = null
  state.swiftc = undefined
}

/** @internal used by test/native-selftest.mjs to assert compile reuse. */
export function helperStatus() {
  return {
    binary: state.binary,
    hash: state.hash,
    cacheDir: cacheDir(),
    timeoutMs: state.timeoutMs,
    swiftc: resolveSwiftc(),
  }
}
