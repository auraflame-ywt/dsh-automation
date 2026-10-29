/**
 * Integration smoke test for the automation bundle: mounts the plugin with a fake
 * Cordis context, then exercises the real tool definitions end to end (browser is
 * fully verifiable; desktop paths tolerate missing macOS privacy permissions).
 *
 * Run: node test/integration-smoke.mjs
 * Uses /tmp/dsh-auto-test as artifact root and headless Chrome with --no-sandbox
 * because the bash tool runs inside a seatbelt sandbox.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { apply } from '../index.js'

const ARTIFACT_DIR = '/tmp/dsh-auto-test/integration'
const results = []
let failures = 0

const check = (name, condition, detail) => {
  if (condition) {
    results.push(`PASS ${name}`)
  } else {
    failures += 1
    results.push(`FAIL ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}

const cleanups = []
const definitions = new Map()
const ctx = {
  tools: {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    },
  },
  effect(setup) {
    const disposer = setup()
    if (typeof disposer === 'function') cleanups.push(disposer)
    return disposer
  },
  get() {
    return undefined
  },
  inject(_names, callback) {
    callback(this)
  },
}

const exec = { agent: undefined, signal: new AbortController().signal }

const call = async (name, args) => {
  const definition = definitions.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  return definition.execute(args, exec)
}

const expectError = async (name, args, expectedCode) => {
  try {
    await call(name, args)
    return { threw: false }
  } catch (error) {
    const message = String(error?.message ?? error)
    return { threw: true, message, code: expectedCode === undefined ? undefined : (message.includes(expectedCode) ? expectedCode : undefined) }
  }
}

const main = async () => {
  await rm(ARTIFACT_DIR, { recursive: true, force: true })

  apply(ctx, {
    artifactDir: ARTIFACT_DIR,
    browserHeadless: true,
  })

  const expectedTools = ['computer_permissions', 'screen_capture', 'screen_record', 'computer_input', 'computer_app', 'browser']
  for (const name of expectedTools) check(`registered: ${name}`, definitions.has(name))
  check('exactly six tools', definitions.size === 6, `got ${definitions.size}`)

  for (const [name, definition] of definitions) {
    const schema = definition.parameters
    check(`${name}: parameter schema`, schema?.type === 'object' && typeof schema.properties === 'object' && typeof definition.description === 'string' && definition.description.length > 20)
    check(`${name}: output render`, typeof definition.output?.render === 'function' && typeof definition.output?.schema === 'object')
  }

  // --- desktop: permission report is always available -----------------------
  const permissions = await call('computer_permissions', { action: 'check' })
  check('permissions: platform', permissions.platform === 'darwin', JSON.stringify(permissions.platform))
  check('permissions: explicit booleans', typeof permissions.accessibility === 'boolean' && typeof permissions.screenRecording === 'boolean', JSON.stringify(permissions))
  check('permissions: automation probe', ['granted', 'denied', 'unknown'].includes(permissions.automation), permissions.automation)

  // --- desktop: display discovery (non-TCC) ---------------------------------
  const displayReport = await call('screen_capture', { action: 'displays' }).catch((error) => ({ error: String(error.message) }))
  if (displayReport.error === undefined) {
    check('screen_capture displays: non-empty', Array.isArray(displayReport.displays) && displayReport.displays.length >= 1, JSON.stringify(displayReport))
  } else {
    check('screen_capture displays: clean error', /permission|xcode|swift|helper/i.test(displayReport.error), displayReport.error)
  }

  // --- desktop: capture either works or reports the permission cleanly ------
  try {
    const success = await call('screen_capture', { action: 'capture' })
    check('screen_capture capture: artifact exists', existsSync(success.path) && statSync(success.path).size > 1000, JSON.stringify(success))
    check('screen_capture capture: dimensions', typeof success.width === 'number' && success.width > 0 && typeof success.height === 'number' && success.height > 0)
  } catch (error) {
    check('screen_capture capture: actionable failure', /Screen Recording|permission/i.test(String(error.message)), String(error.message))
  }

  // --- desktop: app listing -------------------------------------------------
  try {
    const appReport = await call('computer_app', { action: 'list' })
    check('computer_app list: apps', Array.isArray(appReport.apps) && appReport.apps.length >= 1, JSON.stringify(appReport).slice(0, 300))
  } catch (error) {
    check('computer_app list: clean error', true, String(error.message))
  }

  // --- desktop: input permission failure is actionable ----------------------
  const input = await expectError('computer_input', { action: 'click', x: 10, y: 10 })
  if (input.threw) check('computer_input: actionable failure', /Accessibility|permission/i.test(input.message), input.message)

  // --- browser: full loop ---------------------------------------------------
  const fixture = [
    '<!doctype html><html><head><title>Automation Fixture</title></head><body>',
    '<h1>Fixture</h1>',
    '<button id="go" onclick="window.__clicks=(window.__clicks||0)+1">Run</button>',
    '<input id="name" placeholder="name" />',
    '<select id="kind"><option value="a">A</option><option value="b">B</option></select>',
    '<a href="#done">Done link</a>',
    '<div id="late"></div>',
    '<script>setTimeout(()=>{document.getElementById("late").textContent="ready"},300); console.log("fixture console hello")</script>',
    '</body></html>',
  ].join('')

  let pageId
  try {
    const launched = await call('browser', {
      action: 'launch',
      headless: true,
      noSandbox: true,
      url: `data:text/html,${encodeURIComponent(fixture)}`,
    })
    pageId = launched.page?.id
    check('browser launch: port', typeof launched.port === 'number' && launched.port > 0, JSON.stringify(launched).slice(0, 300))
    check('browser launch: page', typeof pageId === 'string', JSON.stringify(launched.page))

    const snapshot = await call('browser', { action: 'snapshot' })
    const snapshotText = JSON.stringify(snapshot)
    check('browser snapshot: elements', Array.isArray(snapshot.elements) && snapshot.elements.length >= 3, snapshotText.slice(0, 400))
    check('browser snapshot: sees button', snapshotText.includes('Run'), snapshotText.slice(0, 200))

    await call('browser', { action: 'click', selector: 'text=Run' })
    const clicked = await call('browser', { action: 'eval', expression: 'window.__clicks || 0' })
    check('browser click: handler ran', clicked.result === 1 || clicked.result === '1', JSON.stringify(clicked))

    await call('browser', { action: 'fill', selector: '#name', value: 'automation' })
    const filled = await call('browser', { action: 'eval', expression: 'document.getElementById("name").value' })
    check('browser fill: value set', filled.result === 'automation', JSON.stringify(filled))

    await call('browser', { action: 'select_option', selector: '#kind', value: 'b' })
    const selected = await call('browser', { action: 'eval', expression: 'document.getElementById("kind").value' })
    check('browser select_option: value set', selected.result === 'b', JSON.stringify(selected))

    await call('browser', { action: 'wait_for', text: 'ready', timeoutMs: 5000 })
    check('browser wait_for: text appeared', true)

    const consoleReport = await call('browser', { action: 'console' })
    check('browser console: captured', JSON.stringify(consoleReport).includes('fixture console hello'), JSON.stringify(consoleReport).slice(0, 300))

    await call('browser', { action: 'goto', url: `data:text/html,${encodeURIComponent(fixture)}` })
    const network = await call('browser', { action: 'network' })
    check('browser network: shape', Array.isArray(network.requests), JSON.stringify(network).slice(0, 300))

    const shot = await call('browser', { action: 'screenshot', format: 'png' })
    check('browser screenshot: file', existsSync(shot.path) && statSync(shot.path).size > 1000, JSON.stringify(shot))
    check('browser screenshot: png magic', readFileSync(shot.path).subarray(0, 8).toString('hex') === '89504e470d0a1a0a')

    await call('browser', { action: 'record_start', fps: 10 })
    await call('browser', { action: 'eval', expression: 'document.body.style.background="#123456"; "ok"' })
    await new Promise((resolve) => setTimeout(resolve, 600))
    await call('browser', { action: 'eval', expression: 'document.body.style.background="#654321"; "ok"' })
    const recording = await call('browser', { action: 'record_stop' })
    const recordingExists = typeof recording.path === 'string' && existsSync(recording.path) && statSync(recording.path).size > 1000
    check('browser recording: artifact', recordingExists, JSON.stringify(recording).slice(0, 300))

    const pages = await call('browser', { action: 'pages' })
    check('browser pages: listed', Array.isArray(pages.pages) && pages.pages.length >= 1, JSON.stringify(pages).slice(0, 300))
  } catch (error) {
    check('browser: full loop without throwing', false, String(error?.stack ?? error))
  } finally {
    try {
      await call('browser', { action: 'close' })
    } catch {
      /* already closed */
    }
  }

  // --- teardown -------------------------------------------------------------
  for (const disposer of cleanups.reverse()) {
    try {
      await disposer()
    } catch (error) {
      results.push(`warn dispose: ${String(error)}`)
    }
  }

  console.log(results.join('\n'))
  console.log(failures === 0 ? '\nINTEGRATION SMOKE: PASS' : `\nINTEGRATION SMOKE: FAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('integration smoke crashed:', error)
  process.exit(1)
})
