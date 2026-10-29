#!/usr/bin/env node
// dsh-automation — self-test for the native macOS automation layer.
//
// Run from anywhere:   node test/native-selftest.mjs
//
// What this verifies
//   - the Swift helper compiles with swiftc (fresh cache), is reusable (cache
//     hit, also across a second Node process) and speaks the JSON protocol
//   - non-TCC commands: permissions, displays, cursor, apps, windows list
//   - JS error mapping for helper/protocol failures (AutomationError codes/hints)
//   - screen capture paths: display, region, app/window, jpg/pdf/cursor, and
//     validation errors; image dimensions verified by an independent JPEG/PNG
//     header parser
//   - screen recording: screencapture -v path (when the environment allows it)
//     and the ffmpeg fallback, including stop, dispose, idempotent dispose and
//     "no orphaned encoder process" checks
//   - apps module: list/open validation, AppleScript + JXA runners and
//     Automation/Accessibility permission error mapping
//
// TCC-gated behaviour is reported, never failed: this script is expected to run
// inside a seatbelt-sandboxed shell where Screen Recording / Accessibility may be
// denied. Set DSH_NATIVE_SELFTEST_INPUT=1 to additionally exercise a real mouse
// move (cursor moves 30x20 points and is restored).

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { AutomationError, stamp } from '../lib/util.mjs'
import * as native from '../lib/native.mjs'
import * as screen from '../lib/screen.mjs'
import * as apps from '../lib/apps.mjs'

const execFileAsync = promisify(execFile)
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_ROOT = '/tmp/dsh-auto-test/native-selftest'
const CACHE_DIR = join(TEST_ROOT, 'helper-cache')
const ARTIFACT_ROOT = join(TEST_ROOT, 'artifacts')

const results = { pass: 0, fail: 0, report: 0, failures: [], reports: [] }

// MARK: - Harness

function setSection(name) {
  console.log(`\n── ${name} ──`)
}

function pass(name, detail) {
  results.pass += 1
  console.log(`PASS   ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
}

function fail(name, error) {
  results.fail += 1
  const message = error instanceof Error ? `${error.message}${error.hint ? `\n       hint: ${error.hint}` : ''}` : String(error)
  results.failures.push(`${name}: ${message}`)
  console.log(`FAIL   ${name}\n       ${message.split('\n').join('\n       ')}`)
}

function report(name, detail) {
  results.report += 1
  results.reports.push(`${name}: ${detail}`)
  console.log(`REPORT ${name} — ${detail}`)
}

async function test(name, fn) {
  try {
    const detail = await fn()
    pass(name, typeof detail === 'string' ? detail : undefined)
  } catch (error) {
    fail(name, error)
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function expectEqual(actual, expected, message) {
  assert.equal(actual, expected, message)
}

/** Run a TCC-gated capture; convert permission failures into a Blocked marker. */
async function captureGuarded(args, context) {
  try {
    return { ok: true, value: await screen.capture(args, context) }
  } catch (error) {
    if (error instanceof AutomationError && /PERMISSION/.test(error.code ?? '')) {
      return { ok: false, blocked: error }
    }
    throw error
  }
}

/** Assert an AutomationError with one of the allowed codes. */
async function expectAutomationError(fn, allowedCodes, label) {
  try {
    await fn()
  } catch (error) {
    expect(error instanceof AutomationError, `${label}: expected an AutomationError, got ${error?.constructor?.name}: ${error?.message}`)
    expect(allowedCodes.includes(error.code), `${label}: expected code in ${JSON.stringify(allowedCodes)}, got ${JSON.stringify(error.code)} (${error.message})`)
    expect(typeof error.hint === 'string' && error.hint.length > 0, `${label}: AutomationError is missing an actionable hint`)
    return error
  }
  throw new Error(`${label}: expected a failure, but the call succeeded`)
}

// MARK: - Fixtures

const fakeArtifacts = {
  async base() {
    await mkdir(join(ARTIFACT_ROOT, 'base'), { recursive: true })
    return join(ARTIFACT_ROOT, 'base')
  },
  async dir(exec, subdir = 'misc') {
    const dir = join(ARTIFACT_ROOT, subdir)
    await mkdir(dir, { recursive: true })
    return dir
  },
  async path(exec, subdir, ext) {
    const dir = join(ARTIFACT_ROOT, subdir)
    await mkdir(dir, { recursive: true })
    return join(dir, `${stamp()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
  },
}

const context = {
  artifacts: fakeArtifacts,
  exec: { agent: { id: 'native-selftest' } },
  config: { helperCacheDir: CACHE_DIR, commandTimeoutMs: 30_000 },
}

async function assertArtifactPath(filePath) {
  expect(typeof filePath === 'string', 'result path must be a string')
  expect(resolve(filePath).startsWith(TEST_ROOT), `artifact path ${filePath} must stay under ${TEST_ROOT}`)
  const info = await stat(filePath)
  expect(info.size > 0, `artifact ${filePath} must be non-empty`)
  return info.size
}

function containedArtifact(filePath) {
  return resolve(filePath).startsWith(TEST_ROOT)
}

// MARK: - Independent image header parsers

function pngSize(buffer) {
  if (buffer.length < 24) return null
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
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
  return null
}

// MARK: - Raw helper invocation

async function helperRaw(args) {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', 'exec "$0" "$@"', ...args], { timeout: 60_000 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message) }
  }
}

// MARK: - Main

