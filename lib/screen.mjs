// dsh-automation — screenshots and screen recording via macOS `screencapture`.
//
// All capture work is done by /usr/sbin/screencapture so the plugin keeps working
// even when the Swift native helper cannot be compiled. The native helper is used
// only to resolve window titles and display indices, and its absence degrades to
// "pass a window id / display index instead".
//
// Recording: `screencapture -v` is the primary encoder. If it exits immediately
// (no Screen Recording permission, or a sandbox that blocks the screen-capture
// service) we fall back to ffmpeg's avfoundation input when ffmpeg is installed.
// A recording process is owned by this module: stop/dispose always reap it.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  AutomationError,
  asObject,
  errorText,
  parseJson,
  run,
  sleep,
  stamp,
  which,
} from './util.mjs'
import * as native from './native.mjs'

const SCREENCAPTURE = '/usr/sbin/screencapture'
const SIPS = '/usr/bin/sips'
const FFMPEG = which('ffmpeg')
const FFPROBE = which('ffprobe')

const RECORD_STOP_TIMEOUT_MS = 10_000
const RECORD_TERM_TIMEOUT_MS = 2_000
const FORMATS = new Map([
  ['png', 'png'],
  ['jpg', 'jpg'],
  ['jpeg', 'jpg'],
  ['pdf', 'pdf'],
])

const SCREEN_RECORDING_HINT =
  'Open System Settings → Privacy & Security → Screen Recording (or System Audio Recording), enable DeepSeek Harness, then restart DeepSeek Harness and run the computer_permissions tool. macOS only applies Screen Recording changes to a freshly launched process.'
const PERMISSION_PATTERN =
  /could not create image from display|not authorized|not permitted|permission|failed to save to final location|screen recording/i

/** @type {Map<string, Recording>} */
const RECORDINGS = new Map()

let recordingCounter = 0
let nativeConfigured = false

/**
 * @typedef {{
 *   id: string,
 *   path: string,
 *   startedAt: number,
 *   encoder: 'screencapture' | 'ffmpeg',
 *   command: string,
 *   handle: { child: import('node:child_process').ChildProcess, done: Promise<{code:number|null, signal:string|null}>, stderr: () => string },
 *   stopping: boolean,
 * }} Recording
 */

// MARK: - Native helper configuration

/**
 * Point the shared native helper at the configured cache directory. Best effort:
 * screenshots must keep working when the helper cannot be built.
 * @param {{ artifacts?: any, exec?: any, config?: Record<string, any> }} [context]
 * @returns {Promise<void>}
 */
async function configureNative(context = {}) {
  if (nativeConfigured) return
  nativeConfigured = true
  const { artifacts, exec, config } = context ?? {}
  let cacheDir = typeof config?.helperCacheDir === 'string' ? config.helperCacheDir : undefined
  if ((cacheDir === undefined || cacheDir.trim().length === 0) && artifacts !== undefined) {
    try {
      cacheDir = join(await artifacts.base(exec), 'bin')
    } catch {
      cacheDir = undefined
    }
  }
  native.configure({ cacheDir, timeoutMs: config?.commandTimeoutMs })
}

// MARK: - Public: screenshots

/**
 * Take a screenshot.
 * @param {{ display?: number|string, region?: {x:number,y:number,width:number,height:number},
 *   window?: string|number, app?: string, cursor?: boolean, format?: 'png'|'jpg'|'pdf',
 *   path?: string }} args
 * @param {{ artifacts: any, exec: any, config: Record<string, any> }} context
 * @returns {Promise<{ path: string, width?: number, height?: number, bytes: number,
 *   target: string, display?: number }>}
 */
