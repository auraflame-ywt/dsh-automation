// dsh-automation — application control.
//
// Thin, well-messaged wrappers over the native helper (NSWorkspace / Accessibility)
// plus `/usr/bin/open` and `/usr/bin/osascript`. Every expected failure becomes an
// AutomationError with a code and an actionable hint.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { AutomationError, asObject, errorText, run, which } from './util.mjs'
import * as native from './native.mjs'

const OPEN = '/usr/bin/open'
const OSASCRIPT = '/usr/bin/osascript'
const APPLESCRIPT_TIMEOUT_MS = 30_000

/** Errors that mean macOS blocked Apple Events / Accessibility. */
const PERMISSION_PATTERN =
  /-1743|-10004|-25211|not authoriz|not permitted|not allowed (?:assistive|to send)|permission|权限|autorisation|Berechtigung/i

const AUTOMATION_HINT =
  'Open System Settings → Privacy & Security → Automation (allow DeepSeek Harness to control the target app) and → Accessibility (enable DeepSeek Harness). Run the computer_permissions tool afterwards.'

/**
 * Running applications, including their Accessibility windows when available.
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function listApps() {
  try {
    return await native.appList()
  } catch (error) {
    throw asAutomationError(error, 'could not list applications')
  }
}

/**
 * Open a file, folder or URL (optionally with a specific app), or just launch an
 * app when only `app` is given.
 * @param {{ target?: string, app?: string }} options
 * @returns {Promise<{ ok: true, target?: string, app?: string }>}
 */
export async function open(options = {}) {
  const { target, app } = options ?? {}
  const hasApp = typeof app === 'string' && app.trim().length > 0
  const hasTarget = typeof target === 'string' && target.trim().length > 0
  if (app !== undefined && !hasApp) {
    throw new AutomationError('app must be a non-empty application name when provided', { code: 'BAD_ARGS' })
  }
  if (!hasApp && !hasTarget) {
    throw new AutomationError('open requires a target or an app', {
      code: 'BAD_ARGS',
      hint: 'Pass a URL (https://…), a file path (/Users/me/report.pdf), an app name (app: "Safari") or both to open a target with a specific app.',
    })
  }
  const resolvedTarget = hasTarget ? expandTarget(target.trim()) : undefined
  const args = hasApp && resolvedTarget !== undefined
    ? ['-a', app.trim(), resolvedTarget]
    : hasApp
      ? ['-a', app.trim()]
      : [resolvedTarget]
  const result = await run(OPEN, args, { timeoutMs: 20_000 })
  if (result.code !== 0) {
    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim()
    const what = hasApp && hasTarget
      ? `could not open '${target}' with '${app}'`
      : hasApp
        ? `could not launch '${app}'`
        : `could not open '${target}'`
    throw new AutomationError(what, {
      code: 'APP_OPEN_FAILED',
      hint: `${detail.slice(-500) || 'Check that the path/URL exists and the application is installed.'}`,
    })
  }
  return {
    ok: true,
    ...(hasTarget ? { target } : {}),
    ...(hasApp ? { app: app.trim() } : {}),
  }
}

/**
 * Expand `~` and relative paths so `open` works from the host process.
 * URLs, app names and `x-apple.systempreferences:` schemes pass through untouched.
 * @param {string} target
 * @returns {string}
 */
function expandTarget(target) {
  if (target.startsWith('~')) {
    return `${homedir()}${target.slice(1)}`
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) return target
  if (isAbsolute(target)) return target
  if (target.startsWith('./') || target.startsWith('../')) return resolve(target)
  if (existsSync(resolve(target))) return resolve(target)
  return target
}

/**
 * Bring an application to the front.
 * @param {{ app: string|number }} options
 * @returns {Promise<{ ok: boolean, app: Record<string, any> }>}
 */
export async function activate(options = {}) {
  return appAction('activate', options)
}

/**
 * Quit an application (gracefully unless force is true).
 * @param {{ app: string|number, force?: boolean }} options
 * @returns {Promise<{ ok: boolean, app: Record<string, any>, terminated?: boolean }>}
 */
export async function quit(options = {}) {
  return appAction('quit', options, { force: options?.force === true })
}

/**
 * Hide an application.
 * @param {{ app: string|number }} options
 * @returns {Promise<{ ok: boolean, app: Record<string, any> }>}
 */
export async function hide(options = {}) {
  return appAction('hide', options)
}

/**
 * Show (unhide) and activate an application.
 * @param {{ app: string|number }} options
 * @returns {Promise<{ ok: boolean, app: Record<string, any> }>}
 */
export async function show(options = {}) {
  return appAction('show', options)
}

/**
 * Accessibility windows of one application.
 * @param {{ app: string|number }} options
 * @returns {Promise<Array<{ title: string, bounds: {x:number,y:number,width:number,height:number}, minimized: boolean }>>}
 */
