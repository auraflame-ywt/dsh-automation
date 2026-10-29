// Shared helpers for the automation suite. Pure Node, no harness imports.
import { spawn } from 'node:child_process'
import { existsSync, accessSync, constants } from 'node:fs'
import { dirname } from 'node:path'

/** Error carrying a machine-readable code and a user-actionable hint. */
export class AutomationError extends Error {
  /**
   * @param {string} message human readable failure
   * @param {{ code?: string, hint?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AutomationError'
    if (options.code !== undefined) this.code = options.code
    if (options.hint !== undefined) this.hint = options.hint
  }
}

/**
 * Collapse a caught value into one message, appending the hint when present.
 * @param {unknown} error
 * @returns {string}
 */
export function errorText(error) {
  if (error instanceof AutomationError) {
    return error.hint === undefined ? error.message : `${error.message}\n${error.hint}`
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Render helper: one text block with JSON for structured values.
 * @param {unknown} value
 * @returns {Array<{ type: 'text', text: string }>}
 */
export function renderText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/**
 * Run one child process and capture its output. Never throws on a non-zero
 * exit; the caller decides what a failure means.
 * @param {string} command absolute path or PATH name
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string>, timeoutMs?: number,
 *   input?: string, signal?: AbortSignal, maxBuffer?: number }} [options]
 * @returns {Promise<{ code: number | null, signal: string | null, stdout: string,
 *   stderr: string, timedOut: boolean, skipped: boolean }>}
 */
export function run(command, args = [], options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 30000,
    input,
    signal,
    maxBuffer = 8 * 1024 * 1024,
  } = options
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let skipped = false
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...(env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: null, signal: null, stdout, stderr: errorText(error), timedOut: false, skipped: false })
      return
    }
    const finish = (code, signalName) => {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve({ code, signal: signalName, stdout, stderr, timedOut, skipped })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, Math.max(1, timeoutMs))
    const onAbort = () => {
      skipped = true
      child.kill('SIGKILL')
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString()
    })
    child.on('error', (error) => {
      stderr += String(error?.message ?? error)
      finish(null, null)
    })
    child.on('close', (code, signalName) => finish(code, signalName))
    if (input !== undefined) child.stdin?.end(input)
  })
}

/**
 * Locate an executable in PATH plus a few well-known macOS locations.
 * @param {string} name
 * @returns {string | null}
 */
export function which(name) {
  if (name.includes('/')) return isExecutable(name) ? name : null
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
  const seen = new Set()
  for (const dir of [...(process.env.PATH ?? '').split(':'), ...extra]) {
    if (dir === '' || seen.has(dir)) continue
    seen.add(dir)
    const candidate = `${dir}/${name}`
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isExecutable(path) {
  try {
    if (!existsSync(path)) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * A filesystem-safe timestamp such as `20261028-165512-318`.
 * @returns {string}
 */
export function stamp() {
  const now = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-` +
    pad(now.getMilliseconds(), 3)
  )
}

/**
 * @param {string} path
 * @returns {string}
 */
export function parentOf(path) {
  return dirname(path)
}

/**
 * Require an object argument bag.
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
export function asObject(value, label = 'arguments') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AutomationError(`${label} must be an object`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AutomationError(`${label} must be a non-empty string`)
  }
  return value
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
export function requireNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AutomationError(`${label} must be a finite number`)
  }
  return value
}

/**
 * Clamp a number into a range.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Parse JSON defensively, returning undefined instead of throwing.
 * @param {string} text
 * @returns {unknown}
 */
export function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