export async function capture(args = {}, context = {}) {
  const options = asObject(args ?? {}, 'screenshot arguments')
  const { artifacts, exec } = context ?? {}
  const format = normalizeFormat(options.format)
  const extension = format === 'jpg' ? 'jpg' : format
  const filePath = await allocatePath(options.path, artifacts, exec, 'screens', extension)

  const region = options.region === undefined ? null : validateRegion(options.region)
  const wantsWindow = options.window !== undefined && options.window !== null && options.window !== ''
  const wantsApp = typeof options.app === 'string' && options.app.trim().length > 0
  if (region !== null && (wantsWindow || wantsApp)) {
    throw new AutomationError('specify either a region or a window/app, not both', {
      code: 'BAD_ARGS',
      hint: 'A region captures absolute screen coordinates; a window/app captures that window. Use one selector per screenshot.',
    })
  }

  const commandArgs = ['-x']
  let target = 'main display'
  let displayIndex
  if (wantsWindow || wantsApp) {
    await configureNative(context)
    const window = await resolveWindow(wantsWindow ? options.window : undefined, wantsApp ? options.app : undefined)
    commandArgs.push(`-l${window.windowId}`)
    target = `window ${window.windowId}: ${window.app}${window.title.length > 0 ? ` — ${window.title}` : ''}`.trim()
  } else if (options.display !== undefined && options.display !== null) {
    await configureNative(context)
    displayIndex = await resolveDisplayIndex(options.display)
    commandArgs.push(`-D${displayIndex}`)
    target = `display ${displayIndex}`
  }
  if (region !== null) {
    commandArgs.push(`-R${region.x},${region.y},${region.width},${region.height}`)
    target = wantsApp || wantsWindow ? target : `region ${region.x},${region.y} ${region.width}x${region.height}`
  }
  if (options.cursor === true) commandArgs.push('-C')
  if (format === 'jpg') commandArgs.push('-t', 'jpg')
  else if (format === 'pdf') commandArgs.push('-t', 'pdf')
  commandArgs.push(filePath)

  const result = await run(SCREENCAPTURE, commandArgs, { timeoutMs: 45_000 })
  if (result.timedOut) {
    throw new AutomationError('screencapture timed out', {
      code: 'SCREEN_CAPTURE_TIMEOUT',
      hint: 'A permission dialog may be waiting. Approve it, then retry.',
    })
  }
  if (result.code !== 0 || !existsSync(filePath)) {
    throw captureFailure(result, filePath)
  }
  let info
  try {
    info = await stat(filePath)
  } catch (error) {
    throw new AutomationError('screencapture reported success but the file is missing', {
      code: 'SCREEN_CAPTURE_FAILED',
      hint: `Expected ${filePath}. Try a different artifact directory.`,
      cause: error,
    })
  }
  if (info.size <= 0) {
    throw new AutomationError('screencapture produced an empty image', {
      code: 'SCREEN_CAPTURE_EMPTY',
      hint: `${SCREEN_RECORDING_HINT} Also check that the selected region is not zero-sized.`,
    })
  }
  const size = await imageSize(filePath)
  const payload = {
    path: filePath,
    bytes: info.size,
    target,
  }
  if (size !== null) {
    payload.width = size.width
    payload.height = size.height
  }
  if (displayIndex !== undefined) payload.display = displayIndex
  return payload
}

/**
 * @param {unknown} value
 * @param {any} artifacts
 * @param {any} exec
 * @param {string} subdir
 * @param {string} extension
 * @returns {Promise<string>}
 */
async function allocatePath(value, artifacts, exec, subdir, extension) {
  if (typeof value === 'string' && value.trim().length > 0) {
    const filePath = resolve(value.trim())
    await mkdir(dirname(filePath), { recursive: true })
    return filePath
  }
  if (artifacts !== undefined && typeof artifacts.path === 'function') {
    return artifacts.path(exec, subdir, extension)
  }
  const dir = join(tmpdir(), 'dsh-automation-screens')
  await mkdir(dir, { recursive: true })
  return join(dir, `${stamp()}-${Math.random().toString(36).slice(2, 8)}.${extension}`)
}

/**
 * @param {unknown} value
 * @returns {'png' | 'jpg' | 'pdf'}
 */
function normalizeFormat(value) {
  if (value === undefined || value === null) return 'png'
  const normalized = String(value).toLowerCase().replace(/^\./u, '')
  const mapped = FORMATS.get(normalized)
  if (mapped === undefined) {
    throw new AutomationError(`unsupported image format '${String(value)}'`, {
      code: 'BAD_ARGS',
      hint: 'format must be png, jpg/jpeg or pdf.',
    })
  }
  return mapped
}