let helperBinary
let helperMtimeMs

async function main() {
  console.log('native-automation self-test')
  console.log(`  node      ${process.version}`)
  console.log(`  platform  ${process.platform} ${process.arch}`)
  console.log(`  plugin    ${PLUGIN_ROOT}`)
  console.log(`  test root ${TEST_ROOT}`)
  await rm(TEST_ROOT, { recursive: true, force: true })
  await mkdir(TEST_ROOT, { recursive: true })
  delete process.env.DSH_AUTOMATION_RECORDING_ENCODER

  // ── Contract surface ───────────────────────────────────────────────────────
  setSection('module exports follow CONTRACT.md')
  const nativeExports = ['ensureHelper', 'permissions', 'requestPermission', 'openSettings', 'screenInfo', 'appList', 'appAction', 'appWindows', 'mouse', 'keyboard', 'clickAt', 'axTrusted']
  const screenExports = ['capture', 'displays', 'windows', 'startRecording', 'stopRecording', 'recordingStatus', 'dispose']
  const appsExports = ['listApps', 'open', 'activate', 'quit', 'hide', 'windows', 'appleScript']
  await test('native.mjs exports', () => {
    for (const name of nativeExports) expectEqual(typeof native[name], 'function', `missing export ${name}`)
    return `${nativeExports.length} functions`
  })
  await test('screen.mjs exports', () => {
    for (const name of screenExports) expectEqual(typeof screen[name], 'function', `missing export ${name}`)
    return `${screenExports.length} functions`
  })
  await test('apps.mjs exports', () => {
    for (const name of appsExports) expectEqual(typeof apps[name], 'function', `missing export ${name}`)
    return `${appsExports.length} functions`
  })
  await test('tool paths exist on this machine', () => {
    const paths = apps.toolPaths()
    expect(paths.open !== null, 'missing /usr/bin/open')
    expect(paths.osascript !== null, 'missing /usr/bin/osascript')
    expect(paths.screencapture !== null, 'missing /usr/sbin/screencapture')
    return `ffmpeg=${paths.ffmpeg ?? 'MISSING'}`
  })

  // ── Helper compilation ─────────────────────────────────────────────────────
  setSection('Swift helper compile / cache')
  const compileStart = Date.now()
  try {
    helperBinary = await native.ensureHelper({ cacheDir: CACHE_DIR, timeoutMs: 30_000 })
    helperMtimeMs = (await stat(helperBinary)).mtimeMs
    const compileMs = Date.now() - compileStart
    pass('ensureHelper compiles the helper', `${helperBinary} (${compileMs} ms, ${(await stat(helperBinary)).size} bytes)`)
  } catch (error) {
    fail('ensureHelper compiles the helper', error)
    printSummary()
    process.exitCode = 1
    return
  }
  await test('helper binary is executable', () => {
    expect(existsSync(helperBinary), 'binary file is missing')
    accessSync(helperBinary, constants.X_OK)
    return helperBinary
  })
  await test('helper name contains the source hash', async () => {
    const source = await readFile(join(PLUGIN_ROOT, 'lib/native-helper.swift'))
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 8)
    expect(helperBinary.endsWith(`native-helper-${hash}`), `expected name native-helper-${hash}, got ${helperBinary}`)
    return hash
  })
  await test('ensureHelper is idempotent (cache hit, same binary, same mtime)', async () => {
    const again = await native.ensureHelper({ cacheDir: CACHE_DIR })
    expectEqual(again, helperBinary, 'ensureHelper returned a different path')
    const mtime = (await stat(helperBinary)).mtimeMs
    expectEqual(mtime, helperMtimeMs, 'helper binary was recompiled')
    const entries = await readdir(CACHE_DIR)
    const binaries = entries.filter((entry) => entry.startsWith('native-helper-'))
    expectEqual(binaries.length, 1, `expected exactly one compiled helper, found ${binaries.join(', ')}`)
    return 'no recompile'
  })
  await test('compiled helper is reused by a fresh Node process', async () => {
    const moduleUrl = pathToFileURL(join(PLUGIN_ROOT, 'lib/native.mjs')).href
    const script = `import { ensureHelper } from '${moduleUrl}';\nprocess.stdout.write(await ensureHelper({ cacheDir: ${JSON.stringify(CACHE_DIR)} }));`
    const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { timeout: 60_000 })
    expectEqual(result.stdout.trim(), helperBinary, 'child process compiled a different helper')
    return 'cache shared'
  })

  // ── JSON protocol ──────────────────────────────────────────────────────────
  setSection('helper JSON protocol and failure mapping')
  await test('unknown command -> JSON error + non-zero exit', async () => {
    const result = await helperRaw([helperBinary, 'not-a-command', '{}'])
    expect(result.code !== 0, 'expected non-zero exit')
    const payload = JSON.parse(result.stdout)
    expectEqual(payload.code, 'UNKNOWN_COMMAND', 'unexpected helper code')
    expect(typeof payload.error === 'string' && payload.error.length > 0, 'missing error text')
    return `avoided ${JSON.stringify(payload)}`
  })
  await test('malformed JSON args -> JSON error + non-zero exit', async () => {
    const result = await helperRaw([helperBinary, 'displays', '{not-json'])
    expect(result.code !== 0, 'expected non-zero exit')
    const payload = JSON.parse(result.stdout)
    expectEqual(payload.code, 'BAD_ARGS', 'unexpected helper code')
    return payload.error
  })
  await test('missing command -> JSON error + non-zero exit', async () => {
    const result = await helperRaw([helperBinary])
    expect(result.code !== 0, 'expected non-zero exit')
    const payload = JSON.parse(result.stdout)
    expectEqual(payload.code, 'BAD_ARGS', 'unexpected helper code')
    return payload.error
  })
  await test('unsupported key fails before posting events', async () => {
    const result = await helperRaw([helperBinary, 'key', JSON.stringify({ key: 'definitely-not-a-key' })])
    expect(result.code !== 0, 'expected non-zero exit')
    const payload = JSON.parse(result.stdout)
    expectEqual(payload.code, 'UNSUPPORTED_KEY', 'unexpected helper code')
    return payload.error
  })
  await test('unsupported app action -> UNSUPPORTED_ACTION', async () => {
    const result = await helperRaw([helperBinary, 'app-action', JSON.stringify({ action: 'explode', app: 'Finder' })])
    expect(result.code !== 0, 'expected non-zero exit')
    const payload = JSON.parse(result.stdout)
    expectEqual(payload.code, 'UNSUPPORTED_ACTION', 'unexpected helper code')
    return payload.error
  })
  await test('native.mjs maps protocol error payloads to AutomationError', async () => {
    const error = await expectAutomationError(() => native.keyboard({ action: 'key', key: 'no-such-key' }), ['UNSUPPORTED_KEY'], 'keyboard key')
    return error.code
  })
  await test('native.mjs maps unknown app to APP_NOT_FOUND with hint', async () => {
    const error = await expectAutomationError(() => native.appWindows({ app: 'NoSuchAppZZZ' }), ['APP_NOT_FOUND'], 'appWindows')
    return error.code
  })

  // ── Permissions ────────────────────────────────────────────────────────────
  setSection('permissions (report-only, TCC)')
  let permissions
  await test('native.permissions() shape', async () => {
    permissions = await native.permissions()
    expectEqual(typeof permissions.accessibility, 'boolean', 'accessibility must be boolean')
    expectEqual(typeof permissions.screenRecording, 'boolean', 'screenRecording must be boolean')
    expectEqual(permissions.platform, 'macos', 'platform must be macos')
    expectEqual(permissions.helperPath, helperBinary, 'helperPath must point at the compiled helper')
    return `accessibility=${permissions.accessibility} screenRecording=${permissions.screenRecording}`
  })
  await test('native.axTrusted() matches permissions.accessibility', async () => {
    const trusted = await native.axTrusted()
    expectEqual(trusted, permissions?.accessibility, 'axTrusted disagrees with permissions()')
    return String(trusted)
  })
  if (permissions !== undefined) {
    report('TCC state', `accessibility=${permissions.accessibility}, screenRecording=${permissions.screenRecording} (screen capture / accessibility failures below are reported as sandbox/TCC limitations, not bugs)`)
  }

  await test('requestPermission validates the kind', async () => {
    await expectAutomationError(() => native.requestPermission('everything'), ['BAD_ARGS'], 'bad permission kind')
  })
  if (permissions?.screenRecording === true) {
    await test('requestPermission(screen-recording) reports already granted', async () => {
      const result = await native.requestPermission('screen-recording')
      expectEqual(result.granted, true, 'expected granted=true')
      expectEqual(result.prompted, false, 'expected no prompt when already granted')
      return 'granted, no prompt'
    })
  } else {
    report('requestPermission not exercised', 'Screen Recording is not granted; calling it would show a system prompt.')
  }
  await test('openSettings validates the pane', async () => {
    await expectAutomationError(() => native.openSettings('everything'), ['BAD_ARGS'], 'bad settings pane')
  })

  // ── Displays / cursor ──────────────────────────────────────────────────────
  setSection('displays, cursor, frontmost app')
  let screenInfo
  await test('native.screenInfo() returns displays, cursor and frontmost app', async () => {
    screenInfo = await native.screenInfo()
    expect(Array.isArray(screenInfo.displays) && screenInfo.displays.length >= 1, 'expected at least one display')
    for (const display of screenInfo.displays) {
      expect(Number.isFinite(display.id), 'display.id must be a number')
      expect(Number.isInteger(display.index) && display.index >= 1, 'display.index must be a positive integer')
      expectEqual(typeof display.main, 'boolean', 'display.main must be boolean')
      expect(Number.isFinite(display.bounds.x) && Number.isFinite(display.bounds.y), 'display.bounds must be numeric')
      expect(display.bounds.width > 0 && display.bounds.height > 0, 'display.bounds must be positive')
      expect(Number(display.scale) > 0, 'display.scale must be positive')
    }
    expect(Number.isFinite(screenInfo.cursor.x) && Number.isFinite(screenInfo.cursor.y), 'cursor must be numeric')
    expect(typeof screenInfo.frontmostApp.name === 'string', 'frontmostApp.name must be a string')
    expect(Number.isInteger(screenInfo.frontmostApp.pid), 'frontmostApp.pid must be an integer')
    return `${screenInfo.displays.length} display(s), main=${screenInfo.displays.find((d) => d.main)?.name ?? '?'}, frontmost=${screenInfo.frontmostApp.name || '(none)'}`
  })
  await test('screen.displays() mirrors the helper with 1-based indices', async () => {
    const list = await screen.displays()
    expectEqual(list.length, screenInfo?.displays?.length, 'display count mismatch')
    const main = list.find((display) => display.main)
    expect(main !== undefined, 'no main display flagged')
    expect(main.index >= 1, 'main display index must be >= 1')
    return `main index=${main.index} id=${main.id}`
  })
  await test('cursor points inside some display (sanity)', () => {
    const cursor = screenInfo.cursor
    const inside = screenInfo.displays.some((display) =>
      cursor.x >= display.bounds.x &&
      cursor.y >= display.bounds.y &&
      cursor.x <= display.bounds.x + display.bounds.width &&
      cursor.y <= display.bounds.y + display.bounds.height)
    expect(inside, `cursor ${JSON.stringify(cursor)} is outside every display`)
  })

  // ── App list ───────────────────────────────────────────────────────────────
  setSection('applications and windows lists')
  let appList
  await test('native.appList() lists running GUI apps', async () => {
    appList = await native.appList()
    expect(Array.isArray(appList), 'appList must be an array')
    expect(appList.length > 0, 'expected at least one running GUI app')
    for (const app of appList) {
      expect(typeof app.name === 'string', 'app.name must be a string')
      expect(typeof app.bundleId === 'string', 'app.bundleId must be a string')
      expect(Number.isInteger(app.pid) && app.pid > 0, 'app.pid must be a positive integer')
      expectEqual(typeof app.active, 'boolean', 'app.active must be boolean')
      expectEqual(typeof app.hidden, 'boolean', 'app.hidden must be boolean')
      expect(Array.isArray(app.windows), 'app.windows must be an array')
    }
    const active = appList.filter((app) => app.active)
    expect(active.length <= 1, 'more than one app reported as active')
    return `${appList.length} apps, active=${active[0]?.name ?? '(none)'}`
  })
  await test('apps.listApps() delegates to the native app list', async () => {
    const list = await apps.listApps()
    expectEqual(list.length, appList?.length, 'apps.listApps count mismatch')
    return `${list.length} apps`
  })
  let windowPayload
  await test('native.windowList() returns CGWindow info', async () => {
    windowPayload = await native.windowList()
    expect(Array.isArray(windowPayload.windows), 'windows must be an array')
    expectEqual(typeof windowPayload.screenRecording, 'boolean', 'screenRecording flag must be boolean')
    expect(windowPayload.windows.length > 0, 'expected at least one window')
    for (const window of windowPayload.windows.slice(0, 40)) {
      expect(Number.isInteger(window.windowId) && window.windowId > 0, 'windowId must be positive integer')
      expect(typeof window.app === 'string', 'window.app must be a string')
      expect(Number.isFinite(window.layer), 'window.layer must be numeric')
      expect(Number.isFinite(window.bounds?.width) && Number.isFinite(window.bounds?.height), 'window.bounds must be numeric')
    }
    const titled = windowPayload.windows.filter((window) => window.title.length > 0).length
    return `${windowPayload.windows.length} windows, ${titled} with visible titles`
  })
  await test('screen.windows() returns capturable windows only', async () => {
    const list = await screen.windows()
    expect(Array.isArray(list), 'windows must be an array')
    for (const window of list) {
      expect(Number.isInteger(window.windowId), 'windowId must be an integer')
      expect(typeof window.app === 'string', 'app must be a string')
      expect(typeof window.title === 'string', 'title must be a string')
      expectEqual(window.layer, 0, 'only layer-0 windows should be listed')
      expect(window.bounds?.width >= 2 && window.bounds?.height >= 2, 'window bounds must be usable')
    }
    return `${list.length} capturable windows`
  })
  await test('screen.windows({app}) filters by app', async () => {
    const list = await screen.windows()
    const target = list.find((window) => window.app.length > 0)
    expect(target !== undefined, 'no app window available to filter')
    const filtered = await screen.windows({ app: target.app })
    expect(filtered.every((window) => window.app.toLowerCase().includes(target.app.toLowerCase())), 'window list was not filtered by app')
    expect(filtered.length >= 1, `filtering by ${target.app} dropped the window it came from`)
    return `${filtered.length} window(s) for ${target.app}`
  })
  await test('native.appWindows() maps Accessibility failures to ACCESSIBILITY_PERMISSION', async () => {
    const target = appList?.[0]
    expect(target !== undefined, 'no running app available')
    try {
      const list = await native.appWindows({ app: target.name })
      expect(Array.isArray(list), 'appWindows must return an array')
      return `${list.length} AX window(s) for ${target.name} (Accessibility granted)`
    } catch (error) {
      if (!(error instanceof AutomationError) || error.code !== 'ACCESSIBILITY_PERMISSION') throw error
      report('Accessibility windows blocked by TCC', `${error.message} — expected in the sandbox; the installed Host process needs Accessibility permission.`)
      return undefined
    }
  })

  // ── Screenshots ────────────────────────────────────────────────────────────
  setSection('screenshots')
  await test('screenshot: main display (png)', async () => {
    const captured = await captureGuarded({}, context)
    if (!captured.ok) {
      report('screenshot main display blocked by TCC', captured.blocked.message)
      return undefined
    }
    const shot = captured.value
    expect(containedArtifact(shot.path), 'screenshot must be written under the test root')
    const bytes = await assertArtifactPath(shot.path)
    const header = pngSize(await readFile(shot.path))
    expect(header !== null, 'output is not a valid PNG')
    expectEqual(header.width, shot.width, 'reported width disagrees with the PNG header')
    expectEqual(header.height, shot.height, 'reported height disagrees with the PNG header')
    expectEqual(shot.target, 'main display', 'unexpected target label')
    expectEqual(bytes, shot.bytes, 'reported byte size disagrees with stat')
    return `${shot.width}x${shot.height}, ${bytes} bytes`
  })
  await test('screenshot: display 1 (retina-correct dimensions)', async () => {
    const captured = await captureGuarded({ display: 1 }, context)
    if (!captured.ok) {
      report('screenshot display 1 blocked by TCC', captured.blocked.message)
      return undefined
    }
    const shot = captured.value
    await assertArtifactPath(shot.path)
    const display = (await screen.displays()).find((entry) => entry.index === 1)
    expect(display !== undefined, 'display 1 is missing from the display list')
    expectEqual(shot.display, 1, 'expected display=1 in the result')
    expectEqual(shot.target, 'display 1', 'unexpected target label')
    const header = pngSize(await readFile(shot.path))
    expect(header !== null, 'output is not a valid PNG')
    const expectedWidth = Math.round(display.bounds.width * display.scale)
    const expectedHeight = Math.round(display.bounds.height * display.scale)
    expectEqual(header.width, expectedWidth, `width should be bounds*scale (${expectedWidth})`)
    expectEqual(header.height, expectedHeight, `height should be bounds*scale (${expectedHeight})`)
    return `${shot.width}x${shot.height} (${display.name ?? 'display 1'}, scale ${display.scale})`
  })
  await test('screenshot: region (png)', async () => {
    const region = { x: 120, y: 90, width: 320, height: 200 }
    const captured = await captureGuarded({ region }, context)
    if (!captured.ok) {
      report('screenshot region blocked by TCC', captured.blocked.message)
      return undefined
    }
    const shot = captured.value
    await assertArtifactPath(shot.path)
    const header = pngSize(await readFile(shot.path))
    expect(header !== null, 'output is not a valid PNG')
    expect(header.width === 320 || header.width === 640, `unexpected region width ${header.width}`)
    expectEqual(shot.width, header.width, 'reported region width mismatch')
    expect(shot.target.startsWith('region '), `unexpected target label ${shot.target}`)
    return `${header.width}x${header.height}`
  })
  await test('screenshot: jpg + cursor', async () => {
    const captured = await captureGuarded({ region: { x: 0, y: 0, width: 200, height: 150 }, format: 'jpg', cursor: true }, context)
    if (!captured.ok) {
      report('screenshot jpg blocked by TCC', captured.blocked.message)
      return undefined
    }
    const shot = captured.value
    await assertArtifactPath(shot.path)
    expect(shot.path.endsWith('.jpg'), 'jpg screenshot must end in .jpg')
    const header = jpegSize(await readFile(shot.path))
    expect(header !== null, 'output is not a valid JPEG')
    expectEqual(header.width, shot.width, 'reported JPEG width mismatch')
    return `${header.width}x${header.height}`
  })
  await test('screenshot: pdf', async () => {
    const captured = await captureGuarded({ format: 'pdf' }, context)
    if (!captured.ok) {
      report('screenshot pdf blocked by TCC', captured.blocked.message)
      return undefined
    }
    const shot = captured.value
    await assertArtifactPath(shot.path)
    const buffer = await readFile(shot.path)
    expect(buffer.subarray(0, 5).toString('latin1') === '%PDF-', 'pdf output is not a PDF')
    expect(Number.isFinite(shot.width) && Number.isFinite(shot.height), 'pdf dimensions missing')
    return `${shot.width}x${shot.height}, ${shot.bytes} bytes`
  })
  await test('screenshot: window by id', async () => {
    const candidate = (await screen.windows()).find((window) => window.windowId > 0)
    expect(candidate !== undefined, 'no capturable window available')
    const captured = await captureGuarded({ window: candidate.windowId }, context)
    if (!captured.ok) {
      if (captured.blocked.code === 'SCREEN_RECORDING_PERMISSION') {
        report('screenshot window blocked by TCC', captured.blocked.message)
        return undefined
      }
      throw captured.blocked
    }
    const shot = captured.value
    await assertArtifactPath(shot.path)
    expect(shot.target.startsWith(`window ${candidate.windowId}`), `unexpected target label ${shot.target}`)
    return shot.target
  })
  await test('screenshot: app-only selector resolves a single window', async () => {
    const candidate = (await screen.windows()).find((window) => window.app.length > 0)
    expect(candidate !== undefined, 'no app window available')
    try {
      const captured = await captureGuarded({ app: candidate.app }, context)
      if (!captured.ok) {
        report('screenshot app blocked by TCC', captured.blocked.message)
        return undefined
      }
      await assertArtifactPath(captured.value.path)
      return captured.value.target
    } catch (error) {
      if (error instanceof AutomationError && error.code === 'WINDOW_AMBIGUOUS') {
        report('screenshot app selector correctly reports ambiguity', `${candidate.app} has several windows; pass window title or id. ${error.hint.split('\n')[0]}`)
        return undefined
      }
      throw error
    }
  })
  await test('screenshot: argument validation', async () => {
    await expectAutomationError(() => screen.capture({ format: 'gif' }, context), ['BAD_ARGS'], 'bad format')
    await expectAutomationError(() => screen.capture({ region: { x: 0, y: 0, width: 0, height: 10 } }, context), ['BAD_ARGS'], 'zero-size region')
    await expectAutomationError(() => screen.capture({ region: { x: 0, y: 0, width: 10, height: 10 }, window: 1 }, context), ['BAD_ARGS'], 'region+window')
    await expectAutomationError(() => screen.capture({ display: 0 }, context), ['BAD_ARGS'], 'display 0')
    return 'all rejected with BAD_ARGS'
  })
  await test('screenshot: unknown window title fails with candidates/hint', async () => {
    const error = await expectAutomationError(
      () => screen.capture({ window: 'tOtAlLy-no-such-window-zzz' }, context),
      ['WINDOW_NOT_FOUND', 'WINDOW_TITLES_HIDDEN'],
      'unknown window title',
    )
    return error.code
  })

  // ── Screen recording ───────────────────────────────────────────────────────
  setSection('screen recording')
  await test('recording: screencapture -v start/stop (primary encoder)', async () => {
    delete process.env.DSH_AUTOMATION_RECORDING_ENCODER
    let started
    try {
      started = await screen.startRecording({ display: 1 }, context)
    } catch (error) {
      if (error instanceof AutomationError && error.code === 'SCREEN_RECORDING_PERMISSION') {
        report('screencapture recording blocked by TCC', error.message)
        return undefined
      }
      throw error
    }
    expect(started.encoder === 'screencapture' || started.encoder === 'ffmpeg', 'unexpected encoder')
    expect(typeof started.id === 'string' && started.id.length > 0, 'recording id missing')
    expect(containedArtifact(started.path), 'recording path must be under the test root')
    expect(typeof started.command === 'string' && started.command.includes('-v'), 'recording command missing')
    const status = screen.recordingStatus()
    expect(status.recordings.some((entry) => entry.id === started.id && entry.running), 'recording not reported as running')
    await new Promise((r) => setTimeout(r, 1_200))
    try {
      const stopped = await screen.stopRecording({ id: started.id })
      await assertArtifactPath(stopped.path)
      expect(stopped.bytes > 0, 'recording must have bytes')
      expect(stopped.durationMs > 0, 'recording must have a duration')
      expectEqual(stopped.encoder, started.encoder, 'encoder mismatch')
      expectEqual(screen.recordingStatus().recordings.length, 0, 'recording still tracked after stop')
      return `${started.encoder}, ${stopped.bytes} bytes, ${stopped.durationMs} ms${stopped.width ? `, ${stopped.width}x${stopped.height}` : ''}`
    } catch (error) {
      if (error instanceof AutomationError && error.code === 'RECORDING_FAILED' && /failed to save|produced no file/i.test(`${error.message} ${error.hint ?? ''}`)) {
        report('screencapture -v cannot finalize a movie in this sandboxed session', 'The ffmpeg encoder test below verifies the recording/stop/dispose pipeline end to end.')
        return undefined
      }
      throw error
    }
  })
  await test('recording: ffmpeg fallback encoder start/stop', async () => {
    delete process.env.DSH_AUTOMATION_RECORDING_ENCODER
    // Force the fallback path (the same code path taken when screencapture -v fails).
    process.env.DSH_AUTOMATION_RECORDING_ENCODER = 'ffmpeg'
    try {
      const started = await screen.startRecording({ display: 1 }, context)
      expectEqual(started.encoder, 'ffmpeg', 'expected the ffmpeg encoder')
      expect(started.command.includes('avfoundation'), 'ffmpeg command must use avfoundation')
      await new Promise((r) => setTimeout(r, 1_400))
      const stopped = await screen.stopRecording({ id: started.id })
      await assertArtifactPath(stopped.path)
      expect(stopped.bytes > 2_000, `recording looks too small: ${stopped.bytes} bytes`)
      expect(stopped.durationMs > 0, 'missing duration')
      expect(Number.isFinite(stopped.width) && Number.isFinite(stopped.height), 'missing video dimensions from ffprobe')
      return `${stopped.width}x${stopped.height}, ${stopped.bytes} bytes, ${stopped.durationMs} ms`
    } catch (error) {
      if (error instanceof AutomationError && error.code === 'SCREEN_RECORDING_PERMISSION') {
        report('ffmpeg screen recording blocked by TCC', error.message)
        return undefined
      }
      throw error
    } finally {
      delete process.env.DSH_AUTOMATION_RECORDING_ENCODER
    }
  })
  await test('recording: dispose stops an active encoder without orphans (idempotent)', async () => {
    process.env.DSH_AUTOMATION_RECORDING_ENCODER = 'ffmpeg'
    let started
    try {
      started = await screen.startRecording({ display: 1 }, context)
      await new Promise((r) => setTimeout(r, 1_000))
      expectEqual(screen.recordingStatus().recordings.length, 1, 'expected one tracked recording')
      const tracked = screen.debugRecordingProcesses()
      expectEqual(tracked.length, 1, 'expected one tracked encoder process')
      expect(tracked[0].pid > 0, 'encoder process pid must be known')
      await screen.dispose()
      await screen.dispose()
      expectEqual(screen.recordingStatus().recordings.length, 0, 'dispose left recordings tracked')
      expectEqual(screen.trackedRecordingCount(), 0, 'dispose left recordings tracked')
      const info = await stat(started.path)
      expect(info.size > 0, 'dispose must finalize the recording file')
      assert.throws(() => process.kill(tracked[0].pid, 0), `encoder pid ${tracked[0].pid} is still alive after dispose`)
      return `${info.size} bytes finalized, encoder pid ${tracked[0].pid} reaped`
    } catch (error) {
      if (error instanceof AutomationError && error.code === 'SCREEN_RECORDING_PERMISSION') {
        report('dispose recording test blocked by TCC', error.message)
        return undefined
      }
      throw error
    } finally {
      delete process.env.DSH_AUTOMATION_RECORDING_ENCODER
      await screen.dispose()
    }
  })
  await test('recording: stop with an unknown id reports available recordings', async () => {
    const error = await expectAutomationError(() => screen.stopRecording({ id: 'no-such-recording' }), ['UNKNOWN_RECORDING'], 'unknown recording id')
    return error.code
  })
  await test('recording: stop without an id reports nothing to stop', async () => {
    const error = await expectAutomationError(() => screen.stopRecording({}), ['UNKNOWN_RECORDING'], 'stop without id')
    return error.code
  })
  await test('recording: status starts empty and is stable', async () => {
    const status = screen.recordingStatus()
    expect(Array.isArray(status.recordings), 'recordings must be an array')
    expectEqual(status.recordings.length, 0, 'recordings should be empty outside recording tests')
  })

  // ── Input errors (never posts events) ──────────────────────────────────────
  setSection('mouse / keyboard error handling (no synthetic input posted)')
  await test('mouse: unknown action -> BAD_ARGS', async () => {
    await expectAutomationError(() => native.mouse({ action: 'fly' }), ['BAD_ARGS'], 'mouse action')
  })
  await test('mouse: missing coordinates -> BAD_ARGS', async () => {
    await expectAutomationError(() => native.mouse({ action: 'move', x: 'abc', y: 10 }), ['BAD_ARGS'], 'mouse coords')
    await expectAutomationError(() => native.mouse({ action: 'click' }), ['BAD_ARGS'], 'click coords')
  })
  await test('mouse: scroll requires a delta', async () => {
    await expectAutomationError(() => native.mouse({ action: 'scroll' }), ['BAD_ARGS'], 'scroll delta')
  })
  await test('keyboard: unknown action -> BAD_ARGS', async () => {
    await expectAutomationError(() => native.keyboard({ action: 'sneeze' }), ['BAD_ARGS'], 'keyboard action')
  })
  await test('keyboard: hotkey requires keys array', async () => {
    await expectAutomationError(() => native.keyboard({ action: 'hotkey', keys: [] }), ['BAD_ARGS'], 'empty hotkey')
  })
  await test('keyboard: hotkey rejects a non-key entry', async () => {
    await expectAutomationError(() => native.keyboard({ action: 'hotkey', keys: ['cmd', 'not-a-key-zzz'] }), ['UNSUPPORTED_KEY'], 'bad hotkey key')
  })
  await test('keyboard: hotkey validates modifiers from the separate modifiers field', async () => {
    await expectAutomationError(
      () => native.keyboard({ action: 'hotkey', keys: ['a'], modifiers: ['hyper'] }),
      ['BAD_ARGS'],
      'hotkey extra modifier',
    )
  })
  await test('keyboard: type requires text', async () => {
    await expectAutomationError(() => native.keyboard({ action: 'type', text: '' }), ['BAD_ARGS'], 'empty type text')
  })
  await test('keyboard: modifier validation', async () => {
    await expectAutomationError(() => native.keyboard({ action: 'key', key: 'a', modifiers: ['hyper'] }), ['BAD_ARGS'], 'bad modifier')
  })
  if (process.env.DSH_NATIVE_SELFTEST_INPUT === '1') {
    await test('input: mouse move is delivered (opt-in)', async () => {
      const start = (await native.screenInfo()).cursor
      const target = { x: start.x + 30, y: start.y + 20 }
      try {
        const moved = await native.mouse({ action: 'move', x: target.x, y: target.y })
        expectEqual(moved.ok, true, 'move did not report ok')
        return `cursor ${Math.round(start.x)},${Math.round(start.y)} -> ${Math.round(target.x)},${Math.round(target.y)}`
      } catch (error) {
        if (error instanceof AutomationError && ['INPUT_NOT_DELIVERED', 'ACCESSIBILITY_PERMISSION'].includes(error.code)) {
          report('synthetic input blocked by TCC', error.message)
          return undefined
        }
        throw error
      } finally {
        await native.mouse({ action: 'move', x: start.x, y: start.y }).catch(() => {})
      }
    })
  }

  // ── AppleScript fallback wiring (swiftc unavailable) ───────────────────────
  setSection('AppleScript fallback when the native helper is unavailable')
  await test('fallback: mouse move fails clearly without swiftc', async () => {
    process.env.DSH_AUTOMATION_DISABLE_NATIVE = '1'
    native.resetHelperCache()
    try {
      const error = await expectAutomationError(
        () => native.mouse({ action: 'move', x: 10, y: 10 }),
        ['NATIVE_HELPER_UNAVAILABLE'],
        'move fallback',
      )
      expect(/xcode-select/u.test(error.hint), 'hint should mention xcode-select --install')
      return error.code
    } finally {
      delete process.env.DSH_AUTOMATION_DISABLE_NATIVE
      native.resetHelperCache()
    }
  })
  await test('fallback: modifier click is rejected before any event is posted', async () => {
    process.env.DSH_AUTOMATION_DISABLE_NATIVE = '1'
    native.resetHelperCache()
    try {
      const error = await expectAutomationError(
        () => native.mouse({ action: 'click', x: 10, y: 10, modifiers: ['cmd'] }),
        ['FALLBACK_UNSUPPORTED'],
        'modifier click fallback',
      )
      return error.code
    } finally {
      delete process.env.DSH_AUTOMATION_DISABLE_NATIVE
      native.resetHelperCache()
    }
  })
  await test('fallback: keyboard key routes to AppleScript and validates modifiers first', async () => {
    process.env.DSH_AUTOMATION_DISABLE_NATIVE = '1'
    native.resetHelperCache()
    try {
      try {
        await native.keyboard({ action: 'key', key: 'a', modifiers: ['hyper'] })
        throw new Error('expected the modifier validation to fail before posting events')
      } catch (error) {
        expect(error instanceof AutomationError, 'expected an AutomationError')
        expectEqual(error.code, 'BAD_ARGS', 'unexpected fallback error code')
        expect(/AppleScript fallback/u.test(error.message), `expected fallback context in: ${error.message}`)
      }
      // The helper must work again once the override is removed.
      delete process.env.DSH_AUTOMATION_DISABLE_NATIVE
      native.resetHelperCache()
      const perms = await native.permissions()
      expectEqual(typeof perms.accessibility, 'boolean', 'helper did not recover after the override')
      return 'fallback path exercised'
    } finally {
      delete process.env.DSH_AUTOMATION_DISABLE_NATIVE
      native.resetHelperCache()
    }
  })

  // ── AppleScript / apps ─────────────────────────────────────────────────────
  setSection('AppleScript / app control')
  await test('appleScript: plain AppleScript expression', async () => {
    const result = await apps.appleScript({ script: 'return 1 + 1' })
    expectEqual(result.code, 0, 'osascript exited non-zero')
    expectEqual(result.stdout.trim(), '2', 'unexpected stdout')
    return result.stdout.trim()
  })
  await test('appleScript: JXA expression', async () => {
    const result = await apps.appleScript({ script: '1 + 2', language: 'jxa' })
    expectEqual(result.code, 0, 'osascript exited non-zero')
    expectEqual(result.stdout.trim(), '3', 'unexpected stdout')
    return result.stdout.trim()
  })
  await test('appleScript: Automation permission error mapping', async () => {
    try {
      const result = await apps.appleScript({ script: 'tell application "System Events" to get name of first process' })
      expectEqual(result.code, 0, 'expected success or AUTOMATION_PERMISSION')
      report('Automation permission is granted', `osascript returned ${JSON.stringify(result.stdout.trim())}`)
      return result.stdout.trim()
    } catch (error) {
      if (error instanceof AutomationError && error.code === 'AUTOMATION_PERMISSION') {
        report('Automation permission blocked by TCC', error.message)
        return undefined
      }
      throw error
    }
  })
  await test('appleScript: argument validation', async () => {
    await expectAutomationError(() => apps.appleScript({ script: '' }), ['BAD_ARGS'], 'empty script')
    await expectAutomationError(() => apps.appleScript({ script: '1', language: 'cobol' }), ['BAD_ARGS'], 'bad language')
  })
  await test('apps.activate() activates the frontmost app (no-op)', async () => {
    const info = await native.screenInfo()
    const name = info.frontmostApp.name
    expect(name.length > 0, 'no frontmost app reported')
    const result = await apps.activate({ app: name })
    expectEqual(typeof result.ok, 'boolean', 'activate result must include ok')
    expect(result.app?.pid > 0, 'activate result must include app info')
    return `${name} (ok=${result.ok})`
  })
  await test('apps: argument validation', async () => {
    await expectAutomationError(() => apps.open({}), ['BAD_ARGS'], 'open without target')
    await expectAutomationError(() => apps.activate({}), ['BAD_ARGS'], 'activate without app')
    await expectAutomationError(() => apps.quit({}), ['BAD_ARGS'], 'quit without app')
    await expectAutomationError(() => apps.windows({}), ['BAD_ARGS'], 'windows without app')
  })
  await test('apps: app-only launch rejects an unknown app cleanly', async () => {
    const error = await expectAutomationError(
      () => apps.open({ app: 'DefinitelyNotAnAppZZZ' }),
      ['APP_OPEN_FAILED'],
      'open unknown app',
    )
    return error.code
  })
  await test('apps: open rejects a nonexistent target cleanly', async () => {
    const error = await expectAutomationError(
      () => apps.open({ target: '/definitely/not/a/real/path/zzz-dsh-test' }),
      ['APP_OPEN_FAILED'],
      'open bad path',
    )
    return error.code
  })

  // ── Summary ────────────────────────────────────────────────────────────────
  await screen.dispose()
  printSummary()
  process.exitCode = results.fail === 0 ? 0 : 1
}

function printSummary() {
  console.log('\n──────── summary ────────')
  console.log(`PASS ${results.pass}  FAIL ${results.fail}  REPORT ${results.report}`)
  if (results.reports.length > 0) {
    console.log('reports (environment/TCC limitations, not failures):')
    for (const entry of results.reports) console.log(`  - ${entry}`)
  }
  if (results.failures.length > 0) {
    console.log('failures:')
    for (const entry of results.failures) console.log(`  - ${entry}`)
  }
  console.log(results.fail === 0 ? 'RESULT: OK (exit 0)' : 'RESULT: FAILURES (exit 1)')
}

main().catch((error) => {
  console.error('\nself-test crashed:', error)
  printSummary()
  process.exitCode = 1
}).finally(async () => {
  await screen.dispose().catch(() => {})
})