export async function windows(options = {}) {
  const { app } = asObject(options ?? {}, 'windows arguments')
  if (app === undefined || app === null || (typeof app !== 'string' && typeof app !== 'number')) {
    throw new AutomationError('windows requires an app name, bundle id or pid', {
      code: 'BAD_ARGS',
      hint: 'Pass app: "Safari", app: "com.apple.Safari" or app: 1234.',
    })
  }
  try {
    return await native.appWindows({ app })
  } catch (error) {
    throw asAutomationError(error, `could not read windows for '${String(app)}'`)
  }
}

/**
 * @param {'launch'|'activate'|'quit'|'hide'|'show'} action
 * @param {{ app?: string|number }} options
 * @param {Record<string, any>} [extra]
 * @returns {Promise<Record<string, any>>}
 */
async function appAction(action, options, extra = {}) {
  const { app } = asObject(options ?? {}, 'app arguments')
  if (app === undefined || app === null || (typeof app !== 'string' && typeof app !== 'number')) {
    throw new AutomationError(`${action} requires an app name, bundle id or pid`, {
      code: 'BAD_ARGS',
      hint: 'Pass app: "Safari", app: "com.apple.Safari" or app: 1234 (pid). Use listApps to see running apps.',
    })
  }
  try {
    return await native.appAction({ action, app, args: extra })
  } catch (error) {
    throw asAutomationError(error, `could not ${action} '${String(app)}'`)
  }
}

/**
 * Run AppleScript or JXA through osascript.
 * @param {{ script: string, language?: 'applescript'|'jxa', timeoutMs?: number }} options
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null }>}
 */
export async function appleScript(options = {}) {
  const { script, language } = options ?? {}
  if (typeof script !== 'string' || script.trim().length === 0) {
    throw new AutomationError('appleScript requires a non-empty script', {
      code: 'BAD_ARGS',
      hint: "Pass { script: 'tell application \"Safari\" to activate' } or use language: 'jxa' with JavaScript.",
    })
  }
  const languageName = typeof language === 'string' ? language.toLowerCase() : 'applescript'
  let args
  if (languageName === 'applescript') {
    args = ['-e', script]
  } else if (languageName === 'jxa' || languageName === 'javascript') {
    args = ['-l', 'JavaScript', '-e', script]
  } else {
    throw new AutomationError(`unsupported script language '${language}'`, {
      code: 'BAD_ARGS',
      hint: "language must be 'applescript' (default) or 'jxa'.",
    })
  }
  const requestedTimeout = Number(options?.timeoutMs)
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(Math.max(Math.round(requestedTimeout), 1_000), 600_000)
    : APPLESCRIPT_TIMEOUT_MS
  const result = await run(OSASCRIPT, args, { timeoutMs })
  if (result.timedOut) {
    throw new AutomationError('the AppleScript timed out', {
      code: 'APPLESCRIPT_TIMEOUT',
      hint: `The script ran longer than ${Math.round(timeoutMs / 1000)}s. A permission dialog may be waiting for approval. ${AUTOMATION_HINT}`,
    })
  }
  const stderr = result.stderr ?? ''
  const stdout = result.stdout ?? ''
  if (result.code !== 0) {
    const detail = `${stderr}\n${stdout}`.trim()
    if (PERMISSION_PATTERN.test(detail)) {
      throw new AutomationError(
        'macOS blocked the AppleScript (Automation/Accessibility permission)',
        { code: 'AUTOMATION_PERMISSION', hint: `${AUTOMATION_HINT}\nDetails: ${detail.slice(-500)}` },
      )
    }
    if (/-10810|-609|-600/.test(detail)) {
      throw new AutomationError('the target application is not running or not scriptable', {
        code: 'APPLESCRIPT_TARGET_UNAVAILABLE',
        hint: `Launch the target app first (apps open), then retry. Details: ${detail.slice(-500)}`,
      })
    }
    // Non-permission script errors are returned so the model can fix the script.
    return { stdout, stderr, code: result.code }
  }
  return { stdout, stderr, code: result.code }
}

/**
 * Surface native helper failures with context while keeping the original code/hint.
 * @param {unknown} error
 * @param {string} what
 * @returns {Error}
 */
function asAutomationError(error, what) {
  if (error instanceof AutomationError) {
    if (error.code === 'NATIVE_HELPER_UNAVAILABLE' || error.code === 'NATIVE_HELPER_COMPILE_FAILED') {
      return new AutomationError(`${what}: the native macOS helper is unavailable`, {
        code: 'NATIVE_HELPER_UNAVAILABLE',
        hint: `${errorText(error)}\nInstall the Xcode Command Line Tools with \`xcode-select --install\` and retry.`,
      })
    }
    return error
  }
  return new AutomationError(`${what}: ${errorText(error)}`, { code: 'APP_CONTROL_FAILED' })
}

/** @internal exposes absolute tool paths for tests/reporting. */
export function toolPaths() {
  return {
    open: existsSync(OPEN) ? OPEN : null,
    osascript: existsSync(OSASCRIPT) ? OSASCRIPT : null,
    ffmpeg: which('ffmpeg'),
    screencapture: existsSync('/usr/sbin/screencapture') ? '/usr/sbin/screencapture' : null,
  }
}