/**
 * @param {unknown} value
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function validateRegion(value) {
  const region = asObject(value, 'region')
  const number = (key) => {
    const raw = region[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new AutomationError(`region.${key} must be a finite number`, { code: 'BAD_ARGS' })
    }
    return Math.round(raw)
  }
  const x = number('x')
  const y = number('y')
  const width = number('width')
  const height = number('height')
  if (width <= 0 || height <= 0) {
    throw new AutomationError('region width and height must be positive', {
      code: 'BAD_ARGS',
      hint: 'Use screen points, e.g. { x: 0, y: 0, width: 800, height: 600 }.',
    })
  }
  return { x, y, width, height }
}

/**
 * @param {{ code: number|null, signal: string|null, stderr: string, stdout: string }} result
 * @param {string} filePath
 * @returns {AutomationError}
 */
function captureFailure(result, filePath) {
  const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim()
  if (detail.length === 0 || PERMISSION_PATTERN.test(detail)) {
    return new AutomationError(
      'macOS refused the screen capture (Screen Recording permission or a sandboxed process)',
      {
        code: 'SCREEN_RECORDING_PERMISSION',
        hint: `${SCREEN_RECORDING_HINT}${detail.length > 0 ? `\nscreencapture: ${detail.slice(-400)}` : ''}`,
      },
    )
  }
  if (/no such file|can't open|failed to save|not a valid|could not/i.test(detail)) {
    return new AutomationError('screencapture could not write the image', {
      code: 'SCREEN_CAPTURE_WRITE_FAILED',
      hint: `Target: ${filePath}. ${detail.slice(-400)}`,
    })
  }
  return new AutomationError(`screencapture failed (exit ${result.code ?? 'signal'})`, {
    code: 'SCREEN_CAPTURE_FAILED',
    hint: detail.slice(-600) || SCREEN_RECORDING_HINT,
  })
}

// MARK: - Public: displays and windows

/**
 * @returns {Promise<Array<{ id: number, index: number, main: boolean,
 *   bounds: {x:number,y:number,width:number,height:number}, scale: number, name?: string }>>}
 */
export async function displays() {
  await configureNative({})
  try {
    const info = await native.screenInfo()
    return info.displays.map((display, position) => ({
      id: Number(display.id),
      index: Number(display.index ?? position + 1),
      main: display.main === true,
      bounds: display.bounds,
      scale: Number(display.scale ?? 1),
      ...(typeof display.name === 'string' ? { name: display.name } : {}),
    }))
  } catch (error) {
    throw enrichNativeError(error, 'could not list displays')
  }
}

/**
 * List capturable windows.
 * @param {{ app?: string }} [options]
 * @returns {Promise<Array<{ windowId: number, app: string, title: string,
 *   bounds: {x:number,y:number,width:number,height:number}, layer: number }>>}
 */
export async function windows(options = {}) {
  await configureNative({})
  try {
    const app = typeof options?.app === 'string' && options.app.trim().length > 0 ? options.app : undefined
    const { windows: list } = await native.windowList(app === undefined ? {} : { app })
    return list
      .filter((window) => Number(window.layer) === 0)
      .filter((window) => window.onscreen !== false)
      .filter((window) => Number(window.bounds?.width ?? 0) >= 2 && Number(window.bounds?.height ?? 0) >= 2)
      .map((window) => ({
        windowId: Number(window.windowId),
        app: String(window.app ?? ''),
        title: String(window.title ?? ''),
        bounds: window.bounds,
        layer: Number(window.layer ?? 0),
      }))
  } catch (error) {
    throw enrichNativeError(error, 'could not list windows')
  }
}

/**
 * @param {unknown} value
 * @returns {Promise<number>}
 */
async function resolveDisplayIndex(value) {
  const numeric = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(numeric) || numeric < 1 || !Number.isInteger(numeric)) {
    throw new AutomationError('display must be a positive integer (1 = main display)', {
      code: 'BAD_ARGS',
      hint: 'Call computer_screenshot with display omitted for the main display, or inspect the display list with the computer_displays action.',
    })
  }
  let list
  try {
    list = await displays()
  } catch {
    // Helper unavailable: assume the caller passed a 1-based index.
    return numeric
  }
  const byIndex = list.find((display, position) => Number(display.index ?? position + 1) === numeric)
  if (byIndex !== undefined) return numeric
  const byId = list.find((display) => display.id === numeric)
  if (byId !== undefined) return Number(byId.index)
  throw new AutomationError(`display ${numeric} does not exist`, {
    code: 'DISPLAY_NOT_FOUND',
    hint: `Available displays: ${list
      .map((display) => `index ${display.index} (id ${display.id}${display.main ? ', main' : ''}${display.name ? `, ${display.name}` : ''})`)
      .join('; ')}`,
  })
}

/**
 * Resolve a window by title substring and/or app name, or accept a raw window id.
 * @param {unknown} windowSpec
 * @param {string | undefined} appName
 * @returns {Promise<{ windowId: number, app: string, title: string }>}
 */
async function resolveWindow(windowSpec, appName) {
  let list
  try {
    const result = await native.windowList(appName === undefined ? {} : { app: appName })
    list = result.windows
  } catch (error) {
    if (typeof windowSpec === 'number' || (typeof windowSpec === 'string' && /^\d+$/u.test(windowSpec.trim()))) {
      const windowId = Number(windowSpec)
      return { windowId, app: '', title: '' }
    }
    throw enrichNativeError(error, 'could not list windows to resolve the requested window')
  }
  const capturable = list.filter((window) => Number(window.layer) === 0 && window.bounds?.width > 0 && window.bounds?.height > 0)
  const titled = capturable.filter((window) => typeof window.title === 'string' && window.title.length > 0)

  let windowId
  let candidates = capturable
  if (typeof windowSpec === 'number' || (typeof windowSpec === 'string' && /^\d+$/u.test(windowSpec.trim()))) {
    windowId = Number(windowSpec)
    const known = capturable.find((window) => Number(window.windowId) === windowId)
    return {
      windowId,
      app: known === undefined ? '' : String(known.app ?? ''),
      title: known === undefined ? '' : String(known.title ?? ''),
    }
  }

  if (typeof windowSpec === 'string' && windowSpec.trim().length > 0) {
    const needle = windowSpec.trim().toLowerCase()
    const onscreen = capturable.filter((window) => window.onscreen !== false)
    const pool = onscreen.length > 0 ? onscreen : capturable
    const exact = pool.filter((window) => String(window.title ?? '').toLowerCase() === needle)
    const partial = exact.length > 0
      ? exact
      : pool.filter((window) => String(window.title ?? '').toLowerCase().includes(needle))
    if (partial.length > 0) {
      if (partial.length === 1) return toWindow(partial[0])
      throw ambiguousWindow(windowSpec, partial, 'title')
    }
    candidates = capturable
    if (titled.length === 0) {
      throw new AutomationError(
        `no window title matched '${windowSpec}', and window titles are currently hidden`,
        {
          code: 'WINDOW_TITLES_HIDDEN',
          hint: `${SCREEN_RECORDING_HINT} You can also pass a numeric window id (see the computer_windows action) instead of a title.`,
        },
      )
    }
    throw windowNotFound(windowSpec, candidates)
  }

  // Only an app name was given: require a single normal window for that app.
  const onscreen = capturable.filter((window) => window.onscreen !== false)
  const pool = onscreen.length > 0 ? onscreen : capturable
  if (pool.length === 0) {
    throw new AutomationError(`app '${appName ?? ''}' has no capturable windows`, {
      code: 'WINDOW_NOT_FOUND',
      hint: 'Activate the app, make sure a window is visible, then retry. Use the computer_windows action to list windows.',
    })
  }
  if (pool.length === 1) return toWindow(pool[0])
  throw ambiguousWindow(appName ?? 'app', pool, 'app')
}

/**
 * @param {Record<string, any>} window
 * @returns {{ windowId: number, app: string, title: string }}
 */
function toWindow(window) {
  return {
    windowId: Number(window.windowId),
    app: String(window.app ?? ''),
    title: String(window.title ?? ''),
  }
}

/**
 * @param {unknown} needle
 * @param {Array<Record<string, any>>} candidates
 * @param {'title'|'app'} kind
 * @returns {AutomationError}
 */
function ambiguousWindow(needle, candidates, kind) {
  return new AutomationError(
    `${kind === 'app' ? 'app' : 'window'} '${String(needle)}' matches ${candidates.length} windows`,
    {
      code: 'WINDOW_AMBIGUOUS',
      hint: `Pass window (title substring) or a numeric window id to choose one:\n${candidateList(candidates)}`,
    },
  )
}

/**
 * @param {unknown} needle
 * @param {Array<Record<string, any>>} candidates
 * @returns {AutomationError}
 */
function windowNotFound(needle, candidates) {
  return new AutomationError(`no window matched '${String(needle)}'`, {
    code: 'WINDOW_NOT_FOUND',
    hint: `Available windows:\n${candidateList(candidates.filter((window) => String(window.title ?? '').length > 0))}`,
  })
}

/**
 * @param {Array<Record<string, any>>} candidates
 * @returns {string}
 */
function candidateList(candidates) {
  if (candidates.length === 0) return '(no windows are currently capturable — open or activate a window first)'
  return candidates
    .slice(0, 10)
    .map((window) => {
      const title = String(window.title ?? '')
      return `#${window.windowId} ${String(window.app ?? '')}${title.length > 0 ? ` — ${title}` : ''} (${window.bounds?.width ?? '?'}x${window.bounds?.height ?? '?'})`
    })
    .join('\n')
}

/**
 * @param {unknown} error
 * @param {string} what
 * @returns {Error}
 */
function enrichNativeError(error, what) {
  if (error instanceof AutomationError) {
    if (error.code === 'NATIVE_HELPER_UNAVAILABLE' || error.code === 'NATIVE_HELPER_COMPILE_FAILED') {
      return new AutomationError(`${what}: the native macOS helper is unavailable`, {
        code: 'NATIVE_HELPER_UNAVAILABLE',
        hint: `${errorText(error)}\nInstall Xcode Command Line Tools (\`xcode-select --install\`) for display/window lookups; pass a numeric window id to capture by window id without the helper.`,
      })
    }
    return error
  }
  return new AutomationError(`${what}: ${errorText(error)}`, { code: 'WINDOW_QUERY_FAILED' })
}

// MARK: - Image metadata

/**
 * @param {string} filePath
 * @returns {Promise<{ width: number, height: number } | null>}
 */
async function imageSize(filePath) {
  if (existsSync(SIPS)) {
    const result = await run(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath], { timeoutMs: 15_000 })
    if (result.code === 0) {
      const width = /pixelWidth:\s*([\d.]+)/u.exec(result.stdout)
      const height = /pixelHeight:\s*([\d.]+)/u.exec(result.stdout)
      if (width !== null && height !== null) {
        return { width: Math.round(Number(width[1])), height: Math.round(Number(height[1])) }
      }
    }
  }
  try {
    const handle = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(262_144)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return headerSize(buffer.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * Parse pixel dimensions from a PNG or JPEG header (sips-free fallback).
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number } | null}
 */
function headerSize(buffer) {
  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR width/height big-endian at offsets 16/20.
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  // JPEG: scan markers for a SOFn frame header.
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
  }
  return null
}

// MARK: - Recording

/**
 * Start a screen recording. The process keeps running until stopRecording() or
 * dispose(); it is tracked in module state so it can never be orphaned.
 * @param {{ display?: number|string, region?: {x:number,y:number,width:number,height:number},
 *   showClicks?: boolean, audio?: boolean }} args
 * @param {{ artifacts: any, exec: any, config: Record<string, any> }} context
 * @returns {Promise<{ id: string, path: string, startedAt: number, command: string, encoder: 'screencapture'|'ffmpeg' }>}
 */
export async function startRecording(args = {}, context = {}) {
  const options = asObject(args ?? {}, 'recording arguments')
  const { artifacts, exec } = context ?? {}
  await configureNative(context)

  const region = options.region === undefined ? null : validateRegion(options.region)
  const filePath = await allocatePath(options.path, artifacts, exec, 'recordings', 'mov')
  let displayIndex
  if (options.display !== undefined && options.display !== null) {
    displayIndex = await resolveDisplayIndex(options.display)
  }

  // If the helper can see the permission state and Screen Recording is clearly
  // denied, fail fast with an actionable message instead of letting ffmpeg block
  // on a hidden TCC prompt for minutes.
  const permission = await recordingPermission()
  if (permission === false) {
    throw new AutomationError('Screen Recording permission is not granted', {
      code: 'SCREEN_RECORDING_PERMISSION',
      hint: SCREEN_RECORDING_HINT,
    })
  }

  // Escape hatch: force the ffmpeg path (e.g. when a restricted/sandboxed parent
  // cannot use screencapture's video service, or for tests).
  const forcedEncoder = (process.env.DSH_AUTOMATION_RECORDING_ENCODER ?? '').toLowerCase()
  if (forcedEncoder === 'ffmpeg') {
    if (FFMPEG === null) {
      throw new AutomationError('DSH_AUTOMATION_RECORDING_ENCODER=ffmpeg but ffmpeg is not installed', {
        code: 'FFMPEG_MISSING',
        hint: 'Install ffmpeg with `brew install ffmpeg`, or unset DSH_AUTOMATION_RECORDING_ENCODER.',
      })
    }
    const forced = await startFfmpegRecording({
      filePath,
      displayIndex,
      region,
      showClicks: options.showClicks === true,
    })
    if (forced !== null) return forced
  }

  const screencaptureArgs = ['-v', '-x']
  if (displayIndex !== undefined) screencaptureArgs.push(`-D${displayIndex}`)
  if (region !== null) screencaptureArgs.push(`-R${region.x},${region.y},${region.width},${region.height}`)
  if (options.showClicks === true) screencaptureArgs.push('-k')
  if (options.audio === true) screencaptureArgs.push('-g')
  screencaptureArgs.push(filePath)

  const handle = spawnProcess(SCREENCAPTURE, screencaptureArgs)
  const settled = await waitForExit(handle, 1_200)
  if (!settled.exited) {
    return registerRecording({
      path: filePath,
      encoder: 'screencapture',
      command: commandLine(SCREENCAPTURE, screencaptureArgs),
      handle,
    })
  }

  // screencapture -v failed immediately. Fall back to ffmpeg when available.
  const detail = handle.stderr().trim()
  if (FFMPEG !== null) {
    const fallback = await startFfmpegRecording({ filePath, displayIndex, region, showClicks: options.showClicks === true })
    if (fallback !== null) return fallback
  }
  throw new AutomationError(
    'macOS refused to start a screen recording (Screen Recording permission or a sandboxed process)',
    {
      code: 'SCREEN_RECORDING_PERMISSION',
      hint: `${SCREEN_RECORDING_HINT}${detail.length > 0 ? `\nscreencapture: ${detail.slice(-400)}` : ''}`,
    },
  )
}

/**
 * @param {{ filePath: string, displayIndex?: number, region: any, showClicks: boolean }} options
 * @returns {Promise<{ id: string, path: string, startedAt: number, command: string, encoder: 'ffmpeg' } | null>}
 */
async function startFfmpegRecording(options) {
  const screenNumber = options.displayIndex === undefined ? 0 : Math.max(0, options.displayIndex - 1)
  const input = `Capture screen ${screenNumber}`
  const ffmpegArgs = ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-framerate', '30']
  if (options.showClicks) {
    ffmpegArgs.push('-capture_cursor', '1', '-capture_mouse_clicks', '1')
  }
  ffmpegArgs.push('-i', input)
  if (options.region !== null && options.region !== undefined) {
    const { x, y, width, height } = options.region
    ffmpegArgs.push('-vf', `crop=${width}:${height}:${x}:${y}`)
  }
  ffmpegArgs.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y',
    options.filePath,
  )
  const handle = spawnProcess(FFMPEG, ffmpegArgs)
  // ffmpeg creates the output file as soon as the input opens; wait briefly for
  // evidence that capture actually started instead of returning a dead handle.
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      const detail = handle.stderr().trim()
      throw new AutomationError('ffmpeg could not start the screen recording', {
        code: 'SCREEN_RECORDING_PERMISSION',
        hint: `${SCREEN_RECORDING_HINT}${detail.length > 0 ? `\nffmpeg: ${detail.slice(-500)}` : ''}`,
      })
    }
    if (await fileHasBytes(options.filePath)) {
      return registerRecording({
        path: options.filePath,
        encoder: 'ffmpeg',
        command: commandLine(FFMPEG, ffmpegArgs),
        handle,
      })
    }
    await sleep(100)
  }
  handle.child.kill('SIGKILL')
  await waitForExit(handle, 2_000)
  throw new AutomationError('ffmpeg started but produced no screen recording data', {
    code: 'SCREEN_RECORDING_PERMISSION',
    hint: `${SCREEN_RECORDING_HINT}\nThe screen-capture device stayed closed, which usually means the permission prompt was denied or the process is sandboxed.`,
  })
}

/**
 * @param {{ path: string, encoder: 'screencapture'|'ffmpeg', command: string, handle: any }} options
 * @returns {{ id: string, path: string, startedAt: number, command: string, encoder: 'screencapture'|'ffmpeg' }}
 */
function registerRecording(options) {
  recordingCounter += 1
  const id = `rec-${Date.now().toString(36)}-${recordingCounter}`
  /** @type {Recording} */
  const recording = {
    id,
    path: options.path,
    startedAt: Date.now(),
    encoder: options.encoder,
    command: options.command,
    handle: options.handle,
    stopping: false,
  }
  RECORDINGS.set(id, recording)
  return { id, path: recording.path, startedAt: recording.startedAt, command: recording.command, encoder: recording.encoder }
}

/**
 * @returns {Promise<boolean | null>} null when permission state cannot be checked
 */
async function recordingPermission() {
  try {
    const status = await native.permissions()
    return status.screenRecording === true
  } catch {
    return null
  }
}

/**
 * Stop one recording and validate the resulting movie file.
 * @param {{ id: string }} options
 * @returns {Promise<{ id: string, path: string, bytes: number, durationMs: number,
 *   width?: number, height?: number, encoder: string }>}
 */
export async function stopRecording(options = {}) {
  let id = typeof options?.id === 'string' && options.id.length > 0 ? options.id : undefined
  if (id === undefined) {
    // No id: stop the most recent recording (matches the tool's "stop last" use).
    const ids = [...RECORDINGS.keys()]
    if (ids.length === 0) {
      throw new AutomationError('there is no recording to stop', {
        code: 'UNKNOWN_RECORDING',
        hint: 'Start a recording first with the screen_record tool (action "start").',
      })
    }
    id = ids[ids.length - 1]
  }
  const recording = RECORDINGS.get(id)
  if (recording === undefined) {
    throw new AutomationError(`unknown recording '${id}'`, {
      code: 'UNKNOWN_RECORDING',
      hint: `Running recordings: ${[...RECORDINGS.keys()].join(', ') || '(none)'}. Use recording status to list them.`,
    })
  }
  RECORDINGS.delete(id)
  return finalizeRecording(recording)
}

/**
 * @param {Recording} recording
 * @returns {Promise<{ id: string, path: string, bytes: number, durationMs: number,
 *   width?: number, height?: number, encoder: string }>}
 */
async function finalizeRecording(recording) {
  recording.stopping = true
  await terminateProcess(recording.handle)
  const wallClockMs = Math.max(0, Date.now() - recording.startedAt)
  let info
  try {
    info = await stat(recording.path)
  } catch {
    throw new AutomationError('the screen recording produced no file', {
      code: 'RECORDING_FAILED',
      hint: `Expected ${recording.path}. The encoder (${recording.encoder}) exited before writing data — usually Screen Recording permission, or the parent process is sandboxed and macOS refused the video service. If screencapture reports "Failed to save to final location", grant Screen Recording, restart DeepSeek Harness, or set DSH_AUTOMATION_RECORDING_ENCODER=ffmpeg to use the ffmpeg encoder. ${recording.handle.stderr().trim().slice(-400)}`.trim(),
    })
  }
  if (info.size <= 0) {
    throw new AutomationError('the screen recording file is empty', {
      code: 'RECORDING_EMPTY',
      hint: 'Record for at least a second before stopping, and verify Screen Recording permission. ' +
        recording.handle.stderr().trim().slice(-400),
    })
  }
  const probed = await probeVideo(recording.path)
  const payload = {
    id: recording.id,
    path: recording.path,
    bytes: info.size,
    durationMs: probed?.durationMs ?? wallClockMs,
    encoder: recording.encoder,
  }
  if (probed?.width !== undefined) payload.width = probed.width
  if (probed?.height !== undefined) payload.height = probed.height
  return payload
}

/**
 * Send SIGINT and escalate to SIGTERM/SIGKILL so no encoder is ever orphaned.
 * @param {{ child: import('node:child_process').ChildProcess, done: Promise<any>, stderr: () => string }} handle
 * @returns {Promise<void>}
 */
async function terminateProcess(handle) {
  const child = handle.child
  if (child.exitCode !== null || child.signalCode !== null) {
    await waitForExit(handle, 1_000)
    return
  }
  child.kill('SIGINT')
  let settled = await waitForExit(handle, RECORD_STOP_TIMEOUT_MS)
  if (!settled.exited) {
    child.kill('SIGTERM')
    settled = await waitForExit(handle, RECORD_TERM_TIMEOUT_MS)
  }
  if (!settled.exited) {
    child.kill('SIGKILL')
    await waitForExit(handle, RECORD_TERM_TIMEOUT_MS)
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<{ durationMs?: number, width?: number, height?: number } | null>}
 */
async function probeVideo(filePath) {
  if (FFPROBE === null) return null
  const result = await run(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', filePath],
    { timeoutMs: 15_000 },
  )
  if (result.code !== 0) return null
  const parsed = parseJson(result.stdout)
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') return null
  const payload = {}
  const duration = Number(parsed.format?.duration)
  if (Number.isFinite(duration) && duration > 0) payload.durationMs = Math.round(duration * 1000)
  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const video = streams.find((stream) => Number.isFinite(Number(stream.width)) && Number.isFinite(Number(stream.height)))
  if (video !== undefined) {
    payload.width = Number(video.width)
    payload.height = Number(video.height)
  }
  return payload
}

/**
 * @returns {{ recordings: Array<{ id: string, path: string, startedAt: number, running: boolean, elapsedMs: number }> }}
 */
export function recordingStatus() {
  const now = Date.now()
  return {
    recordings: [...RECORDINGS.values()].map((recording) => ({
      id: recording.id,
      path: recording.path,
      startedAt: recording.startedAt,
      running: recording.handle.child.exitCode === null && recording.handle.child.signalCode === null,
      elapsedMs: Math.max(0, now - recording.startedAt),
    })),
  }
}

/**
 * Stop every running recording and wait for the encoders to exit. Idempotent.
 * @returns {Promise<void>}
 */
export async function dispose() {
  const recordings = [...RECORDINGS.values()]
  RECORDINGS.clear()
  await Promise.allSettled(recordings.map(async (recording) => {
    try {
      await finalizeRecording(recording)
    } catch {
      // dispose must never throw; finalize already reaped the process.
    }
  }))
}

// MARK: - Process helpers

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {{ child: import('node:child_process').ChildProcess, done: Promise<{code:number|null, signal:string|null}>, stderr: () => string }}
 */
function spawnProcess(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 65_536) stderr += chunk.toString()
  })
  child.stdin?.on('error', () => {})
  const done = new Promise((resolveDone) => {
    let settled = false
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      resolveDone({ code, signal })
    }
    child.once('error', (error) => {
      if (stderr.length < 65_536) stderr += String(error?.message ?? error)
      finish(null, null)
    })
    child.once('close', (code, signal) => finish(code, signal))
  })
  return { child, done, stderr: () => stderr }
}

/**
 * @param {{ done: Promise<unknown> }} handle
 * @param {number} timeoutMs
 * @returns {Promise<{ exited: boolean, code?: number|null, signal?: string|null }>}
 */
async function waitForExit(handle, timeoutMs) {
  let timer
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout('timeout'), Math.max(1, timeoutMs))
  })
  try {
    const result = await Promise.race([handle.done, timeout])
    if (result === 'timeout') return { exited: false }
    const value = /** @type {{ code: number|null, signal: string|null }} */ (result)
    return { exited: true, code: value.code, signal: value.signal }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileHasBytes(filePath) {
  try {
    const info = await stat(filePath)
    return info.size > 0
  } catch {
    return false
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
function commandLine(command, args) {
  return [command, ...args.map((arg) => (/\s/u.test(arg) ? JSON.stringify(arg) : arg))].join(' ')
}

/** @internal test hook: count of tracked recordings. */
export function trackedRecordingCount() {
  return RECORDINGS.size
}

/** @internal test hook: pid/path of every tracked recording (for orphan checks). */
export function debugRecordingProcesses() {
  return [...RECORDINGS.values()].map((recording) => ({
    id: recording.id,
    path: recording.path,
    pid: recording.handle.child.pid ?? -1,
    encoder: recording.encoder,
  }))
}
